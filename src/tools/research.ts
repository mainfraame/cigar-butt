import type { McpServer } from '@modelcontextprotocol/server';

import { sortBy } from 'lodash-es';
import * as z from 'zod/v4';

import {
  insiderFilingActivity,
  scanDisqualifiers
} from '../analysis/disqualifiers.ts';
import {
  type DatedValue,
  computeMetrics,
  fetchBalanceSheet,
  isFinancial,
  judge,
  lastFiled
} from '../analysis/metrics.ts';
import { quotes } from '../data/prices.ts';
import { resolveTicker, submissions } from '../data/sec.ts';
import { dec, out } from '../math/decimal.ts';
import {
  attempt,
  cell,
  DISCLAIMER,
  requireSetup,
  text,
  usd
} from './shared.ts';

const tickerArg = z
  .string()
  .min(1)
  .max(10)
  .describe('US-listed ticker symbol, e.g. "AAPL". Case-insensitive.');

export function registerResearchTools(server: McpServer): void {
  server.registerTool(
    'check_disqualifiers',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        "Scan a company's SEC filing index for the events that void a deep-value " +
        'thesis: 8-K item 4.02 (non-reliance on prior financials), 4.01 (auditor ' +
        'change), 1.03 (bankruptcy), 3.01 (listing deficiency), 2.06 (impairment), ' +
        'Form 25/25-NSE (delisting), NT 10-Q/NT 10-K (late filing), and filing gaps. ' +
        'Costs one request. Run this BEFORE any valuation work — a name that fails ' +
        'here is dead regardless of how cheap it looks, and no ratio would catch it.',
      inputSchema: z.object({
        lookbackDays: z
          .number()
          .int()
          .min(30)
          .max(3650)
          .default(730)
          .describe(
            'How far back to scan. Restatements from a decade ago are history.'
          ),
        ticker: tickerArg
      }),
      title: 'Scan filing index for disqualifiers'
    },
    ({ lookbackDays, ticker }) =>
      attempt(async () => {
        const blocked = requireSetup();
        if (blocked) return blocked;

        const entry = await resolveTicker(ticker);
        const summary = await submissions(String(entry.cik_str));
        const report = scanDisqualifiers(summary, { lookbackDays });
        const insiders = insiderFilingActivity(summary);

        const rows = report.flags
          .map(
            flag =>
              `| ${flag.severity} | ${flag.form} | ${flag.date} | ${flag.reason} | \`${flag.source}\` |`
          )
          .join('\n');

        return text(
          `## ${summary.name} (${entry.ticker}) — disqualifier scan\n\n` +
            `CIK ${summary.cik} · SIC ${cell(summary.sic)} ${summary.sicDescription ?? ''} · ` +
            `Exchanges: ${summary.exchanges.join(', ') || '—'}\n\n` +
            `**${report.summary}**\n\n` +
            (report.flags.length > 0
              ? `| Severity | Form | Filed | Finding | Accession |\n|---|---|---|---|---|\n${rows}\n\n`
              : '') +
            `Last periodic report: ${report.lastPeriodicFiling?.form ?? '—'} filed ` +
            `${report.lastPeriodicFiling?.date ?? '—'} (${cell(report.daysSinceLastPeriodic)} days ago).\n\n` +
            `Form 4 filings in the last 180 days: ${insiders.count} (${insiders.lateFilings} amendments). ` +
            `${insiders.note}` +
            DISCLAIMER
        );
      })
  );

  server.registerTool(
    'analyze_ticker',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'Full deep-value workup for one name: the disqualifier scan first, then ' +
        'tangible book, NCAV, NNWC and net cash computed from SEC XBRL line items, ' +
        'then a current price, then the Schloss and Graham verdicts. Every figure ' +
        'carries the filing it came from and the date it was filed. Returns the ' +
        'disqualifier findings and stops before valuation if the name is disqualified.',
      inputSchema: z.object({
        skipDisqualifiers: z
          .boolean()
          .default(false)
          .describe(
            'Compute valuations even when a hard disqualifier is present. Off by ' +
              'default, because the balance sheet a disqualified name reports is the ' +
              'thing in doubt.'
          ),
        ticker: tickerArg
      }),
      title: 'Analyze one ticker'
    },
    ({ skipDisqualifiers, ticker }) =>
      attempt(async () => {
        const blocked = requireSetup();
        if (blocked) return blocked;

        const entry = await resolveTicker(ticker);
        const cik = String(entry.cik_str);
        const summary = await submissions(cik);
        const disqualifiers = scanDisqualifiers(summary);

        if (!disqualifiers.clear && !skipDisqualifiers) {
          return text(
            `## ${summary.name} (${entry.ticker}) — DISQUALIFIED\n\n` +
              `${disqualifiers.summary}\n\n` +
              disqualifiers.flags
                .filter(flag => flag.severity === 'disqualify')
                .map(
                  flag => `- **${flag.form}** (${flag.date}): ${flag.reason}`
                )
                .join('\n') +
              '\n\nNo valuation was computed. The thesis rests on the reported balance ' +
              'sheet being true, and these filings say it is not. Pass ' +
              '`skipDisqualifiers: true` only if you have read the filings and ' +
              'concluded otherwise.' +
              DISCLAIMER
          );
        }

        const { periodEnd, sheet, stale } = await fetchBalanceSheet(cik);
        const metrics = computeMetrics(sheet);
        const financial = isFinancial(summary.sic);

        const { failed, quotes: found } = await quotes([entry.ticker]);
        const price = found[0];

        const priceDecimal = price ? dec(price.price) : undefined;
        const verdict = priceDecimal
          ? judge(metrics, priceDecimal, { financial })
          : undefined;

        const checkRows =
          verdict?.checks
            .map(
              check =>
                `| ${check.name} | ${check.pass === undefined ? 'n/a' : check.pass ? 'pass' : 'FAIL'} | ${check.detail} |`
            )
            .join('\n') ?? '';

        const provenance = sortBy(
          Object.entries(sheet).filter(
            (pair): pair is [string, DatedValue] => pair[1] !== undefined
          ),
          ([key]) => key
        )
          .map(
            ([key, item]) =>
              `| ${key}${item.stale ? ' *(stale)*' : ''} | ${
                key === 'sharesOutstanding'
                  ? (out(item.value, 0) ?? 0).toLocaleString('en-US')
                  : usd(out(item.value, 0))
              } | ${item.asOf} | ${item.form} | ${item.filed} | \`${item.accn}\` |`
          )
          .join('\n');

        return text(
          `## ${summary.name} (${entry.ticker})\n\n` +
            `CIK ${summary.cik} · SIC ${cell(summary.sic)} ${summary.sicDescription ?? ''}` +
            `${financial ? ' · **Financial issuer**' : ''}\n\n` +
            `### Disqualifier scan\n\n${disqualifiers.summary}\n\n` +
            (disqualifiers.flags.length > 0
              ? `${disqualifiers.flags
                  .map(
                    f =>
                      `- ${f.severity}: **${f.form}** (${f.date}) — ${f.reason}`
                  )
                  .join('\n')}\n\n`
              : '') +
            '### Asset tests\n\n' +
            `Balance sheet as of ${cell(periodEnd)}; last filing ${cell(lastFiled(sheet))}.\n\n` +
            '| Metric | Value |\n|---|---|\n' +
            `| Tangible book | ${usd(out(metrics.tangibleBook, 0))} |\n` +
            `| Tangible book / share | ${usd(out(metrics.tangibleBookPerShare, 2))} |\n` +
            `| NCAV | ${usd(out(metrics.ncav, 0))} |\n` +
            `| NCAV / share | ${usd(out(metrics.ncavPerShare, 2))} |\n` +
            `| NNWC | ${usd(out(metrics.nnwc, 0))} |\n` +
            `| Net cash | ${financial ? 'n/a — financial issuer' : usd(out(metrics.netCash, 0))} |\n` +
            `| Current ratio | ${cell(out(metrics.currentRatio, 2))} |\n` +
            `| Debt / equity | ${cell(out(metrics.debtToEquity, 3))} |\n` +
            `| P/TBV | ${cell(out(verdict?.priceToTangibleBook, 3))} |\n` +
            `| Price / NCAV | ${cell(out(verdict?.priceToNcav, 3))} |\n\n` +
            (price
              ? `Price ${usd(price.price)} as of **${price.asOf}** (${price.source}).\n\n`
              : `**No price retrieved.** ${failed[0]?.reason ?? ''}\n\n`) +
            (stale.length > 0
              ? `**Stale line items, excluded from the maths.** The filer stopped ` +
                `tagging these, so their most recent value predates this balance ` +
                `sheet: ${stale
                  .map(item => `${item.key} (last tagged ${item.asOf})`)
                  .join(
                    ', '
                  )}. Any test above that needed one reads n/a rather ` +
                `than silently mixing periods.\n\n`
              : '') +
            (metrics.missing.length > 0
              ? `Line items unavailable for this period, each weakening a test above: ${metrics.missing.join(', ')}.\n\n`
              : '') +
            (verdict
              ? `### Verdict\n\n| Check | Result | Note |\n|---|---|---|\n${checkRows}\n\n` +
                `Schloss criteria: **${verdict.passesSchloss ? 'pass' : 'fail'}**. ` +
                `Graham net-net: **${verdict.passesGraham ? 'pass' : 'fail'}**.\n\n` +
                'A check reading `n/a` could not be computed — that is a gap in the ' +
                'evidence, not a passed or failed test.\n\n'
              : '') +
            (financial
              ? '**Financial issuer caveat.** Enterprise value and net cash are ' +
                'meaningless here: deposits and the securities book are not spare ' +
                'cash. Use tangible common equity. Schloss owned banks despite the ' +
                'debt rule, so the debt/equity failure below is expected rather than ' +
                "disqualifying — but that is your call to make, not the tool's.\n\n"
              : '') +
            `### Provenance\n\n| Line item | Value | Period end | Form | Filed | Accession |\n|---|---|---|---|---|---|\n${provenance}` +
            DISCLAIMER
        );
      })
  );

  server.registerTool(
    'get_quotes',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'Current prices for a list of tickers, each with the date it is as of and ' +
        'the provider it came from. Providers are tried in order (Tiingo, Polygon, ' +
        'Alpha Vantage) and every failure is reported, so "no key", "bad ticker" and ' +
        '"rate limited" stay distinguishable.',
      inputSchema: z.object({
        tickers: z.array(tickerArg).min(1).max(100)
      }),
      title: 'Get current prices'
    },
    ({ tickers }) =>
      attempt(async () => {
        const blocked = requireSetup();
        if (blocked) return blocked;

        const { failed, quotes: found } = await quotes(tickers);

        const rows = sortBy(found, quote => quote.ticker)
          .map(
            quote =>
              `| ${quote.ticker} | ${usd(quote.price)} | ${quote.asOf} | ${quote.source} |`
          )
          .join('\n');

        return text(
          `## Quotes\n\n| Ticker | Price | As of | Source |\n|---|---|---|---|\n${rows}\n\n` +
            (failed.length > 0
              ? `### Not retrieved\n\n${failed
                  .map(entry => `- **${entry.ticker}**: ${entry.reason}`)
                  .join('\n')}\n\n`
              : '') +
            'Never compute a return from two prices unless both dates are confirmed. ' +
            'The same ticker has come back 60% apart from caches minutes apart.' +
            DISCLAIMER
        );
      })
  );
}
