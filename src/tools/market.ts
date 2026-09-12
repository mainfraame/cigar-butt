import type { McpServer } from '@modelcontextprotocol/server';

import { sortBy } from 'lodash-es';
import * as z from 'zod/v4';

import { findInstitutions, latestCallReport } from '../data/fdic.ts';
import { shortInterest } from '../data/finra.ts';
import { fredConfigured, macroSnapshot } from '../data/fred.ts';
import { fxCurrencies, fxRate } from '../data/fx.ts';
import { dividends, splits, tickerReference } from '../data/reference.ts';
import { dec, out } from '../math/decimal.ts';
import { attempt, cell, DISCLAIMER, pct, text, usd } from './shared.ts';

import type { BankFinancials, Institution } from '../data/fdic.ts';

const tickerArg = z
  .string()
  .min(1)
  .max(10)
  .describe('US-listed ticker symbol, e.g. "AAPL". Case-insensitive.');

/** One row per bank, so several charters under one filer can be compared. */
function bankRow(institution: Institution, report: BankFinancials): string {
  return (
    `| ${institution.name} | ${institution.cert} | ${usd(out(dec(report.assets), 0))} | ` +
    `${usd(out(dec(report.tangibleCommonEquity), 0))} | ${pct(report.tangibleEquityRatio)} | ` +
    `${pct(report.noncurrentLoanRatio)} | ${cell(report.allowanceCoverage, 'x')} | ` +
    `${cell(report.returnOnAssets, '%')} | ${report.reportDate} |`
  );
}

export function registerMarketTools(server: McpServer): void {
  server.registerTool(
    'macro_context',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        "Fetch the macro figures Graham's tests are stated against: the Moody's Aaa " +
        'corporate bond yield, the 10-year Treasury, and CPI with its trailing ' +
        'twelve-month change. Graham required an earnings yield of at least twice ' +
        'the Aaa yield, so the P/E a name must beat moves with the bond market — a ' +
        'fixed ceiling quoted from the book applies a 1973 bond yield to a current ' +
        'balance sheet. Every figure carries the date it is for. Needs a FRED key.',
      inputSchema: z.object({
        priceEarnings: z
          .number()
          .positive()
          .finite()
          .optional()
          .describe(
            "A candidate's P/E, to judge against the Aaa-derived ceiling. Optional."
          )
      }),
      title: 'Macro context for the Graham tests'
    },
    ({ priceEarnings }) =>
      attempt(async () => {
        if (!fredConfigured()) {
          // Every series here comes from FRED, so an absent key produces a table
          // of dashes rather than an error unless it is caught up front.
          throw new Error(
            'FRED is not configured. Set `FRED_API_KEY`, or run ' +
              '`setup_credentials`. Register at ' +
              'https://fredaccount.stlouisfed.org/apikeys — the key is free and ' +
              'issued immediately.'
          );
        }

        const macro = await macroSnapshot();

        const rows = [
          `| Aaa corporate bond yield | ${pct(macro.aaaYield?.value)} | ${cell(macro.aaaYield?.asOf)} |`,
          `| 10-year Treasury | ${pct(macro.tenYearYield?.value)} | ${cell(macro.tenYearYield?.asOf)} |`,
          `| CPI-U (index) | ${cell(macro.cpi?.value)} | ${cell(macro.cpi?.asOf)} |`,
          `| CPI, trailing 12 months | ${pct(macro.cpiYearOverYear?.value)} | ${cell(macro.cpiYearOverYear?.asOf)} |`
        ].join('\n');

        const verdict =
          priceEarnings !== undefined && macro.grahamMaxPe !== undefined
            ? `\nA P/E of ${priceEarnings} ${priceEarnings <= macro.grahamMaxPe ? 'clears' : 'fails'} ` +
              `the ${macro.grahamMaxPe} ceiling implied by the current Aaa yield.\n`
            : '';

        return text(
          '## Macro context\n\n' +
            `| Series | Level | As of |\n|---|---|---|\n${rows}\n\n` +
            `Graham's earnings-yield hurdle at this Aaa yield is ` +
            `${pct(out(dec(macro.aaaYield?.value)?.times(2)))}, ` +
            `a maximum P/E of ${cell(macro.grahamMaxPe)}.\n` +
            verdict +
            '\nCPI is here for one reason: a five-year holding period on a ' +
            'deep-value book returns nominal dollars, and the discount that ' +
            'closes has to beat inflation before it is a gain.' +
            DISCLAIMER
        );
      })
  );

  server.registerTool(
    'bank_call_report',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'Pull the latest FDIC call report for a bank, by name or FDIC certificate ' +
        'number. This is the asset test that works on a financial: enterprise value ' +
        'and net cash are meaningless for SIC 6000-6799, but tangible common equity ' +
        'over tangible assets, noncurrent loans over net loans, and the allowance ' +
        'held against those loans are exactly the figures a Schloss screen on a bank ' +
        'turns on. Straight from the quarterly call report, dated by report date. No ' +
        'credential required. Search by the holding company name — the SEC filer — ' +
        'and it will also match the insured bank underneath it.',
      inputSchema: z.object({
        cert: z
          .number()
          .int()
          .positive()
          .optional()
          .describe('FDIC certificate number, when you already have it.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(10)
          .default(3)
          .describe('How many matching institutions to report.'),
        name: z
          .string()
          .min(2)
          .max(120)
          .optional()
          .describe('Bank or holding-company name, e.g. "First Keystone Corp".')
      }),
      title: 'FDIC call report for a bank'
    },
    ({ cert, limit, name }) =>
      attempt(async () => {
        if (cert === undefined && name === undefined) {
          throw new Error('Pass either a `cert` or a `name`.');
        }

        const matches =
          cert === undefined ? await findInstitutions(name ?? '', limit) : [];
        const targets =
          cert === undefined
            ? sortBy(matches, institution => (institution.active ? 0 : 1))
            : ([
                { active: true, cert, name: `FDIC cert ${cert}` }
              ] as Institution[]);

        if (targets.length === 0) {
          return text(
            `No FDIC-insured institution matched "${name ?? cert}". FDIC indexes the ` +
              'insured bank and its holding company, not the ticker, so try the legal ' +
              'name as it appears on the filing cover page.'
          );
        }

        const rows: string[] = [];
        const missing: string[] = [];
        for (const institution of targets) {
          const report = await latestCallReport(institution.cert);
          if (report) {
            rows.push(bankRow(institution, report));
          } else {
            missing.push(`${institution.name} (cert ${institution.cert})`);
          }
        }

        const inactive = targets.filter(institution => !institution.active);
        const holdings = targets
          .map(institution => institution.holdingCompany)
          .filter((value): value is string => value !== undefined);

        return text(
          `## FDIC call reports — ${name ?? `cert ${cert}`}\n\n` +
            '| Bank | Cert | Assets | Tangible common equity | TCE/TA | ' +
            'NCL/loans | Allowance cover | ROA | Report date |\n' +
            '|---|---|---|---|---|---|---|---|---|\n' +
            `${rows.join('\n')}\n\n` +
            (holdings.length > 0
              ? `Holding company: ${[...new Set(holdings)].join(', ')}. That is ` +
                'normally the SEC filer, and the entity a share price belongs to.\n\n'
              : '') +
            (inactive.length > 0
              ? `**Inactive charters in this list:** ${inactive
                  .map(
                    institution =>
                      `${institution.name} (cert ${institution.cert})`
                  )
                  .join(', ')}. Their last call report is historical.\n\n`
              : '') +
            (missing.length > 0
              ? `No call report returned for: ${missing.join(', ')}.\n\n`
              : '') +
            'A bank below tangible book is only cheap if the loan book is sound. ' +
            'Read the noncurrent-loan ratio and the allowance coverage before the ' +
            'discount: equity is what is left after the losses, and a thin ' +
            'allowance against rising noncurrent loans is the discount explaining ' +
            'itself.' +
            DISCLAIMER
        );
      })
  );

  server.registerTool(
    'check_corporate_actions',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'Check listing status and corporate actions for a ticker against Polygon ' +
        'reference data. Two things this catches that a ratio cannot. A split ' +
        'between the balance-sheet date and today makes every per-share figure ' +
        'derived from the filing wrong — the share count is pre-split and the price ' +
        'is post-split — and a reverse split makes a name look cheap by exactly the ' +
        'split factor. And a delisted ticker still resolves in the EDGAR index long ' +
        'after it stopped trading. Pass the balance-sheet period end as `since`.',
      inputSchema: z.object({
        includeDividends: z
          .boolean()
          .default(true)
          .describe('Report recent cash dividends alongside the splits.'),
        since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be an ISO date, e.g. 2026-03-31')
          .optional()
          .describe(
            'Balance-sheet period end. Splits on or after this date invalidate ' +
              'per-share figures taken from that filing.'
          ),
        ticker: tickerArg
      }),
      title: 'Check listing status and corporate actions'
    },
    ({ includeDividends, since, ticker }) =>
      attempt(async () => {
        const reference = await tickerReference(ticker);
        const allSplits = await splits(ticker);
        const relevant =
          since === undefined
            ? allSplits
            : allSplits.filter(split => split.executionDate >= since);

        const splitRows = allSplits
          .map(
            split =>
              `| ${split.executionDate} | ${cell(split.splitTo)}-for-${cell(split.splitFrom)} | ` +
              `${cell(out(dec(split.ratio), 4))} | ${split.ratio !== undefined && split.ratio < 1 ? 'reverse' : 'forward'} |`
          )
          .join('\n');

        const payouts = includeDividends ? await dividends(ticker) : [];
        const dividendRows = payouts
          .map(
            payout =>
              `| ${payout.exDate} | ${usd(payout.cashAmount)} | ${cell(payout.payDate)} | ${cell(payout.frequency, '/yr')} |`
          )
          .join('\n');

        const warning =
          relevant.length > 0 && since !== undefined
            ? `**${relevant.length} split(s) on or after ${since}.** Every per-share ` +
              `figure from that filing is stated in pre-split shares. Restate the ` +
              `share count by the split factor (${cell(relevant[0]?.ratio)}) ` +
              'before comparing it to a current price, or take the share count from ' +
              'the most recent cover page instead.\n\n'
            : '';

        return text(
          `## ${reference.name ?? reference.ticker} (${reference.ticker}) — listing and actions\n\n` +
            `Status: **${reference.active ? 'active' : 'DELISTED'}**` +
            `${reference.delistedOn ? ` as of ${reference.delistedOn}` : ''} · ` +
            `${cell(reference.exchange)} · listed ${cell(reference.listedOn)} · ` +
            `CIK ${cell(reference.cik)}\n\n` +
            `Shares outstanding: ${cell(reference.sharesOutstanding?.toLocaleString('en-US'))} ` +
            `(Polygon record last updated ${cell(reference.lastUpdated)})\n\n` +
            (reference.active
              ? ''
              : '**This ticker no longer trades.** Whatever the balance sheet says, ' +
                'the security is gone — acquired, taken private, or removed. Nothing ' +
                'downstream of this should treat it as investable.\n\n') +
            warning +
            (allSplits.length > 0
              ? `### Splits\n\n| Executed | Ratio | Factor | Direction |\n|---|---|---|---|\n${splitRows}\n\n`
              : 'No splits on record.\n\n') +
            (dividendRows.length > 0
              ? `### Dividends\n\n| Ex-date | Amount | Paid | Frequency |\n|---|---|---|---|\n${dividendRows}\n\n`
              : '') +
            'Polygon reference data is a vendor record, not a filing. When it ' +
            'disagrees with the cover page of the latest 10-Q, the filing wins.' +
            DISCLAIMER
        );
      })
  );

  server.registerTool(
    'short_interest',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        "FINRA consolidated short interest for one ticker — the market's own " +
        'answer to "why is this cheap?". Free, no credential. Reports shares ' +
        'short, days to cover, and the trend across the reporting window. Heavy ' +
        'short interest on a sub-tangible-book name belongs in the reason the ' +
        'name is cheap; it is not an automatic veto, and Schloss owned plenty of ' +
        'names the market disliked.',
      inputSchema: z.object({ ticker: tickerArg }),
      title: 'Short interest'
    },
    ({ ticker }) =>
      attempt(async () => {
        const report = await shortInterest(ticker);

        if (report.rows.length === 0) {
          return text(
            `No FINRA short-interest rows for ${report.ticker} in the last 400 days. ` +
              'FINRA publishes by symbol on the consolidated tape, so an absent ' +
              'symbol usually means the ticker is wrong, foreign, or no longer ' +
              'trading — check `check_corporate_actions` before concluding the ' +
              'short interest is zero.' +
              DISCLAIMER
          );
        }

        const rows = report.rows
          .slice(0, 12)
          .map(
            row =>
              `| ${row.settlementDate} | ${cell(out(row.shares, 0)?.toLocaleString('en-US'))} | ` +
              `${cell(out(row.daysToCover, 2))} | ${cell(out(row.averageDailyVolume, 0)?.toLocaleString('en-US'))} | ` +
              `${cell(out(row.changeFromPrior, 0)?.toLocaleString('en-US'))} |`
          )
          .join('\n');

        return text(
          `## Short interest — ${report.ticker}\n\n` +
            `${report.latest?.issueName ?? ''}\n\n` +
            '| Settlement | Shares short | Days to cover | Avg daily volume | Change |\n' +
            `|---|---|---|---|---|\n${rows}\n\n` +
            (report.trend
              ? `Shares short have moved ${pct(out(report.trend))} across the window ` +
                `(${report.rows.at(-1)?.settlementDate} to ${report.latest?.settlementDate}).\n\n`
              : '') +
            'FINRA publishes twice a month and settles on a lag, so the newest row ' +
            'is already a week or two old — read the settlement date, not the ' +
            'position. Days to cover is shares short over average daily volume: ' +
            'above roughly 5 the position is hard to exit quickly, which cuts both ' +
            'ways.' +
            DISCLAIMER
        );
      })
  );

  server.registerTool(
    'fx_rate',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'Exchange rate between two currencies, from the European Central ' +
        "Bank's daily reference rates via Frankfurter. No credential, no cap. " +
        'Needed whenever a screen leaves the US — a balance sheet in yen cannot ' +
        'be compared against a dollar cash balance without one. Pass a date to ' +
        'get a historical rate, which is what a return calculation across ' +
        'currencies requires.',
      inputSchema: z.object({
        base: z
          .string()
          .length(3)
          .describe('ISO currency code to convert FROM, e.g. "USD".'),
        on: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO date, e.g. 2026-01-02')
          .optional()
          .describe(
            'Rate as of this date. Omit for the latest. Weekends and holidays ' +
              'return the last published rate before them.'
          ),
        quote: z
          .string()
          .length(3)
          .describe('ISO currency code to convert TO, e.g. "JPY".')
      }),
      title: 'Exchange rate'
    },
    ({ base, on, quote }) =>
      attempt(async () => {
        try {
          const result = await fxRate(base, quote, on);
          const inverse = dec(1)?.div(result.rate);

          return text(
            `## ${result.base}/${result.quote}\n\n` +
              `**1 ${result.base} = ${out(result.rate, 6)} ${result.quote}** ` +
              `as of ${result.asOf}` +
              (on && on !== result.asOf
                ? ` (asked for ${on}; that day published no rate, so the last ` +
                  'one before it is shown)'
                : '') +
              `\n\n1 ${result.quote} = ${out(inverse, 6)} ${result.base}\n\n` +
              'ECB reference rates are published once each business day around ' +
              '16:00 CET. They are a reference, not a dealable price, and the ' +
              'spread you would actually pay is not in this number.' +
              DISCLAIMER
          );
        } catch (error) {
          const known = await fxCurrencies().catch(() => ({}));
          const codes = Object.keys(known);
          return text(
            `${error instanceof Error ? error.message : String(error)}\n\n` +
              (codes.length > 0
                ? `Currencies published: ${codes.join(', ')}.`
                : '') +
              DISCLAIMER
          );
        }
      })
  );
}
