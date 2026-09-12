import type { McpServer } from '@modelcontextprotocol/server';

import * as z from 'zod/v4';

import {
  DOC_TYPE_ANNUAL,
  DOC_TYPE_QUARTERLY,
  DOC_TYPE_SEMIANNUAL,
  financials,
  findFilings,
  toSecCode
} from '../data/edinet.ts';
import { fxRate } from '../data/fx.ts';
import { div, out, type Decimal } from '../math/decimal.ts';
import { attempt, cell, DISCLAIMER, text } from './shared.ts';

/**
 * Japanese filings, via EDINET.
 *
 * The same asset tests as the US path, computed from the same kind of primary
 * source — the filing itself, not a vendor's normalisation of it. Kept in its
 * own module because the differences are real: figures are in yen, the element
 * taxonomy is J-GAAP rather than us-gaap, and EDINET is indexed by date with no
 * way to search for a company.
 */

const JPY_HUNDRED_MILLION = 100_000_000;

/** Yen figures run large; 億円 (hundred-million yen) is how they are read locally. */
function oku(value: Decimal | undefined): string {
  if (!value) return '—';
  const inOku = value.div(JPY_HUNDRED_MILLION);
  return `¥${(out(inOku, 1) ?? 0).toLocaleString('en-US')}億`;
}

export function registerJapanTools(server: McpServer): void {
  server.registerTool(
    'edinet_search',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'Find recent Japanese regulatory filings by company name, TSE ticker or ' +
        'EDINET code, from the FSA’s EDINET system — Japan’s equivalent of ' +
        'SEC EDGAR. Returns document ids to pass to `edinet_financials`.\n\n' +
        'EDINET has no search-by-company endpoint; it is indexed by date, so ' +
        'this walks back one day at a time and each day is a request. Annual ' +
        'reports cluster in **late June**, because most Japanese companies close ' +
        'their books on 31 March and file within three months — so searching ' +
        'ten days in November will usually find nothing even for a company that ' +
        'files reliably. Set `startDate` to late June to look for an annual report.',
      inputSchema: z.object({
        annualOnly: z
          .boolean()
          .default(false)
          .describe(
            'Restrict to periodic reports (annual, semiannual, quarterly). These ' +
              'carry the accounts; most other filings do not.'
          ),
        maxDays: z
          .number()
          .int()
          .min(1)
          .max(40)
          .default(10)
          .describe(
            'Days to scan back. Each is one request; day lists are cached.'
          ),
        query: z
          .string()
          .min(2)
          .describe(
            'TSE ticker (e.g. "7203"), EDINET code (e.g. "E02144"), or part of ' +
              'the filer name in Japanese or English.'
          ),
        startDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO date, e.g. 2026-06-30')
          .optional()
          .describe('Scan backwards from this date. Defaults to today.')
      }),
      title: 'Search Japanese filings (EDINET)'
    },
    ({ annualOnly, maxDays, query, startDate }) =>
      attempt(async () => {
        const { daysScanned, filings } = await findFilings({
          docTypeCodes: annualOnly
            ? [DOC_TYPE_ANNUAL, DOC_TYPE_SEMIANNUAL, DOC_TYPE_QUARTERLY]
            : undefined,
          maxDays,
          query,
          startDate
        });

        if (filings.length === 0) {
          return text(
            `No EDINET filings matching "${query}" in the ${daysScanned} day(s) ` +
              `scanned back from ${startDate ?? 'today'}.\n\n` +
              'This is usually a date-window problem rather than a missing ' +
              'company. Japanese annual reports are filed in **late June** for a ' +
              '31 March year end — try `startDate: "<year>-06-30"` with ' +
              '`maxDays: 20`. If the ticker was the query, note EDINET uses a ' +
              `five-digit securities code: "${query}" resolves to ` +
              `"${toSecCode(query)}".` +
              DISCLAIMER
          );
        }

        const rows = filings
          .map(
            filing =>
              `| ${filing.submittedDate} | ${filing.filerName} | ` +
              `${cell(filing.secCode)} | ${filing.docTypeCode} | ` +
              `${filing.docDescription.slice(0, 50)} | \`${filing.docId}\` |`
          )
          .join('\n');

        return text(
          `## EDINET filings — "${query}"\n\n` +
            `${filings.length} filing(s) across ${daysScanned} day(s).\n\n` +
            '| Filed | Filer | Sec code | Type | Description | Document ID |\n' +
            `|---|---|---|---|---|---|\n${rows}\n\n` +
            'Type **120** is the 有価証券報告書 (annual securities report), which ' +
            'carries the full accounts. Pass a document ID to `edinet_financials`.' +
            DISCLAIMER
        );
      })
  );

  server.registerTool(
    'edinet_financials',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'Balance-sheet line items and the Graham asset tests for a Japanese ' +
        'filer, read from its EDINET XBRL filing. Figures are in yen and ' +
        'converted to a currency of your choice at a dated ECB reference rate.\n\n' +
        'This is the point of the Japanese path: net-nets have been far scarcer ' +
        'in the US than in Japan for a decade, and a Graham screen that cannot ' +
        'read these filings is looking in the wrong market. Get a document ID ' +
        'from `edinet_search` first.',
      inputSchema: z.object({
        convertTo: z
          .string()
          .length(3)
          .optional()
          .describe(
            'ISO currency to also report in, e.g. "USD". Uses a dated ECB rate.'
          ),
        docId: z
          .string()
          .min(4)
          .max(32)
          .describe('EDINET document ID from `edinet_search`, e.g. "S100XXXX".')
      }),
      title: 'Japanese balance sheet (EDINET)'
    },
    ({ convertTo, docId }) =>
      attempt(async () => {
        const report = await financials(docId);
        const item = (name: string): Decimal | undefined =>
          report.items[name]?.value;

        const equity = item('stockholdersEquity');
        const goodwill = item('goodwill');
        const intangibles = item('intangibles');
        const currentAssets = item('assetsCurrent');
        const currentLiabilities = item('liabilitiesCurrent');
        const liabilities = item('liabilities');
        const cash = item('cash');

        // Intangibles under J-GAAP normally include goodwill, unlike us-gaap
        // where IntangibleAssetsNetExcludingGoodwill is explicitly exclusive.
        // Subtracting both would double-count, so intangibles alone is used
        // when present and goodwill only as a fallback.
        const softAssets = intangibles ?? goodwill;
        const tangibleBook =
          equity && softAssets ? equity.minus(softAssets) : equity;
        const ncav =
          currentAssets && liabilities
            ? currentAssets.minus(liabilities)
            : undefined;
        const currentRatio = currentLiabilities?.gt(0)
          ? div(currentAssets, currentLiabilities)
          : undefined;

        const rate = convertTo
          ? await fxRate('JPY', convertTo).catch(() => undefined)
          : undefined;
        const converted = (value: Decimal | undefined): string =>
          rate && value
            ? ` (${(out(value.times(rate.rate), 0) ?? 0).toLocaleString('en-US')} ${rate.quote})`
            : '';

        const provenance = Object.entries(report.items)
          .map(
            ([concept, line]) =>
              `| ${concept} | ${line.label} | \`${line.element}\` | ${oku(line.value)} |`
          )
          .join('\n');

        return text(
          `## EDINET ${docId} — balance sheet\n\n` +
            'All figures in yen, shown in 億円 (hundred-million yen), which is ' +
            'how Japanese accounts are read.\n\n' +
            '| Metric | Value |\n|---|---|\n' +
            `| Shareholders' equity | ${oku(equity)}${converted(equity)} |\n` +
            `| Tangible book | ${oku(tangibleBook)}${converted(tangibleBook)} |\n` +
            `| NCAV | ${oku(ncav)}${converted(ncav)} |\n` +
            `| Cash and deposits | ${oku(cash)}${converted(cash)} |\n` +
            `| Current ratio | ${cell(out(currentRatio, 2))} |\n\n` +
            (rate
              ? `Converted at 1 JPY = ${out(rate.rate, 6)} ${rate.quote}, ECB ` +
                `reference rate for ${rate.asOf}.\n\n`
              : '') +
            (report.missing.length > 0
              ? `**Line items not found in this filing:** ${report.missing.join(', ')}. ` +
                'Any test above that needed one is absent rather than estimated. ' +
                'J-GAAP filers tag inconsistently and IFRS adopters use a ' +
                'different taxonomy again, so a gap here is usually a tagging ' +
                'difference rather than a missing disclosure.\n\n'
              : '') +
            `### Provenance\n\n| Concept | Label (as filed) | Element | Value |\n|---|---|---|---|\n${provenance}\n\n` +
            '**No share count and no price.** EDINET does not carry a market ' +
            'quote, and this server has no Japanese share-count source, so P/TBV ' +
            'and price-to-NCAV cannot be computed here. Get a price with ' +
            '`get_quotes` using an exchange-suffixed ticker (EOD Historical Data ' +
            'covers Tokyo as `7203.TSE`) and divide by a share count read from ' +
            'the filing itself.' +
            DISCLAIMER
        );
      })
  );
}
