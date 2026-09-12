import { describe, expect, it } from 'vitest';

import { Decimal } from '../math/decimal.ts';
import {
  averageTrueRange,
  daysToLiquidate,
  liquidity,
  priceRange,
  realisedVolatility,
  simpleMovingAverage,
  summarise,
  toBars,
  type Bar
} from './technical.ts';

import type { DailyBar } from '../data/bars.ts';

/**
 * Bars are built from plain numbers and run through `toBars`, which is the real
 * boundary: if a figure can be got wrong by parsing, these tests get it wrong
 * the same way the server would.
 */
function bars(
  rows: readonly (readonly [string, number, number, number, number, number])[]
): Bar[] {
  return toBars(
    rows.map(([date, open, high, low, close, volume]): DailyBar => ({
      close,
      date,
      high,
      low,
      open,
      volume
    }))
  );
}

const DAY_MS = 86_400_000;
const EPOCH = Date.parse('2026-01-01T00:00:00Z');

/** A flat series, for the cases where only the count matters. */
function flat(count: number, close = 10, volume = 1000): Bar[] {
  return bars(
    Array.from({ length: count }, (_, index) => {
      const date = new Date(EPOCH + index * DAY_MS).toISOString().slice(0, 10);
      return [date, close, close, close, close, volume] as const;
    })
  );
}

describe('toBars', () => {
  it('orders oldest first and drops bars missing a figure', () => {
    const series = toBars([
      { close: 11, date: '2026-03-02', high: 11, low: 10, open: 10, volume: 5 },
      { close: 10, date: '2026-03-01', high: 10, low: 9, open: 9, volume: 5 },
      // A zero high is not a bar, it is a broken row. Dropping it leaves a
      // visible gap; keeping it would silently wreck the true range.
      { close: 12, date: '2026-03-03', high: 0, low: 11, open: 11, volume: 5 }
    ]);

    expect(series.map(bar => bar.date)).toEqual(['2026-03-01', '2026-03-02']);
  });

  it('keeps a zero-volume session, because not trading is a fact', () => {
    const series = bars([['2026-03-01', 10, 10, 10, 10, 0]]);
    expect(series).toHaveLength(1);
    expect(series[0]?.volume.isZero()).toBe(true);
  });
});

describe('simpleMovingAverage', () => {
  it('averages the last n closes', () => {
    // Closes 10, 11, 12, 13, 14. Last three average (12 + 13 + 14) / 3 = 13.
    const series = bars([
      ['2026-01-01', 10, 10, 10, 10, 100],
      ['2026-01-02', 11, 11, 11, 11, 100],
      ['2026-01-03', 12, 12, 12, 12, 100],
      ['2026-01-04', 13, 13, 13, 13, 100],
      ['2026-01-05', 14, 14, 14, 14, 100]
    ]);

    const reading = simpleMovingAverage(series, 3);
    expect(reading?.value.toString()).toBe('13');
    expect(reading?.asOf).toBe('2026-01-05');
    expect(reading?.window).toBe(3);
  });

  it('returns undefined rather than a shorter window', () => {
    // 150 sessions is not a 200-session average, and calling it one is the
    // whole failure this assertion exists to prevent.
    expect(simpleMovingAverage(flat(150), 200)).toBeUndefined();
    expect(simpleMovingAverage(flat(200), 200)).toBeDefined();
    expect(simpleMovingAverage([], 5)).toBeUndefined();
  });

  /**
   * The decimal.js rule, tested where a float implementation actually differs.
   *
   * 0.1 + 0.2 + 0.3 is 0.6000000000000001 in binary floating point, and a third
   * of that is 0.20000000000000004 — strictly greater than 0.2. A price sitting
   * exactly on its own average would therefore read as *above* it, which is the
   * class of bug the rule exists to stop: every figure here is compared against
   * a line, and being on the wrong side of one is a wrong answer.
   */
  it('is exact where binary floating point is not', () => {
    const series = bars([
      ['2026-01-01', 0.1, 0.1, 0.1, 0.1, 100],
      ['2026-01-02', 0.2, 0.2, 0.2, 0.2, 100],
      ['2026-01-03', 0.3, 0.3, 0.3, 0.3, 100]
    ]);

    const reading = simpleMovingAverage(series, 3);
    expect(reading?.value.toString()).toBe('0.2');
    expect(reading?.value.eq('0.2')).toBe(true);

    // What the same arithmetic gives on numbers, for the avoidance of doubt.
    const asFloats = (0.1 + 0.2 + 0.3) / 3;
    expect(asFloats).toBeGreaterThan(0.2);
    expect(reading?.value.eq(asFloats)).toBe(false);
  });
});

describe('averageTrueRange', () => {
  /**
   * Worked by hand, Wilder's method, window 3.
   *
   *   bar 1  h 10.0  l  9.0  c  9.5   (no prior close, so no true range)
   *   bar 2  h 11.0  l 10.0  c 10.5   TR = max(1.0, |11.0−9.5|, |10.0−9.5|) = 1.5
   *   bar 3  h 12.0  l 10.0  c 11.0   TR = max(2.0, |12.0−10.5|, |10.0−10.5|) = 2.0
   *   bar 4  h 11.5  l 10.5  c 11.0   TR = max(1.0, |11.5−11.0|, |10.5−11.0|) = 1.0
   *   bar 5  h 13.0  l 11.0  c 12.5   TR = max(2.0, |13.0−11.0|, |11.0−11.0|) = 2.0
   *
   * Seed = (1.5 + 2.0 + 1.0) / 3 = 1.5. One bar remains, so
   * ATR = (1.5 × 2 + 2.0) / 3 = 5 / 3.
   */
  const worked = bars([
    ['2026-01-01', 9.5, 10, 9, 9.5, 100],
    ['2026-01-02', 10.5, 11, 10, 10.5, 100],
    ['2026-01-03', 11, 12, 10, 11, 100],
    ['2026-01-04', 11, 11.5, 10.5, 11, 100],
    ['2026-01-05', 12.5, 13, 11, 12.5, 100]
  ]);

  it('matches the worked example', () => {
    const reading = averageTrueRange(worked, 3);
    expect(reading?.value.toFixed(10)).toBe(new Decimal(5).div(3).toFixed(10));
    expect(reading?.asOf).toBe('2026-01-05');
  });

  it('counts the overnight gap, not just the session range', () => {
    // High minus low is a tenth; the gap down from 10.00 to 8.50 is not.
    const gapped = bars([
      ['2026-01-01', 10, 10, 10, 10, 100],
      ['2026-01-02', 8.5, 8.6, 8.5, 8.5, 100]
    ]);
    expect(averageTrueRange(gapped, 1)?.value.toString()).toBe('1.5');
  });

  it('needs one more bar than its window, for the prior close', () => {
    expect(averageTrueRange(worked.slice(0, 3), 3)).toBeUndefined();
    expect(averageTrueRange(worked.slice(0, 4), 3)).toBeDefined();
  });
});

describe('realisedVolatility', () => {
  /**
   * Closes 100, 200, 100, 200, 100 give four log returns of ±ln 2. Their mean
   * is zero, so the sample variance is 4 (ln 2)² / 3 = 0.640604 and the daily
   * standard deviation is 2 ln 2 / √3 = 0.8003774. Annualised by √252 =
   * 15.8745079 that is 12.705598 — worked out independently of the code under
   * test, which is the only version of this assertion worth having.
   */
  it('matches the worked example', () => {
    const series = bars([
      ['2026-01-01', 100, 100, 100, 100, 100],
      ['2026-01-02', 200, 200, 200, 200, 100],
      ['2026-01-03', 100, 100, 100, 100, 100],
      ['2026-01-04', 200, 200, 200, 200, 100],
      ['2026-01-05', 100, 100, 100, 100, 100]
    ]);

    const reading = realisedVolatility(series, 4);
    expect(reading?.value.toNumber()).toBeCloseTo(12.705598, 5);
    expect(reading?.window).toBe(4);
    expect(reading?.asOf).toBe('2026-01-05');
  });

  it('is zero for a flat series rather than undefined', () => {
    // A flat window is a real answer: nothing moved. Only missing history is
    // "could not be computed".
    expect(realisedVolatility(flat(10), 5)?.value.isZero()).toBe(true);
  });

  it('needs n + 1 closes for n returns', () => {
    expect(realisedVolatility(flat(5), 5)).toBeUndefined();
    expect(realisedVolatility(flat(6), 5)).toBeDefined();
  });
});

describe('priceRange', () => {
  const series = bars([
    ['2026-01-01', 10, 10, 9, 9.5, 100],
    ['2026-01-02', 10, 11, 10, 10.5, 100],
    ['2026-01-03', 11, 12, 10, 11, 100],
    ['2026-01-04', 11, 11.5, 10.5, 11, 100],
    ['2026-01-05', 12.5, 13, 11, 12.5, 100]
  ]);

  it('reports the extremes with the sessions they were set on', () => {
    const range = priceRange(series, 5);
    expect(range?.high.toString()).toBe('13');
    expect(range?.highDate).toBe('2026-01-05');
    expect(range?.low.toString()).toBe('9');
    expect(range?.lowDate).toBe('2026-01-01');
    // (13 − 12.5) / 13 and (12.5 − 9) / 9.
    expect(range?.drawdownFromHigh.toNumber()).toBeCloseTo(0.0384615, 6);
    expect(range?.riseAboveLow.toNumber()).toBeCloseTo(0.3888889, 6);
  });

  it('will not call five sessions a 52-week range', () => {
    expect(priceRange(series)).toBeUndefined();
  });
});

describe('liquidity', () => {
  it('reports a median that one block trade cannot move', () => {
    // Four ordinary sessions of $10,000 and one block trade of $1,000,000.
    // The mean says $208,000 a day; the median says $10,000, which is what you
    // could actually sell into.
    const series = bars([
      ['2026-01-01', 10, 10, 10, 10, 1000],
      ['2026-01-02', 10, 10, 10, 10, 1000],
      ['2026-01-03', 10, 10, 10, 10, 1000],
      ['2026-01-04', 10, 10, 10, 10, 1000],
      ['2026-01-05', 10, 10, 10, 10, 100_000]
    ]);

    const book = liquidity(series, 5);
    expect(book?.medianDollarVolume.toString()).toBe('10000');
    expect(book?.meanDollarVolume.toString()).toBe('208000');
    expect(book?.sessionsWithNoTrade).toBe(0);
  });

  it('counts sessions on which the name did not trade', () => {
    const series = bars([
      ['2026-01-01', 10, 10, 10, 10, 0],
      ['2026-01-02', 10, 10, 10, 10, 0],
      ['2026-01-03', 10, 10, 10, 10, 500]
    ]);
    const book = liquidity(series, 3);
    expect(book?.sessionsWithNoTrade).toBe(2);
    expect(book?.medianDollarVolume.isZero()).toBe(true);
  });

  it('is undefined without a full window', () => {
    expect(liquidity(flat(4), 5)).toBeUndefined();
  });

  it('multiplies price by volume exactly', () => {
    // 0.07 × 3 is 0.21000000000000002 on floats; a liquidity floor of 0.21
    // would then be cleared by a name that does not clear it.
    const series = bars([['2026-01-01', 0.07, 0.07, 0.07, 0.07, 3]]);
    expect(liquidity(series, 1)?.medianDollarVolume.toString()).toBe('0.21');
  });
});

describe('daysToLiquidate', () => {
  it('divides the position by the share of volume you are willing to be', () => {
    // $100,000 against $10,000 a day, taking a tenth of it: 100 sessions.
    const sessions = daysToLiquidate(
      new Decimal(100_000),
      new Decimal(10_000),
      new Decimal('0.1')
    );
    expect(sessions?.toString()).toBe('100');
  });

  it('is undefined rather than Infinity when nothing trades', () => {
    // The division that would be by zero. An Infinity in a table is a wrong
    // answer wearing a number's clothes; undefined says "no such schedule".
    expect(
      daysToLiquidate(new Decimal(100_000), new Decimal(0), new Decimal('0.1'))
    ).toBeUndefined();
    expect(
      daysToLiquidate(new Decimal(100_000), undefined, new Decimal('0.1'))
    ).toBeUndefined();
  });

  it('is undefined without a position size, because it is not a stock property', () => {
    expect(
      daysToLiquidate(undefined, new Decimal(10_000), new Decimal('0.1'))
    ).toBeUndefined();
  });
});

describe('summarise', () => {
  it('is undefined for an empty series', () => {
    expect(summarise([])).toBeUndefined();
  });

  it('reports only the averages the history supports', () => {
    const summary = summarise(flat(60), { liquidityWindow: 60 });
    expect(summary?.movingAverages.map(entry => entry.reading.window)).toEqual([
      50
    ]);
    expect(summary?.range52Week).toBeUndefined();
    expect(summary?.barCount).toBe(60);
    expect(summary?.asOf).toBe(summary?.liquidity?.asOf);
  });

  it('carries the position through to the exit estimate', () => {
    const summary = summarise(flat(60, 10, 1000), {
      liquidityWindow: 60,
      participation: new Decimal('0.1'),
      positionValue: new Decimal(50_000)
    });
    // $10,000 a day, a tenth of it, $50,000 to sell: 50 sessions.
    expect(summary?.daysToLiquidate?.toString()).toBe('50');
  });
});
