import { takeRight } from 'lodash-es';

import { Decimal, dec, div, gtZero, sum } from '../math/decimal.ts';

import type { DailyBar } from '../data/bars.ts';

/**
 * Price-and-volume statistics, computed from daily bars.
 *
 * These sit OUTSIDE the Graham/Schloss method, in the same way the
 * congressional-disclosure tools do, and every caller is told so. Nothing here
 * has any bearing on whether a balance sheet is cheap: an asset test compares
 * price against net current assets, and no arrangement of past prices changes
 * either side of that comparison.
 *
 * What is kept is the handful of statistics that answer a question the method
 * already asks, without implying a forecast:
 *
 * - **Can the position actually be exited?** Median daily dollar volume and a
 *   days-to-liquidate estimate. Deep value lives in micro caps, where the
 *   discount is often just the illiquidity, and a name whose exit takes twenty
 *   sessions at a tenth of its volume is a different proposition from the same
 *   balance sheet in a liquid listing. This is the one statistic here that can
 *   legitimately stop a purchase.
 * - **How large is a normal move?** Average true range and realised volatility,
 *   for sizing and for judging whether a limit offset is meaningful.
 * - **Has this fallen, and from what?** Drawdown from the 52-week high and the
 *   distance above the low, as context for the "why is it cheap?" question the
 *   method already asks. It is a description of what happened, not a signal.
 *
 * Deliberately absent: RSI, MACD, stochastics, Bollinger bands, moving-average
 * crossovers, and every other overbought/oversold or trend-following construct.
 * Their only use is timing, the evidence for which is weak, and for a deep-value
 * book "oversold" is the entry condition by construction — a name that has not
 * fallen would never have reached the screen. An exponential moving average is
 * left out for a plainer reason: it answers the same descriptive question as a
 * simple average with an extra tuning parameter and no extra information.
 *
 * Every function here is pure and takes its bars as a plain array, which is what
 * makes them testable, and every reading carries the bar date it was computed
 * through and the window it used. An indicator whose window is longer than the
 * history available returns `undefined` — never a shorter window quietly
 * relabelled, which is the technical-analysis equivalent of reporting a failed
 * test for a line item the filer never tagged.
 */

/** A bar with its figures parsed into Decimals. Ordered oldest to newest. */
export interface Bar {
  readonly close: Decimal;
  /** ISO date of the session. */
  readonly date: string;
  readonly high: Decimal;
  readonly low: Decimal;
  readonly open: Decimal;
  /** Shares traded. Zero is a real value: the name did not trade that day. */
  readonly volume: Decimal;
}

/** One indicator value, with the bar it was computed through. */
export interface Reading {
  /** Date of the last bar that fed the calculation. */
  readonly asOf: string;
  readonly value: Decimal;
  /** Lookback in sessions. */
  readonly window: number;
}

export interface RangeReading {
  readonly asOf: string;
  /** (high − close) / high. Zero at a new high. */
  readonly drawdownFromHigh: Decimal;
  readonly high: Decimal;
  readonly highDate: string;
  readonly low: Decimal;
  readonly lowDate: string;
  /** (close − low) / low. */
  readonly riseAboveLow: Decimal;
  readonly window: number;
}

export interface LiquidityReading {
  readonly asOf: string;
  /** Mean daily dollar volume. Shown beside the median, never instead of it. */
  readonly meanDollarVolume: Decimal;
  /** Median close × volume. The robust one; see `median`. */
  readonly medianDollarVolume: Decimal;
  /** Sessions in the window on which nothing traded at all. */
  readonly sessionsWithNoTrade: number;
  readonly window: number;
}

export interface MovingAverage {
  /** (close − average) / average. Undefined when the average is zero. */
  readonly distanceFromPrice: Decimal | undefined;
  readonly reading: Reading;
}

export interface TechnicalSummary {
  /** Date of the most recent bar. Everything below is computed through it. */
  readonly asOf: string;
  readonly atr: Reading | undefined;
  /** ATR as a fraction of the latest close, so names are comparable. */
  readonly atrFractionOfPrice: Decimal | undefined;
  readonly barCount: number;
  readonly close: Decimal;
  /** Sessions to exit `positionValue` at `participation` of median volume. */
  readonly daysToLiquidate: Decimal | undefined;
  /** Date of the earliest bar, so the caller can see the history's depth. */
  readonly firstBar: string;
  readonly liquidity: LiquidityReading | undefined;
  readonly movingAverages: readonly MovingAverage[];
  readonly range52Week: RangeReading | undefined;
  /** Annualised standard deviation of daily log returns. */
  readonly volatility: Reading | undefined;
}

export interface TechnicalOptions {
  /** Sessions for the liquidity window. Default 60 — a quarter of trading. */
  readonly liquidityWindow?: number;
  /** Simple-average windows to report. Default 50 and 200. */
  readonly movingAverageWindows?: readonly number[];
  /**
   * Share of a session's dollar volume you are willing to be, for the
   * days-to-liquidate estimate. Default 0.1 — above roughly a tenth of volume
   * you are the price rather than a taker of it.
   */
  readonly participation?: Decimal;
  /** Position size in dollars. Without it days-to-liquidate is not computed. */
  readonly positionValue?: Decimal;
  /** Sessions for volatility and the true range. Defaults 60 and 14. */
  readonly trueRangeWindow?: number;
  readonly volatilityWindow?: number;
}

/**
 * Trading sessions in a year, for annualising a daily standard deviation. 252
 * is the convention; the exact figure varies by a day or two with the holiday
 * calendar, and nothing here is precise enough for that to matter.
 */
const TRADING_DAYS = 252;

const DEFAULT_LIQUIDITY_WINDOW = 60;
const DEFAULT_MOVING_AVERAGES = [50, 200] as const;
const DEFAULT_PARTICIPATION = '0.1';
const DEFAULT_TRUE_RANGE_WINDOW = 14;
const DEFAULT_VOLATILITY_WINDOW = 60;
const SESSIONS_52_WEEKS = 252;

/**
 * Parses upstream bars into Decimals and orders them oldest-first.
 *
 * A bar missing any of its five figures is dropped rather than defaulted: a
 * zero high would silently wreck a true range, and a gap in the series is
 * visible in `barCount` where a fabricated bar would not be. Volume is the one
 * field where zero is meaningful — a micro cap that did not trade — so it is
 * kept.
 *
 * Ordering is oldest-first on the ISO date, which sorts lexicographically, so a
 * plain string comparator is exact. `sortBy` would do here, but every other
 * ordering in this file is on Decimals — where lodash's `>` falls through to
 * `Decimal.valueOf()` and compares the numbers as strings — so the file uses
 * one comparator style throughout rather than two that look interchangeable and
 * are not.
 */
export function toBars(raw: readonly DailyBar[]): Bar[] {
  const parsed: Bar[] = [];

  for (const bar of raw) {
    const close = dec(bar.close);
    const high = dec(bar.high);
    const low = dec(bar.low);
    const open = dec(bar.open);
    const volume = dec(bar.volume);
    if (!close || !high || !low || !open || !volume) continue;
    if (!gtZero(close) || !gtZero(high) || !gtZero(low)) continue;
    parsed.push({
      close,
      date: bar.date.slice(0, 10),
      high,
      low,
      open,
      volume
    });
  }

  return parsed.toSorted((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );
}

/**
 * The middle value, averaging the two middle ones on an even count.
 *
 * Median rather than mean for dollar volume, because the mean is exactly the
 * wrong statistic for a thin name: one block trade or one index-rebalance day
 * lifts a 20,000-dollar-a-day stock to a reported 200,000, and the position
 * sized against that figure is the one that cannot be sold.
 */
function median(values: readonly Decimal[]): Decimal | undefined {
  if (values.length === 0) return undefined;
  const ordered = values.toSorted((a, b) => a.cmp(b));
  const middle = Math.floor(ordered.length / 2);
  const upper = ordered[middle];
  if (!upper) return undefined;
  if (ordered.length % 2 === 1) return upper;
  const lower = ordered[middle - 1];
  return lower ? lower.plus(upper).div(2) : upper;
}

/** The arithmetic mean of a non-empty list. */
function mean(values: readonly Decimal[]): Decimal | undefined {
  return div(sum(...values), dec(values.length));
}

/** The last `window` bars, or undefined when there are not that many. */
function window(bars: readonly Bar[], size: number): Bar[] | undefined {
  if (!Number.isInteger(size) || size < 1 || bars.length < size) {
    return undefined;
  }
  return takeRight(bars, size);
}

/**
 * A simple moving average of the close.
 *
 * The question it answers is descriptive: where does today's price sit against
 * its own recent history? It is a reference level for "how far has this
 * fallen", not a signal — a price crossing its average is an arithmetic fact
 * about the past, and the literature claiming it forecasts anything does not
 * survive transaction costs or out-of-sample testing.
 */
export function simpleMovingAverage(
  bars: readonly Bar[],
  size: number
): Reading | undefined {
  const slice = window(bars, size);
  const last = slice?.at(-1);
  if (!slice || !last) return undefined;

  const average = mean(slice.map(bar => bar.close));
  return average
    ? { asOf: last.date, value: average, window: size }
    : undefined;
}

/**
 * True range for a bar: the widest of today's range, and today's high or low
 * measured against yesterday's close.
 *
 * The overnight legs are the point of the statistic. A name that gaps from
 * 10.00 to 8.50 and trades in a ten-cent range all day had a violent session,
 * and high-minus-low alone reports ten cents.
 */
function trueRange(bar: Bar, previousClose: Decimal): Decimal {
  return Decimal.max(
    bar.high.minus(bar.low),
    bar.high.minus(previousClose).abs(),
    bar.low.minus(previousClose).abs()
  );
}

/**
 * Average true range, Wilder-smoothed.
 *
 * The question it answers is "how large is a normal day here?", in dollars —
 * which is what a limit offset and a stop distance are quoted in, and what
 * tells you whether a 3% move in a name is news or noise.
 *
 * Wilder's own recursion, seeded with the simple average of the first `size`
 * true ranges and then smoothed across every remaining bar. That means the
 * value depends on the whole series supplied, not only the last `size` bars —
 * which is what the indicator is, and why the bars used are stated.
 */
export function averageTrueRange(
  bars: readonly Bar[],
  size = DEFAULT_TRUE_RANGE_WINDOW
): Reading | undefined {
  const last = bars.at(-1);
  // One extra bar beyond the window: the first true range needs a prior close.
  if (!Number.isInteger(size) || size < 1 || bars.length < size + 1 || !last) {
    return undefined;
  }

  const ranges: Decimal[] = [];
  for (const [index, bar] of bars.entries()) {
    const previous = index === 0 ? undefined : bars[index - 1];
    if (previous) ranges.push(trueRange(bar, previous.close));
  }

  const seed = mean(ranges.slice(0, size));
  if (!seed) return undefined;

  let average = seed;
  for (const range of ranges.slice(size)) {
    average = average
      .times(size - 1)
      .plus(range)
      .div(size);
  }

  return { asOf: last.date, value: average, window: size };
}

/**
 * Annualised standard deviation of daily log returns.
 *
 * The comparable-across-names counterpart to ATR: ATR is in dollars and says
 * what a session looks like, this is a fraction and says whether a 12% position
 * in one name carries the same risk as 12% in another. Used for sizing, not for
 * prediction — realised volatility is a description of the window it was
 * measured over and is not a forecast of the next one.
 *
 * Log returns because they add across periods and treat a halving and a
 * doubling symmetrically; the sample denominator (n − 1) because these are a
 * sample of the name's behaviour, not its population.
 */
export function realisedVolatility(
  bars: readonly Bar[],
  size = DEFAULT_VOLATILITY_WINDOW
): Reading | undefined {
  // n returns need n + 1 closes, and a standard deviation needs at least two.
  const slice = window(bars, size + 1);
  const last = slice?.at(-1);
  if (!slice || !last || size < 2) return undefined;

  const returns: Decimal[] = [];
  for (const [index, bar] of slice.entries()) {
    const previous = index === 0 ? undefined : slice[index - 1];
    if (!previous) continue;
    const ratio = div(bar.close, previous.close);
    // A non-positive close has no logarithm. Bars are filtered for that in
    // `toBars`, so reaching here means the series is not what it claims.
    if (!gtZero(ratio)) return undefined;
    returns.push(ratio.ln());
  }

  const average = mean(returns);
  if (!average) return undefined;

  const squared = returns.map(value => value.minus(average).pow(2));
  const variance = div(sum(...squared), dec(returns.length - 1));
  if (!variance) return undefined;

  return {
    asOf: last.date,
    value: variance.sqrt().times(new Decimal(TRADING_DAYS).sqrt()),
    window: size
  };
}

/**
 * Highest high and lowest low over a window, with the current price's distance
 * from each.
 *
 * This is the honest form of "has it fallen?" — the question the method already
 * asks as "why is it cheap?". A 70% drawdown does not make a name cheap and a
 * new high does not make it expensive; both are facts to go and find the cause
 * of in the filings.
 *
 * `maxBy`/`minBy` from lodash are avoided deliberately: they compare with `>`,
 * which on a Decimal falls through to a string comparison and quietly returns
 * the wrong bar.
 */
export function priceRange(
  bars: readonly Bar[],
  size = SESSIONS_52_WEEKS
): RangeReading | undefined {
  const slice = window(bars, size);
  const last = slice?.at(-1);
  if (!slice || !last) return undefined;

  let peak = slice[0];
  let trough = slice[0];
  if (!peak || !trough) return undefined;
  for (const bar of slice) {
    if (bar.high.gt(peak.high)) peak = bar;
    if (bar.low.lt(trough.low)) trough = bar;
  }

  const drawdown = div(peak.high.minus(last.close), peak.high);
  const rise = div(last.close.minus(trough.low), trough.low);
  if (!drawdown || !rise) return undefined;

  return {
    asOf: last.date,
    drawdownFromHigh: drawdown,
    high: peak.high,
    highDate: peak.date,
    low: trough.low,
    lowDate: trough.date,
    riseAboveLow: rise,
    window: size
  };
}

/**
 * Dollar volume over a window.
 *
 * Dollar rather than share volume because share counts are not comparable
 * across prices: 100,000 shares of a two-dollar stock is a position you can
 * build and 100,000 shares of a 300-dollar one is not.
 */
export function liquidity(
  bars: readonly Bar[],
  size = DEFAULT_LIQUIDITY_WINDOW
): LiquidityReading | undefined {
  const slice = window(bars, size);
  const last = slice?.at(-1);
  if (!slice || !last) return undefined;

  const dollars = slice.map(bar => bar.close.times(bar.volume));
  const medianDollars = median(dollars);
  const meanDollars = mean(dollars);
  if (!medianDollars || !meanDollars) return undefined;

  return {
    asOf: last.date,
    meanDollarVolume: meanDollars,
    medianDollarVolume: medianDollars,
    sessionsWithNoTrade: slice.filter(bar => !gtZero(bar.volume)).length,
    window: size
  };
}

/**
 * Sessions needed to trade out of a position at a given share of daily volume.
 *
 * The most defensible number in this file, and the only one that can properly
 * veto a purchase. Graham's discount is frequently just the illiquidity, and a
 * position that takes thirty sessions to exit is not really a position in a
 * liquid security at all — the exit price is whatever the name does over those
 * thirty days, which is precisely the risk the balance sheet was supposed to
 * bound. Schloss's answer was to own many small positions; knowing this number
 * before buying is what makes "small" a size rather than a hope.
 *
 * Undefined when the name has no volume to speak of, which is itself the
 * answer: it cannot be exited on any schedule this arithmetic can express.
 */
export function daysToLiquidate(
  positionValue: Decimal | undefined,
  medianDollarVolume: Decimal | undefined,
  participation: Decimal | undefined
): Decimal | undefined {
  if (!gtZero(positionValue) || !gtZero(participation)) return undefined;
  return div(positionValue, medianDollarVolume?.times(participation));
}

/** Every statistic above, computed from one series. */
export function summarise(
  bars: readonly Bar[],
  options: TechnicalOptions = {}
): TechnicalSummary | undefined {
  const last = bars.at(-1);
  const first = bars[0];
  if (!last || !first) return undefined;

  const liquidityWindow = options.liquidityWindow ?? DEFAULT_LIQUIDITY_WINDOW;
  const participation = options.participation ?? dec(DEFAULT_PARTICIPATION);
  const atr = averageTrueRange(
    bars,
    options.trueRangeWindow ?? DEFAULT_TRUE_RANGE_WINDOW
  );
  const book = liquidity(bars, liquidityWindow);

  const movingAverages: MovingAverage[] = [];
  for (const size of options.movingAverageWindows ?? DEFAULT_MOVING_AVERAGES) {
    const reading = simpleMovingAverage(bars, size);
    if (!reading) continue;
    movingAverages.push({
      distanceFromPrice: div(last.close.minus(reading.value), reading.value),
      reading
    });
  }

  return {
    asOf: last.date,
    atr,
    atrFractionOfPrice: div(atr?.value, last.close),
    barCount: bars.length,
    close: last.close,
    daysToLiquidate: daysToLiquidate(
      options.positionValue,
      book?.medianDollarVolume,
      participation
    ),
    firstBar: first.date,
    liquidity: book,
    movingAverages,
    range52Week: priceRange(bars, SESSIONS_52_WEEKS),
    volatility: realisedVolatility(
      bars,
      options.volatilityWindow ?? DEFAULT_VOLATILITY_WINDOW
    )
  };
}
