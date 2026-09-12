import type { McpServer } from '@modelcontextprotocol/server';

import * as z from 'zod/v4';

import {
  resolveDetail,
  setDetailPreference,
  type DetailLevel
} from '../analysis/technical-settings.ts';
import { summarise, toBars } from '../analysis/technical.ts';
import { dailyBars } from '../data/bars.ts';
import { dec, money, out } from '../math/decimal.ts';
import {
  attempt,
  cell,
  DISCLAIMER,
  pct,
  requireCapabilities,
  text,
  usd
} from './shared.ts';

import type { TechnicalSummary } from '../analysis/technical.ts';
import type { Adjustment } from '../data/bars.ts';
import type { Decimal } from '../math/decimal.ts';

/**
 * Price and volume statistics.
 *
 * This tool sits outside the Graham/Schloss method, in the same way the
 * congressional-disclosure tools do, and its output says so in as many words.
 * The method is an asset test: price against net current assets, price against
 * tangible book. No arrangement of past prices moves either side of that
 * comparison, so nothing here can make a name cheap or stop it being cheap.
 *
 * What it is for is the one question the balance sheet cannot answer — whether
 * a position can be got out of again — plus enough volatility to size with and
 * enough price history to say honestly "this has fallen 60% in a year, go and
 * find out why".
 *
 * The reader is running a book of 15 to 60 names held for years, not watching
 * an intraday chart, so the default output is plain language with the
 * interpretation stated rather than implied. `detail: "advanced"` prints the
 * indicator table for someone who wants the windows and the raw values, and the
 * choice persists — see `technical-settings.ts`.
 */

/** How the adjustment basis is described in the output. */
const ADJUSTMENT_NOTE: Record<Adjustment, string> = {
  'dividends-and-splits':
    'restated for splits **and** dividends — a total-return series, which is ' +
    'the right basis for a value strategy where the dividend is often a large ' +
    'share of the return',
  none:
    '**not adjusted for corporate actions**. A split inside the window makes ' +
    'every figure wrong by the split factor — run `check_corporate_actions` ' +
    'before reading any of it',
  splits:
    'restated for splits but **not** dividends, so the fall from the high on a ' +
    'high-yielding name is overstated by roughly the dividends paid'
};

/** A calendar year is ~252 sessions; ask for enough days to fill the window. */
const CALENDAR_DAYS_PER_YEAR = 365;

const BOUNDARY =
  '### What this is not\n\n' +
  'None of the above says whether the name is cheap. This server screens on ' +
  'the balance sheet — NCAV, tangible book, net cash — and those tests are ' +
  'unaffected by anything the price has done. Use `analyze_ticker` for the ' +
  'verdict and `check_disqualifiers` before it, and read a large fall here as ' +
  'a question to answer from the filings rather than an answer in itself.';

/**
 * Puts the exit estimate into words.
 *
 * Stated as a sentence rather than left to the reader because the number alone
 * invites the wrong reading: "3 sessions" sounds slow and is fine, "40
 * sessions" sounds survivable and means the exit price is whatever the name
 * does over two months.
 */
function exitVerdict(sessions: Decimal): string {
  if (sessions.lte(1)) {
    return 'That is comfortably inside a day’s normal trading.';
  }
  if (sessions.lte(5)) {
    return (
      'That is a few days of patient selling — workable for a position ' +
      'held for years.'
    );
  }
  if (sessions.lte(20)) {
    return (
      'That is more than a week of continuous selling, and possibly several. ' +
      'Either size the position smaller, or accept that the exit price is ' +
      'whatever the name does meanwhile.'
    );
  }
  return (
    'That is not a liquid position at this size. The balance sheet was ' +
    'supposed to bound the downside; an exit measured in months hands that ' +
    'back to the market. Cut the size or leave it alone.'
  );
}

function header(
  summary: TechnicalSummary,
  source: string,
  adjustment: Adjustment,
  ticker: string,
  title: string
): string {
  return (
    `## ${ticker} — ${title}\n\n` +
    `${summary.barCount} daily bars from ${source}, ${summary.firstBar} to ` +
    `${summary.asOf}. Figures are ${ADJUSTMENT_NOTE[adjustment]}.\n\n`
  );
}

/** The plain-language read. Numbers a non-technical reader can act on. */
function simpleBody(
  summary: TechnicalSummary,
  positionValue: number | undefined,
  participation: number
): string {
  const book = summary.liquidity;
  const range = summary.range52Week;
  const sessions = summary.daysToLiquidate;

  // The mean is only worth printing when it disagrees with the median, which
  // is precisely when it is misleading — one block trade carrying a whole
  // window. Below that it is noise in a plain-language answer.
  const lumpy =
    book !== undefined &&
    book.meanDollarVolume.gt(book.medianDollarVolume.times('1.5'));

  const liquidity = book
    ? `A typical session trades about **${usd(money(book.medianDollarVolume))}** of ` +
      `this stock (median over ${book.window} sessions)` +
      (lumpy
        ? `. The mean is ${usd(money(book.meanDollarVolume))}, well above that, so a ` +
          'handful of block trades are carrying the window and the median is the ' +
          'figure to size against'
        : '') +
      (book.sessionsWithNoTrade > 0
        ? `. It did not trade at all on ${book.sessionsWithNoTrade} of those ` +
          `${book.window} sessions`
        : '') +
      '.'
    : `${summary.barCount} sessions is not enough history for the requested ` +
      'volume window, so dollar volume could not be measured. That is a gap in ' +
      'the evidence, not a finding.';

  const exit =
    sessions === undefined
      ? positionValue === undefined
        ? 'Pass `positionValue` to find out how long a position of that size ' +
          'would take to sell — it is a property of the position, not of the stock.'
        : 'How long an exit would take could not be computed: there is no ' +
          'median dollar volume to divide into. That is itself the answer.'
      : `Selling **${usd(positionValue)}** while taking ${pct(participation)} of a ` +
        `normal session would take roughly **${cell(out(sessions, 1))} sessions**. ` +
        exitVerdict(sessions);

  const fall = range
    ? `At ${usd(money(summary.close))} the price is **${pct(out(range.drawdownFromHigh))} below** ` +
      `its 52-week high of ${usd(money(range.high))} (${range.highDate}), and ` +
      `${pct(out(range.riseAboveLow))} above its low of ${usd(money(range.low))} ` +
      `(${range.lowDate}). That is a description of what happened, not a reason ` +
      'to buy or to wait — the reason is in the filings.'
    : 'There is not a full year of history here, so the 52-week range could ' +
      'not be computed. Nothing shorter is substituted for it.';

  const movement =
    summary.atr && summary.volatility
      ? `A normal day moves about ${usd(money(summary.atr.value))}, roughly ` +
        `**${pct(out(summary.atrFractionOfPrice))}** of the price. Over the last ` +
        `${summary.volatility.window} sessions the price has varied at an annualised ` +
        `**${pct(out(summary.volatility.value))}** — useful for deciding how large a ` +
        'position can be without the mark-to-market becoming the thing you react to.'
      : 'There is not enough history to say what a normal day looks like here.';

  return (
    `**Can you get out again?** ${liquidity}\n\n${exit}\n\n` +
    `**Has it fallen?** ${fall}\n\n` +
    `**How much does it move?** ${movement}\n\n` +
    `${BOUNDARY}\n\n` +
    'Ask for `detail: "advanced"` to see the underlying indicators, their ' +
    'windows and their as-of dates. That choice is remembered.'
  );
}

/** The full table, for a reader who knows what an ATR is. */
function advancedBody(summary: TechnicalSummary): string {
  const range = summary.range52Week;
  const book = summary.liquidity;

  const rows: [string, string, string][] = [
    ['Close', usd(money(summary.close)), summary.asOf],
    [
      `Average true range (${cell(summary.atr?.window)} sessions, Wilder)`,
      summary.atr
        ? `${usd(money(summary.atr.value))} (${pct(out(summary.atrFractionOfPrice))} of price)`
        : '—',
      cell(summary.atr?.asOf)
    ],
    [
      `Realised volatility (${cell(summary.volatility?.window)} sessions, annualised)`,
      pct(out(summary.volatility?.value)),
      cell(summary.volatility?.asOf)
    ],
    [
      '52-week high',
      range ? `${usd(money(range.high))} on ${range.highDate}` : '—',
      cell(range?.asOf)
    ],
    [
      '52-week low',
      range ? `${usd(money(range.low))} on ${range.lowDate}` : '—',
      cell(range?.asOf)
    ],
    ['Below that high', pct(out(range?.drawdownFromHigh)), cell(range?.asOf)],
    ['Above that low', pct(out(range?.riseAboveLow)), cell(range?.asOf)],
    [
      `Median daily dollar volume (${cell(book?.window)} sessions)`,
      usd(money(book?.medianDollarVolume)),
      cell(book?.asOf)
    ],
    [
      'Mean daily dollar volume (same window)',
      usd(money(book?.meanDollarVolume)),
      cell(book?.asOf)
    ],
    [
      'Sessions with no trade at all',
      book ? `${book.sessionsWithNoTrade} of ${book.window}` : '—',
      cell(book?.asOf)
    ],
    [
      'Sessions to exit the stated position',
      cell(out(summary.daysToLiquidate, 1)),
      summary.asOf
    ]
  ];

  for (const average of summary.movingAverages) {
    rows.push([
      `${average.reading.window}-session simple average of the close`,
      `${usd(money(average.reading.value))} (price ${pct(out(average.distanceFromPrice))} away)`,
      average.reading.asOf
    ]);
  }

  return (
    '| Statistic | Value | As of |\n|---|---|---|\n' +
    rows
      .map(([name, value, asOf]) => `| ${name} | ${value} | ${asOf} |`)
      .join('\n') +
    '\n\nA cell reading "—" **could not be computed** — there was not enough ' +
    'history for that window. It is not a zero and not a failed test, and no ' +
    'shorter window is substituted, because a 90-session average labelled as a ' +
    '200-session one is simply a wrong number.\n\n' +
    'The averages are here as reference levels for "how far has this moved", ' +
    'not as signals: a price crossing its average is an arithmetic fact about ' +
    'the past. RSI, MACD, stochastics, bands and crossovers are deliberately ' +
    'absent — their only use is timing a trade, and this is a book held for ' +
    'years and sold when the discount closes.\n\n' +
    BOUNDARY
  );
}

export function registerTechnicalTools(server: McpServer): void {
  server.registerTool(
    'price_history_stats',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'Price-and-volume statistics from daily bars: how much of the stock ' +
        'actually trades, how long a position of a given size would take to sell, ' +
        'how far the price sits below its 52-week high, and how much it moves in ' +
        'a normal day.\n\n' +
        '**These are not part of the screen.** This server implements an asset ' +
        'test — price against net current assets and tangible book — and no ' +
        'statistic here has any bearing on whether a balance sheet is cheap. Do ' +
        'not let a moving average or a fall from a high argue for or against a ' +
        'name, and do not use any of it to time a purchase: that is a different ' +
        'strategy, and mixing the two means running neither.\n\n' +
        'What it is genuinely for: (1) **can this be exited?** — deep value lives ' +
        'in micro caps where the discount is often just the illiquidity, and the ' +
        'days-to-sell estimate is the one figure here that can properly stop a ' +
        'purchase; (2) **how big is a normal move?**, for choosing a position ' +
        'size; (3) **has it fallen, and from what?**, as context for the "why is ' +
        'it cheap?" question the method already asks — a fact to explain from the ' +
        'filings, not a signal. RSI, MACD and every other timing construct are ' +
        'deliberately absent.\n\n' +
        'Output is plain language by default; pass `detail: "advanced"` for the ' +
        'indicator table. Passing `detail` also remembers the choice across ' +
        'sessions.',
      inputSchema: z.object({
        detail: z
          .enum(['advanced', 'simple'])
          .optional()
          .describe(
            '"simple" is a short plain-language read; "advanced" is the full ' +
              'indicator table with windows and as-of dates. Passing this ALSO ' +
              'stores it as the preference for later calls. Omit it to use the ' +
              'stored preference, which starts as "simple".'
          ),
        liquidityWindow: z
          .number()
          .int()
          .min(5)
          .max(252)
          .default(60)
          .describe('Sessions over which dollar volume is measured.'),
        participationRate: z
          .number()
          .positive()
          .max(1)
          .default(0.1)
          .describe(
            'Share of a session’s dollar volume you are willing to be, when ' +
              'estimating how long an exit takes. Above roughly 0.1 you are ' +
              'setting the price rather than taking it.'
          ),
        positionValue: z
          .number()
          .positive()
          .finite()
          .optional()
          .describe(
            'Dollar size of the position you are contemplating. Without it the ' +
              'days-to-sell estimate is not computed — it is a property of the ' +
              'position, not of the stock.'
          ),
        ticker: z
          .string()
          .min(1)
          .max(12)
          .describe(
            'Ticker. Non-US listings need an exchange suffix, e.g. 7203.TSE.'
          ),
        years: z
          .number()
          .min(1)
          .max(5)
          .default(2)
          .describe(
            'Years of history to request. Two covers the 52-week range and the ' +
              '200-session average with room for holidays; more only helps if you ' +
              'want a longer average.'
          )
      }),
      title: 'Price and volume statistics'
    },
    args =>
      attempt(async () => {
        const blocked = requireCapabilities('prices');
        if (blocked) return blocked;

        // Explicit argument wins and is remembered; omitted falls back to the
        // stored preference, and then to "simple".
        const detail: DetailLevel = resolveDetail(args.detail);
        if (args.detail) setDetailPreference(args.detail);

        const ticker = args.ticker.trim().toUpperCase();
        // Even the request window is computed on Decimals rather than
        // floats: `years` arrives as a JSON number, and 1.1 * 365 is 401.5
        // less an epsilon in binary, which rounds the wrong way.
        const calendarDays =
          out(dec(args.years)?.times(CALENDAR_DAYS_PER_YEAR), 0) ??
          2 * CALENDAR_DAYS_PER_YEAR;
        const fetched = await dailyBars({ calendarDays, ticker });
        const summary = summarise(toBars(fetched.bars), {
          liquidityWindow: args.liquidityWindow,
          participation: dec(args.participationRate),
          positionValue: dec(args.positionValue)
        });

        if (!summary) {
          return text(
            `## ${ticker} — price and volume statistics\n\n` +
              `${fetched.source} returned no usable bars for the ` +
              `${args.years}-year window, so nothing is computed. An empty ` +
              'series is a gap in the evidence, not a set of zeroes.' +
              DISCLAIMER
          );
        }

        const body =
          detail === 'advanced'
            ? advancedBody(summary)
            : simpleBody(summary, args.positionValue, args.participationRate);

        return text(
          header(
            summary,
            fetched.source,
            fetched.adjustment,
            ticker,
            detail === 'advanced'
              ? 'price and volume statistics'
              : 'how tradable is it, and how far has it fallen?'
          ) +
            body +
            DISCLAIMER
        );
      })
  );
}
