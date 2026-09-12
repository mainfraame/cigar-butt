import type { McpServer } from '@modelcontextprotocol/server';

import { groupBy } from 'lodash-es';
import * as z from 'zod/v4';

import {
  isOpenMarket,
  ownershipActivity,
  TRANSACTION_CODES,
  type InsiderTransaction
} from '../data/ownership.ts';
import { resolveTicker } from '../data/sec.ts';
import { money, out, sum, ZERO, type Decimal } from '../math/decimal.ts';
import {
  attempt,
  cell,
  DISCLAIMER,
  requireCapabilities,
  text,
  usd
} from './shared.ts';

/** Shares times price, when both are known. A grant has no price. */
function notional(entry: InsiderTransaction): Decimal | undefined {
  return entry.price === undefined
    ? undefined
    : entry.price.times(entry.shares);
}

function role(entry: InsiderTransaction): string {
  const parts = [
    entry.officer ? (entry.officerTitle ?? 'officer') : undefined,
    entry.director ? 'director' : undefined,
    entry.tenPercentOwner ? '10% owner' : undefined
  ].filter((part): part is string => part !== undefined);
  return parts.length > 0 ? parts.join(', ') : 'insider';
}

export function registerOwnershipTools(server: McpServer): void {
  server.registerTool(
    'ownership_activity',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'Who is buying and selling the shares, from SEC ownership filings: ' +
        'insider transactions (Forms 3 and 4) and 5% stakes (Schedules 13D ' +
        'and 13G). This answers a question the asset tests cannot — the ' +
        'balance sheet says whether a name is cheap, and this says whether ' +
        'anyone with a closer view of it is acting on that.\n\n' +
        '**Open-market trades are counted separately from everything else.** A ' +
        'Form 4 reports compensation and tax mechanics in the same table as ' +
        'real trades, so counting rows turns a routine option grant into ' +
        '"insiders are buying". Only codes `P` and `S` are decisions to ' +
        'transact at the market price with the filer’s own money, and only ' +
        'those are summed.\n\n' +
        'A 13D and a 13G are also not the same claim: 13D reserves the right ' +
        'to influence control, 13G declares the holder passive. At a company ' +
        'trading below its net current assets, a 13D is often a demand that ' +
        'the cash be returned rather than spent.',
      inputSchema: z.object({
        maxDocuments: z
          .number()
          .int()
          .min(1)
          .max(60)
          .default(30)
          .describe(
            'Forms 3 and 4 to read. Each is one request. Anything beyond the ' +
              'cap is reported as unread rather than dropped.'
          ),
        sinceDays: z
          .number()
          .int()
          .min(1)
          .max(1095)
          .default(180)
          .describe('Filing-date window.'),
        ticker: z.string().min(1).max(10).describe('US-listed ticker symbol.')
      }),
      title: 'Read insider and 5% ownership filings'
    },
    ({ maxDocuments, sinceDays, ticker }) =>
      attempt(async () => {
        const blocked = requireCapabilities('sec');
        if (blocked) return blocked;

        const company = await resolveTicker(ticker);
        if (!company) {
          return text(
            `No SEC filer matches the ticker ${ticker.toUpperCase()}.`
          );
        }

        const cik = String(company.cik_str);
        const activity = await ownershipActivity(cik, {
          maxDocuments,
          sinceDays
        });

        const open = activity.transactions.filter(entry =>
          isOpenMarket(entry.code)
        );
        const other = activity.transactions.filter(
          entry => !isOpenMarket(entry.code)
        );

        const bought = open.filter(entry => entry.code === 'P');
        const sold = open.filter(entry => entry.code === 'S');

        const boughtShares = sum(...bought.map(entry => entry.shares)) ?? ZERO;
        const soldShares = sum(...sold.map(entry => entry.shares)) ?? ZERO;
        const boughtValue = sum(...bought.map(entry => notional(entry)));
        const soldValue = sum(...sold.map(entry => notional(entry)));

        const rows = open
          .map(
            entry =>
              `| ${entry.asOf} | ${entry.code === 'P' ? 'BUY' : 'SELL'} | ` +
              `${entry.owner} | ${role(entry)} | ` +
              `${out(entry.shares, 0)?.toLocaleString('en-US') ?? '?'} | ` +
              `${cell(money(entry.price) === undefined ? undefined : usd(money(entry.price)))} | ` +
              `${cell(money(notional(entry)) === undefined ? undefined : usd(money(notional(entry))))} | ` +
              `${cell(out(entry.sharesAfter, 0)?.toLocaleString('en-US'))} |`
          )
          .join('\n');

        const activists = activity.stakes.filter(stake => stake.activist);
        const passive = activity.stakes.filter(stake => !stake.activist);

        const stakeRows = activity.stakes
          .map(
            stake =>
              `| ${stake.filed} | ${stake.form} | ` +
              `${stake.activist ? '**control**' : 'passive'} | ` +
              `${cell(stake.filer)} |`
          )
          .join('\n');

        const byCode = Object.entries(groupBy(other, entry => entry.code)).map(
          ([code, entries]) =>
            `- \`${code}\` ${TRANSACTION_CODES[code] ?? 'unrecognised code'}: ` +
            `${entries.length} row(s), ` +
            `${out(sum(...entries.map(entry => entry.shares)), 0)?.toLocaleString('en-US')} shares`
        );

        return text(
          `## ${company.title} (${company.ticker}) — ownership activity\n\n` +
            `Filings from the last ${sinceDays} days.\n\n` +
            (open.length > 0
              ? '### Open-market transactions\n\n' +
                'Codes `P` and `S` only — the filer chose to transact at the ' +
                'prevailing price with their own money.\n\n' +
                '| Date | Side | Owner | Role | Shares | Price | Value | Held after |\n' +
                `|---|---|---|---|---|---|---|---|\n${rows}\n\n` +
                `**Net: ${out(boughtShares.minus(soldShares), 0)?.toLocaleString('en-US')} shares** ` +
                `(${out(boughtShares, 0)?.toLocaleString('en-US')} bought, ` +
                `${out(soldShares, 0)?.toLocaleString('en-US')} sold)` +
                // "X against —" reads as a rendering fault. No sales is a
                // finding worth stating in words, and it is the more
                // interesting of the two cases.
                (sold.length === 0
                  ? `. ${usd(money(boughtValue))} bought and **nothing sold** ` +
                    'in the window.'
                  : `, ${usd(money(boughtValue))} bought against ` +
                    `${usd(money(soldValue))} sold.`) +
                '\n\n'
              : 'No open-market insider transactions in the window. That is a ' +
                'fact about this window, not about the name — insiders are ' +
                'barred from trading through much of the year.\n\n') +
            (other.length > 0
              ? '### Everything else on the Form 4s\n\n' +
                'Excluded from the net above, because none of it is a decision ' +
                'to transact at the market price.\n\n' +
                `${byCode.join('\n')}\n\n`
              : '') +
            (activity.stakes.length > 0
              ? '### 5% holders\n\n' +
                '| Filed | Form | Intent | Filer |\n|---|---|---|---|\n' +
                `${stakeRows}\n\n` +
                (activists.length > 0
                  ? `**${activists.length} filing(s) on Schedule 13D**, which ` +
                    'reserves the right to influence control. Read those before ' +
                    'anything else here: at a company trading below its net ' +
                    'current assets, a 13D is usually an argument about what ' +
                    'happens to the assets.\n\n'
                  : `All ${passive.length} are 13G — filed as passive holders. ` +
                    'That is a declaration of intent, not a promise; a holder ' +
                    'may refile on 13D.\n\n')
              : '') +
            (activity.newInsiders.length > 0
              ? '### Became an insider\n\n' +
                activity.newInsiders
                  .map(
                    entry =>
                      `- ${entry.filed} — **${entry.owner}**` +
                      `${entry.tenPercentOwner ? ' (crossed 10%)' : ''}` +
                      `${entry.director ? ' (director)' : ''}` +
                      `${entry.officer ? ` (${entry.officerTitle ?? 'officer'})` : ''}`
                  )
                  .join('\n') +
                '\n\n'
              : '') +
            (activity.unreadable > 0
              ? `${activity.unreadable} form(s) in the window were not read — ` +
                'either beyond `maxDocuments` or filed in a layout this parser ' +
                'does not handle. The figures above are short by whatever they ' +
                'contain.\n\n'
              : '') +
            'Ownership filings are evidence about conviction, not about value. ' +
            'An insider buys for reasons the filing does not state, and a fund ' +
            'crossing 5% may be hedging something you cannot see. Read this ' +
            'alongside the balance sheet, never instead of it.' +
            DISCLAIMER
        );
      })
  );
}
