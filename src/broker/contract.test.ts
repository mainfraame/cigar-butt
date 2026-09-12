import { describe, expect, it } from 'vitest';

import { Decimal } from '../math/decimal.ts';
import { netPositions, type Position } from './contract.ts';

const lot = (over: Partial<Position> = {}): Position => ({
  asOf: '2026-09-11',
  costBasis: new Decimal(100),
  price: new Decimal(10),
  shares: new Decimal(10),
  ticker: 'AAA',
  unrealisedGain: new Decimal(5),
  ...over
});

describe('netPositions', () => {
  it('leaves distinct symbols alone', () => {
    const netted = netPositions([lot(), lot({ ticker: 'BBB' })]);
    expect(netted).toHaveLength(2);
  });

  it('sums shares across lots of one symbol', () => {
    // Brokers report lots, not positions. Keying without netting would keep
    // whichever came last and silently discard the rest.
    const netted = netPositions([
      lot({ shares: new Decimal(10) }),
      lot({ shares: new Decimal(5) })
    ]);

    expect(netted).toHaveLength(1);
    expect(netted[0]?.shares.toNumber()).toBe(15);
  });

  it('nets a long and a short leg of the same symbol', () => {
    const netted = netPositions([
      lot({ shares: new Decimal(10) }),
      lot({ shares: new Decimal(-4) })
    ]);

    expect(netted[0]?.shares.toNumber()).toBe(6);
  });

  it('takes the price and date of the most recent mark', () => {
    // A stale mark is the worse of the two.
    const netted = netPositions([
      lot({ asOf: '2020-01-01', price: new Decimal(5) }),
      lot({ asOf: '2026-09-11', price: new Decimal(20) })
    ]);

    expect(netted[0]?.price.toNumber()).toBe(20);
    expect(netted[0]?.asOf).toBe('2026-09-11');
  });

  it('sums cost basis and unrealised gain across lots', () => {
    const netted = netPositions([
      lot({ costBasis: new Decimal(100), unrealisedGain: new Decimal(5) }),
      lot({ costBasis: new Decimal(50), unrealisedGain: new Decimal(3) })
    ]);

    expect(netted[0]?.costBasis?.toNumber()).toBe(150);
    expect(netted[0]?.unrealisedGain?.toNumber()).toBe(8);
  });

  it('keeps an absent cost basis absent rather than treating it as zero', () => {
    // undefined means "the broker did not say", which is not the same claim as
    // "it cost nothing".
    const netted = netPositions([lot({ costBasis: undefined })]);
    expect(netted[0]?.costBasis).toBeUndefined();

    const mixed = netPositions([
      lot({ costBasis: undefined }),
      lot({ costBasis: new Decimal(50) })
    ]);
    expect(mixed[0]?.costBasis?.toNumber()).toBe(50);
  });

  it('returns an empty list for an empty book', () => {
    expect(netPositions([])).toEqual([]);
  });
});
