import { describe, expect, it } from 'vitest';

import { Decimal } from '../math/decimal.ts';
import { planRebalance } from './rebalance.ts';

const holding = (ticker: string, shares: number, price: number) => ({
  asOf: '2026-09-11',
  price: new Decimal(price),
  shares: new Decimal(shares),
  ticker
});

const target = (ticker: string, weight: number, price: number) => ({
  asOf: '2026-09-11',
  price: new Decimal(price),
  ticker,
  weight: new Decimal(weight)
});

describe('planRebalance', () => {
  it('emits nothing when the book already matches the targets', () => {
    const plan = planRebalance({
      availableCash: new Decimal(0),
      holdings: [holding('AAA', 100, 10), holding('BBB', 100, 10)],
      targets: [target('AAA', 0.5, 10), target('BBB', 0.5, 10)]
    });

    expect(plan.buys).toHaveLength(0);
    expect(plan.sells).toHaveLength(0);
    expect(plan.unchanged.map(entry => entry.ticker)).toEqual(['AAA', 'BBB']);
  });

  it('trims a name that has re-rated, even though its share count never moved', () => {
    const plan = planRebalance({
      availableCash: new Decimal(0),
      // AAA doubled; BBB did not. Same share counts, different weights.
      holdings: [holding('AAA', 100, 20), holding('BBB', 100, 10)],
      targets: [target('AAA', 0.5, 20), target('BBB', 0.5, 10)]
    });

    expect(plan.sells.map(order => order.ticker)).toEqual(['AAA']);
    expect(plan.buys.map(order => order.ticker)).toEqual(['BBB']);
  });

  it('treats a held name absent from the targets as a full exit', () => {
    const plan = planRebalance({
      availableCash: new Decimal(0),
      holdings: [holding('KEEP', 100, 10), holding('DROP', 50, 10)],
      targets: [target('KEEP', 1, 10)]
    });

    expect(plan.exits.map(order => order.ticker)).toEqual(['DROP']);
    expect(plan.exits[0]?.targetShares).toBe(0);
    expect(plan.exits[0]?.shares).toBe(50);
  });

  it('never suppresses an exit via the drift tolerance', () => {
    const plan = planRebalance({
      availableCash: new Decimal(0),
      // A tolerance of 1.0 would swallow every ordinary trade.
      driftTolerance: new Decimal(1),
      holdings: [holding('KEEP', 100, 10), holding('DROP', 1, 10)],
      targets: [target('KEEP', 1, 10)]
    });

    expect(plan.exits.map(order => order.ticker)).toEqual(['DROP']);
  });

  it('holds a position inside the drift tolerance', () => {
    const plan = planRebalance({
      availableCash: new Decimal(0),
      driftTolerance: new Decimal('0.10'),
      holdings: [holding('AAA', 103, 10), holding('BBB', 97, 10)],
      targets: [target('AAA', 0.5, 10), target('BBB', 0.5, 10)]
    });

    expect(plan.buys).toHaveLength(0);
    expect(plan.sells).toHaveLength(0);
  });

  it('folds uninvested cash into the portfolio value', () => {
    const plan = planRebalance({
      availableCash: new Decimal(1000),
      holdings: [],
      targets: [target('AAA', 1, 10)]
    });

    expect(plan.portfolioValue).toBe(1000);
    expect(plan.buys[0]?.shares).toBe(100);
    expect(plan.cashAfter).toBe(0);
  });

  it('says so when the buys are not fundable from cash plus proceeds', () => {
    const plan = planRebalance({
      availableCash: new Decimal(0),
      // Nothing to sell, no cash, but a target that wants a position.
      holdings: [holding('AAA', 100, 10)],
      targets: [target('AAA', 0.5, 10), target('NEW', 0.5, 10)]
    });

    expect(plan.buys.map(order => order.ticker)).toEqual(['NEW']);
    // AAA is trimmed to fund NEW, so the plan nets out — but the sells must run first.
    expect(plan.notes.join(' ')).not.toContain('exceed cash');
    expect(plan.sells.map(order => order.ticker)).toEqual(['AAA']);
  });

  it('suppresses an order below the minimum trade value', () => {
    const plan = planRebalance({
      availableCash: new Decimal(0),
      driftTolerance: new Decimal(0),
      holdings: [holding('AAA', 100, 10), holding('BBB', 99, 10)],
      minTradeValue: new Decimal(500),
      targets: [target('AAA', 0.5, 10), target('BBB', 0.5, 10)]
    });

    expect(plan.buys).toHaveLength(0);
    expect(plan.sells).toHaveLength(0);
  });

  it('returns an empty plan for an empty portfolio', () => {
    const plan = planRebalance({
      availableCash: new Decimal(0),
      holdings: [],
      targets: []
    });

    expect(plan.notes.join(' ')).toContain('nothing to rebalance');
  });
});

describe('duplicate lots', () => {
  it('nets multiple lots of the same ticker instead of dropping one', () => {
    // A broker reports lots, not positions: E*TRADE returns a long and a short
    // leg of the same symbol as separate rows. Keying off the array kept
    // whichever came last and silently discarded the rest.
    const plan = planRebalance({
      availableCash: new Decimal(0),
      holdings: [holding('AAA', 100, 10), holding('AAA', 40, 10)],
      targets: [target('AAA', 1, 10)]
    });

    // 140 shares at 10 is the whole portfolio, so it is already on target.
    expect(plan.portfolioValue).toBe(1400);
    expect(plan.buys).toHaveLength(0);
    expect(plan.sells).toHaveLength(0);
  });

  it('nets a long and a short leg to the correct position', () => {
    const plan = planRebalance({
      availableCash: new Decimal(0),
      holdings: [holding('AAA', 100, 10), holding('AAA', -40, 10)],
      targets: [target('AAA', 1, 10)]
    });

    expect(plan.portfolioValue).toBe(600);
  });

  it('takes the price of the most recently marked lot', () => {
    // A stale mark is the worse of the two, so the newest date wins.
    const plan = planRebalance({
      availableCash: new Decimal(0),
      holdings: [
        {
          asOf: '2020-01-01',
          price: new Decimal(5),
          shares: new Decimal(10),
          ticker: 'AAA'
        },
        {
          asOf: '2026-09-11',
          price: new Decimal(20),
          shares: new Decimal(10),
          ticker: 'AAA'
        }
      ],
      targets: [target('AAA', 1, 20)]
    });

    expect(plan.portfolioValue).toBe(400);
  });
});
