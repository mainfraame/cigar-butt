import type { McpServer } from '@modelcontextprotocol/server';

import { groupBy, sortBy } from 'lodash-es';
import * as z from 'zod/v4';

import {
  indexState,
  isStale,
  refreshIndex,
  searchTrades,
  topTickers,
  type IndexedTrade
} from '../data/congress-index.ts';
import {
  committeesByMember,
  findSenateAnnualReport,
  houseFilings,
  normaliseName,
  senateAnnualReport,
  type Committee
} from '../data/congress.ts';
import { attempt, cell, DISCLAIMER, text } from './shared.ts';

/**
 * Congressional disclosure tools.
 *
 * These sit outside the Graham/Schloss method rather than inside it, and the
 * output says so. A disclosure is a banded amount reported weeks late, so it
 * can never be a figure the screen acts on. What it can do is answer "why is
 * this cheap?" or "who else is looking at this?" — and, cross-referenced
 * against committee assignments, flag the pattern that actually carries
 * information: a member trading in the industry their committee supervises.
 */

const LAG_CAVEAT =
  'The STOCK Act allows 30 days from awareness and 45 from the transaction, ' +
  'and amounts are disclosed in bands, not exact figures. So the date you read ' +
  'this is weeks after the trade, and the price the member paid is unknown. ' +
  'Treat it as a lead to research, never as a price you could have got.';

const DAY_MS = 86_400_000;
const TWENTY_FOUR_HOURS = 24 * 60 * 60;

function daysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
}

/** Committee seats for a member, or an empty list when the name does not match. */
function committeesFor(
  rosters: Map<string, Committee[]>,
  member: string
): Committee[] {
  return rosters.get(normaliseName(member)) ?? [];
}

export function registerCongressTools(server: McpServer): void {
  server.registerTool(
    'congress_trades',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'Search disclosed Senate stock transactions **by ticker**, by member, or ' +
        'both. No credential needed. This is the natural entry point: ask "who ' +
        'in the Senate traded ASTE?" and get every disclosed transaction in the ' +
        'index, with the committees each member sits on.\n\n' +
        'eFD itself cannot be searched by ticker — its form takes a filer name, ' +
        'a state and a filing-date window and nothing else — so transactions are ' +
        'held in a local index. It refreshes itself when stale, and reports are ' +
        'immutable once filed, so keeping current costs only the new filings. ' +
        'Use `congress_index` to see how deep the index reaches and to backfill ' +
        'further; a search can only find what has been indexed.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(50),
        member: z
          .string()
          .max(60)
          .optional()
          .describe('Filter by senator name; matched as a substring.'),
        sinceDays: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .default(365)
          .describe('Only transactions this recent, by transaction date.'),
        ticker: z
          .string()
          .max(10)
          .optional()
          .describe(
            'Ticker to search for, e.g. "NVDA". Bonds, funds and private ' +
              'holdings often have no ticker and will not match.'
          )
      }),
      title: 'Search congressional trades by ticker'
    },
    ({ limit, member, sinceDays, ticker }) =>
      attempt(async () => {
        // Keep the recent window current automatically. A day-old index is the
        // most staleness a source that publishes on a 45-day lag can justify.
        const refreshed = isStale(TWENTY_FOUR_HOURS)
          ? await refreshIndex({ maxReports: 8, since: daysAgo(45) })
          : undefined;

        const state = indexState();
        if (state.trades === 0) {
          return text(
            'The local index is empty, so there is nothing to search yet.\n\n' +
              'Run `congress_index` with a `sinceDays` window to build it. eFD ' +
              'cannot be queried by ticker, so the index is the only way to ask ' +
              'this question.' +
              DISCLAIMER
          );
        }

        const rosters = await committeesByMember();
        const hits = searchTrades({
          limit,
          member,
          since: daysAgo(sinceDays),
          ticker
        });

        const coverage =
          `Index holds ${state.trades.toLocaleString()} transactions from ` +
          `${state.reports.toLocaleString()} reports, filed ` +
          `${state.oldestFiled} to ${state.newestFiled}.`;

        if (hits.length === 0) {
          const popular = topTickers(12)
            .map(row => `${row.ticker} (${row.trades})`)
            .join(', ');
          return text(
            `No disclosed transactions${ticker ? ` in ${ticker.toUpperCase()}` : ''}` +
              `${member ? ` by ${member}` : ''} within ${sinceDays} days.\n\n` +
              `${coverage} A miss means either no senator disclosed it, or the ` +
              'index does not reach far enough back — check `congress_index` ' +
              'before concluding the former.\n\n' +
              `Most-traded tickers held: ${popular}` +
              DISCLAIMER
          );
        }

        const rows = hits
          .map(
            (hit: IndexedTrade) =>
              `| ${hit.transactionDate} | ${hit.filedDate} | ${hit.member} | ` +
              `${cell(hit.ticker)} | ${hit.type} | ${hit.amount} | ${hit.owner} |`
          )
          .join('\n');

        const byMember = groupBy(hits, hit => hit.member);
        const context = sortBy(Object.keys(byMember))
          .map(name => {
            const committees = committeesFor(rosters, name);
            return (
              `- **${name}** — ${(byMember[name] ?? []).length} transaction(s)\n` +
              (committees.length > 0
                ? committees
                    .map(
                      committee =>
                        `    - ${committee.name}${committee.title ? ` (${committee.title})` : ''}`
                    )
                    .join('\n')
                : '    - No current committee assignment found under that name.')
            );
          })
          .join('\n');

        return text(
          `## Disclosed senate transactions` +
            `${ticker ? ` — ${ticker.toUpperCase()}` : ''}\n\n` +
            `${hits.length} match(es).\n\n` +
            '| Transaction | Filed | Member | Ticker | Type | Amount | Owner |\n' +
            `|---|---|---|---|---|---|---|\n${rows}\n\n` +
            `### Committee context\n\n${context}\n\n` +
            `${coverage}` +
            (refreshed && refreshed.reportsIndexed > 0
              ? ` Added ${refreshed.reportsIndexed} new report(s) on this call.`
              : '') +
            `\n\n${LAG_CAVEAT}\n\n` +
            'Owner is the relationship, not a name: "Spouse" and "Child" holdings ' +
            'are disclosed but the family member is never identified.' +
            DISCLAIMER
        );
      })
  );

  server.registerTool(
    'congress_index',
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false
      },
      description:
        'Show how much Senate disclosure history is indexed locally, and extend ' +
        'it. Call with no arguments to report coverage; pass `sinceDays` to ' +
        'backfill. Each report is a separate request against a rate-limited ' +
        'government site, so work is capped per call and resumes where it left ' +
        'off — reports already indexed are never refetched, because a filed ' +
        'report never changes. Rough sizes: 12 months is ~180 reports, five ' +
        'years ~690, and the whole archive back to 2012 is ~2,400. Expect to ' +
        'call this several times to build deep history; each call reports how ' +
        'many reports remain.',
      inputSchema: z.object({
        maxReports: z
          .number()
          .int()
          .min(1)
          .max(45)
          .default(25)
          .describe(
            'Reports to fetch on this call, at roughly one per second. Capped ' +
              'because MCP clients time a tool call out at 60 seconds — the ' +
              'backfill is resumable, so several short calls beat one that dies.'
          ),
        sinceDays: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .optional()
          .describe(
            'Filing-date window to index. Omit to report coverage without ' +
              'fetching anything.'
          )
      }),
      title: 'Inspect or extend the disclosure index'
    },
    ({ maxReports, sinceDays }) =>
      attempt(async () => {
        const result =
          sinceDays === undefined
            ? undefined
            : await refreshIndex({ maxReports, since: daysAgo(sinceDays) });

        const state = indexState();
        const popular = topTickers(15)
          .map(row => `| ${row.ticker} | ${row.trades} | ${row.members} |`)
          .join('\n');

        return text(
          `## Disclosure index\n\n` +
            `${state.reports.toLocaleString()} reports · ` +
            `${state.trades.toLocaleString()} transactions · ` +
            `${state.tickers.toLocaleString()} distinct tickers\n\n` +
            `Filings indexed from **${state.oldestFiled ?? '—'}** to ` +
            `**${state.newestFiled ?? '—'}**.\n\n` +
            (result
              ? `Indexed ${result.reportsIndexed} report(s) and ` +
                `${result.tradesAdded} transaction(s) on this call. ` +
                (result.remaining > 0
                  ? `**${result.remaining} report(s) still pending** in that ` +
                    'window — call again to continue; it resumes where it stopped.'
                  : 'That window is now fully indexed.') +
                (result.failures.length > 0
                  ? `\n\n${result.failures.length} report(s) failed to parse:\n` +
                    result.failures
                      .map(entry => `- ${entry.url}: ${entry.reason}`)
                      .join('\n')
                  : '') +
                '\n\n'
              : 'Pass `sinceDays` to extend coverage.\n\n') +
            (state.tickers > 0
              ? `### Most-traded tickers held\n\n| Ticker | Trades | Members |\n|---|---|---|\n${popular}\n\n`
              : '') +
            `Stored at ${state.path}. eFD cannot be searched by ticker, which is ` +
            'why this exists; a ticker search can only find what is indexed.' +
            DISCLAIMER
        );
      })
  );

  server.registerTool(
    'congress_member_profile',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        "A senator's committee assignments, outside positions and board seats, " +
        'and every employer paying the household — self, spouse or child — read ' +
        'from their most recent annual financial disclosure. This is the ' +
        'conflict-of-interest picture behind a trade: which industries they have ' +
        'authority over, which boards they sit on, and who else pays the family. ' +
        'Senate only; House annual disclosures are scanned PDFs.',
      inputSchema: z.object({
        member: z
          .string()
          .min(2)
          .max(60)
          .describe('Senator name, e.g. "Tommy Tuberville". Matched loosely.')
      }),
      title: 'Committee seats and outside interests'
    },
    ({ member }) =>
      attempt(async () => {
        const [ref, rosters] = await Promise.all([
          findSenateAnnualReport(member),
          committeesByMember()
        ]);

        const committees = committeesFor(rosters, member);
        const committeeBlock =
          committees.length > 0
            ? `### Committees\n\n${sortBy(committees, entry => entry.name)
                .map(
                  entry =>
                    `- ${entry.name}${entry.title ? ` — **${entry.title}**` : ''}`
                )
                .join('\n')}\n\n`
            : `### Committees\n\nNo current assignment found for "${member}". The ` +
              'roster covers sitting members only, and the name has to match.\n\n';

        if (!ref) {
          return text(
            `## ${member}\n\n${committeeBlock}` +
              'No Senate annual financial disclosure found under that name. They ' +
              'may be a House member (whose annual disclosures are scanned PDFs ' +
              'this server cannot read — see `congress_house_filings`), or the ' +
              'name may not match the filing.' +
              DISCLAIMER
          );
        }

        const report = await senateAnnualReport(ref);

        const positions =
          report.positions.length > 0
            ? '### Outside positions and board seats\n\n' +
              '| Role | Entity | Type | Dates |\n|---|---|---|---|\n' +
              report.positions
                .map(
                  entry =>
                    `| ${entry.position} | ${entry.entity} | ${entry.entityType} | ${entry.dates} |`
                )
                .join('\n') +
              '\n\n'
            : '### Outside positions and board seats\n\nNone disclosed.\n\n';

        // Household income is the part that reaches beyond the member, so
        // relationships lead the table rather than the payer.
        const byRelationship = groupBy(report.income, entry => entry.paidTo);
        const income =
          report.income.length > 0
            ? '### Who pays the household\n\n' +
              '| Paid to | Employer / payer | Type | Amount |\n|---|---|---|---|\n' +
              sortBy(Object.keys(byRelationship))
                .flatMap(relationship =>
                  (byRelationship[relationship] ?? []).map(
                    entry =>
                      `| ${entry.paidTo} | ${entry.payer} | ${entry.type} | ${entry.amount} |`
                  )
                )
                .join('\n') +
              '\n\n'
            : '### Who pays the household\n\nNo earned income disclosed.\n\n';

        return text(
          `## ${report.member}${report.year ? ` — CY ${report.year} disclosure` : ''}\n\n` +
            committeeBlock +
            positions +
            income +
            `Source: ${report.reportUrl} (filed ${ref.filedDate}).\n\n` +
            '**What this cannot tell you.** Family members are never named — the ' +
            'form asks for a relationship, so "Spouse" is the most any official ' +
            'source will give. Spouse and child amounts are disclosed only as ' +
            '"> $1,000". And a board seat or an employer is a fact, not a ' +
            'finding: the useful question is whether it overlaps the committees ' +
            'above or a name they have traded.' +
            DISCLAIMER
        );
      })
  );

  server.registerTool(
    'congress_house_filings',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        "Periodic transaction reports filed by House members, from the Clerk's " +
        'official yearly index. No credential needed. This returns the filing ' +
        'record and a link to the PDF, NOT the transactions inside it — House ' +
        'disclosures are PDFs and many are scanned images, so the tickers and ' +
        'amounts are only readable by opening the document. For actual ' +
        'transaction detail use `congress_trades`, which covers the Senate.',
      inputSchema: z.object({
        member: z
          .string()
          .max(60)
          .optional()
          .describe('Filter by surname or full name, matched loosely.'),
        sinceDays: z.number().int().min(1).max(365).default(30),
        year: z
          .number()
          .int()
          .min(2008)
          .max(2100)
          .default(new Date().getFullYear())
          .describe('The Clerk indexes by filing year, not transaction year.')
      }),
      title: 'House transaction-report filings'
    },
    ({ member, sinceDays, year }) =>
      attempt(async () => {
        const filings = await houseFilings({ year });
        const cutoff = daysAgo(sinceDays);
        const wanted = member?.trim().toLowerCase();

        const shown = sortBy(
          filings.filter(filing => {
            if (filing.filingDate < cutoff) return false;
            if (wanted && !filing.member.toLowerCase().includes(wanted)) {
              return false;
            }
            return true;
          }),
          filing => filing.filingDate
        ).toReversed();

        if (shown.length === 0) {
          return text(
            `No House periodic transaction reports filed since ${cutoff}` +
              `${wanted ? ` matching "${member}"` : ''} in the ${year} index.` +
              (filings.length > 0
                ? ` The ${year} index holds ${filings.length} in total — widen ` +
                  '`sinceDays`.'
                : '') +
              DISCLAIMER
          );
        }

        const rows = shown
          .slice(0, 100)
          .map(
            filing =>
              `| ${filing.filingDate} | ${filing.member} | ${filing.stateDistrict} | ${filing.pdfUrl} |`
          )
          .join('\n');

        return text(
          `## House periodic transaction reports — filed since ${cutoff}\n\n` +
            `${shown.length} filing(s); showing ${Math.min(shown.length, 100)}.\n\n` +
            '| Filed | Member | District | Report |\n|---|---|---|---|\n' +
            `${rows}\n\n` +
            '**These are filing records, not transactions.** The tickers and ' +
            'amounts are inside each PDF, and this server does not read PDFs. ' +
            'Open a link to see what was actually traded.\n\n' +
            LAG_CAVEAT +
            DISCLAIMER
        );
      })
  );
}
