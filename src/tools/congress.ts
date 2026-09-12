import type { McpServer } from '@modelcontextprotocol/server';

import { groupBy, sortBy } from 'lodash-es';
import * as z from 'zod/v4';

import {
  committeesByMember,
  findSenateAnnualReport,
  houseFilings,
  normaliseName,
  senateAnnualReport,
  senateTrades,
  type Committee,
  type DisclosedTrade
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

function tradeRow(trade: DisclosedTrade): string {
  return (
    `| ${trade.transactionDate} | ${trade.filedDate} | ${trade.member} | ` +
    `${cell(trade.ticker)} | ${trade.type} | ${trade.amount} | ${trade.owner} |`
  );
}

export function registerCongressTools(server: McpServer): void {
  server.registerTool(
    'congress_trades',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'Recent stock transactions disclosed by US senators, read from the ' +
        "Senate's official eFD periodic transaction reports and cross-referenced " +
        'against current committee assignments. No credential needed. Filter by ' +
        'ticker or member. Amounts are bands and disclosure lags the trade by ' +
        'weeks — this is a lead to research, not a price. The committee column ' +
        'is the part worth reading: a member trading in a sector their committee ' +
        'supervises is a different observation from the same member buying an ' +
        'index fund.',
      inputSchema: z.object({
        member: z
          .string()
          .max(60)
          .optional()
          .describe('Filter to one senator by name, matched loosely.'),
        reportLimit: z
          .number()
          .int()
          .min(1)
          .max(60)
          .default(20)
          .describe(
            'How many recent reports to open. Each is a separate fetch against a ' +
              'rate-limited government site, so this is the real cost control. ' +
              'Reports are immutable once filed and cached for a month.'
          ),
        sinceDays: z
          .number()
          .int()
          .min(1)
          .max(5000)
          .default(30)
          .describe(
            'Only reports filed within this many days. The archive reaches back ' +
              'to 2012, so a long window is legitimate — but it returns the ' +
              'NEWEST `reportLimit` reports in that window, not the oldest, so ' +
              'narrow the window to walk backwards rather than raising the limit.'
          ),
        ticker: z
          .string()
          .max(10)
          .optional()
          .describe('Filter to one ticker. Bonds and funds often have none.')
      }),
      title: 'Recent congressional trades'
    },
    ({ member, reportLimit, sinceDays, ticker }) =>
      attempt(async () => {
        const [{ reportsRead, trades }, rosters] = await Promise.all([
          senateTrades({ reportLimit, since: daysAgo(sinceDays) }),
          committeesByMember()
        ]);

        const wantedTicker = ticker?.trim().toUpperCase();
        const wantedMember = member ? normaliseName(member) : undefined;

        const shown = trades.filter(trade => {
          if (wantedTicker && trade.ticker?.toUpperCase() !== wantedTicker) {
            return false;
          }
          if (wantedMember && normaliseName(trade.member) !== wantedMember) {
            return false;
          }
          return true;
        });

        if (shown.length === 0) {
          return text(
            `No matching transactions in ${reportsRead} report(s) filed since ` +
              `${daysAgo(sinceDays)}.` +
              (trades.length > 0
                ? ` Those reports held ${trades.length} other transaction(s), so ` +
                  'widen `reportLimit` or `sinceDays` before concluding there are none.'
                : ' Try a longer window.') +
              `\n\n${LAG_CAVEAT}` +
              DISCLAIMER
          );
        }

        const rows = shown.map(trade => tradeRow(trade)).join('\n');

        // The committee cross-reference is the reason this tool exists, so it
        // gets its own block rather than a column that would wrap unreadably.
        const byMember = groupBy(shown, trade => trade.member);
        const context = sortBy(Object.keys(byMember))
          .map(name => {
            const committees = committeesFor(rosters, name);
            const tickers = [
              ...new Set(
                (byMember[name] ?? [])
                  .map(trade => trade.ticker)
                  .filter((value): value is string => value !== undefined)
              )
            ];
            return (
              `- **${name}** — ${tickers.length > 0 ? tickers.join(', ') : 'no listed tickers'}\n` +
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
          `## Disclosed senate transactions\n\n` +
            `${shown.length} transaction(s) from ${reportsRead} report(s) filed ` +
            `since ${daysAgo(sinceDays)}.\n\n` +
            '| Transaction | Filed | Member | Ticker | Type | Amount | Owner |\n' +
            `|---|---|---|---|---|---|---|\n${rows}\n\n` +
            `### Committee context\n\n${context}\n\n` +
            `${LAG_CAVEAT}\n\n` +
            'Owner is the relationship, not a name: "Spouse" and "Child" holdings ' +
            'are disclosed but the family member is never identified.' +
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
