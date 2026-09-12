import { describe, expect, it } from 'vitest';

import { dec } from '../math/decimal.ts';
import { checkShareCounts } from './shares.ts';

const d = (value: number) => dec(value)!;

describe('checkShareCounts', () => {
  it('catches an ADR bundling ratio', () => {
    // Amarin: the 10-Q counts ordinary shares, the quote is per ADS, and
    // twenty ordinaries make one ADS. Dividing the price by the ordinary
    // count reported P/TBV of 13.07 on a company trading at 0.66x book.
    const check = checkShareCounts(d(420_044_022), d(21_122_834));

    expect(check.inconsistent).toBe(true);
    expect(check.impliedUnit).toBe(20);
  });

  it('passes two counts that merely differ by a buyback', () => {
    const check = checkShareCounts(d(31_949_785), d(32_100_000));

    expect(check.inconsistent).toBe(false);
    expect(check.impliedUnit).toBeUndefined();
  });

  it('flags a large disagreement that is not a whole ratio', () => {
    // Still unsafe, but the cause is not a bundling ratio — say so by
    // leaving impliedUnit undefined rather than rounding to something tidy.
    const check = checkShareCounts(d(100_000_000), d(63_000_000));

    expect(check.inconsistent).toBe(true);
    expect(check.impliedUnit).toBeUndefined();
  });

  it('reports no cross-check rather than a clean one when a count is missing', () => {
    expect(checkShareCounts(undefined, d(1000)).ratio).toBeUndefined();
    expect(checkShareCounts(d(1000), undefined).ratio).toBeUndefined();
    expect(checkShareCounts(d(1000), undefined).inconsistent).toBe(false);
  });

  it('ignores a zero count rather than dividing by it', () => {
    expect(checkShareCounts(d(1000), d(0)).ratio).toBeUndefined();
  });
});
