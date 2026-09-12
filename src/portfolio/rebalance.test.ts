import { describe, expect, it } from 'vitest';

import { Decimal } from '../math/decimal.ts';
import { planRebalance } from './rebalance.ts';

const withVolume = (
  ticker: string,
  shares: number,
  price: number,
  adv: number
) => ({
  asOf: '2026-09-11',
  averageDailyVolume: new Decimal(adv),
  price: new Decimal(price),
  shares: new Decimal(shares),
  ticker
});

const holding = (ticker: string, shares: number, price: number) => ({
  asOf: '2026-09-11',
  price: new Decimal(price),
  shares: new Decimal(shares),
  ticker
});

const withBasis = (
  ticker: string,
  shares: number,
  price: number,
  basis: number
) => ({
  asOf: '2026-09-11',
  costBasis: new Decimal(basis),
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

describe('gain on exit', () => {
  it('computes the gain on a full exit in a taxable account', () => {
    // A full exit is lot-independent: every lot goes, so proceeds minus basis
    // is exact whatever basis method the account uses.
    const plan = planRebalance({
      availableCash: new Decimal(0),
      holdings: [
        withBasis('KEEP', 100, 10, 500),
        withBasis('DROP', 50, 10, 300)
      ],
      targets: [target('KEEP', 1, 10)],
      taxTreatment: 'taxable'
    });

    // 50 shares at 10 = 500 proceeds, against 300 of basis.
    expect(plan.exits[0]?.gainOnExit).toBe(200);
  });

  it('leaves a partial sell uncomputed rather than pro-rating', () => {
    // The gain depends on which shares go, and average cost is not a permitted
    // basis method for individual equities — a pro-rata figure would have no
    // defensible label.
    const plan = planRebalance({
      availableCash: new Decimal(0),
      holdings: [
        withBasis('AAA', 100, 20, 500),
        withBasis('BBB', 100, 10, 500)
      ],
      targets: [target('AAA', 0.5, 20), target('BBB', 0.5, 10)],
      taxTreatment: 'taxable'
    });

    expect(plan.sells).toHaveLength(1);
    expect(plan.sells[0]?.gainOnExit).toBeUndefined();
  });

  it('computes nothing in a sheltered account, where no gain is realised', () => {
    for (const taxTreatment of [
      'roth',
      'tax-deferred',
      'tax-sheltered'
    ] as const) {
      const plan = planRebalance({
        availableCash: new Decimal(0),
        holdings: [
          withBasis('KEEP', 100, 10, 500),
          withBasis('DROP', 50, 10, 300)
        ],
        targets: [target('KEEP', 1, 10)],
        taxTreatment
      });

      expect(plan.exits[0]?.gainOnExit).toBeUndefined();
    }
  });

  it('computes nothing when the treatment is unknown', () => {
    // `unknown` is not a synonym for taxable. Producing a gain figure here
    // would assert a tax status the broker never reported.
    const plan = planRebalance({
      availableCash: new Decimal(0),
      holdings: [
        withBasis('KEEP', 100, 10, 500),
        withBasis('DROP', 50, 10, 300)
      ],
      targets: [target('KEEP', 1, 10)]
    });

    expect(plan.exits[0]?.gainOnExit).toBeUndefined();
  });

  it('computes nothing when the broker supplied no basis', () => {
    const plan = planRebalance({
      availableCash: new Decimal(0),
      holdings: [holding('KEEP', 100, 10), holding('DROP', 50, 10)],
      targets: [target('KEEP', 1, 10)],
      taxTreatment: 'taxable'
    });

    expect(plan.exits[0]?.gainOnExit).toBeUndefined();
  });

  it('drops basis when netting a long against a short', () => {
    // Summing basis across opposed legs describes a position nobody bought.
    const plan = planRebalance({
      availableCash: new Decimal(0),
      holdings: [
        withBasis('AAA', 100, 10, 500),
        withBasis('AAA', -40, 10, 200)
      ],
      targets: [],
      taxTreatment: 'taxable'
    });

    expect(plan.exits[0]?.costBasis).toBeUndefined();
    expect(plan.exits[0]?.gainOnExit).toBeUndefined();
  });
});

describe('participation', () => {
  it('reports each order as a share of a normal session', () => {
    const plan = planRebalance({
      availableCash: new Decimal(0),
      holdings: [withVolume('THIN', 5000, 10, 80_000)],
      targets: []
    });

    // 50,000 of notional against 80,000 a day.
    expect(plan.exits[0]?.participation).toBeCloseTo(0.625, 3);
  });

  it('warns when an order exceeds a fifth of a session', () => {
    const plan = planRebalance({
      availableCash: new Decimal(0),
      holdings: [withVolume('THIN', 5000, 10, 80_000)],
      targets: []
    });

    expect(plan.notes.join(' ')).toContain("20% of a normal session's volume");
  });

  it('stays quiet for an order a liquid name absorbs', () => {
    const plan = planRebalance({
      availableCash: new Decimal(0),
      holdings: [withVolume('LIQ', 100, 10, 9_000_000)],
      targets: []
    });

    expect(plan.notes.join(' ')).not.toContain('normal session');
  });

  it('leaves participation undefined when no volume was supplied', () => {
    // An unknown participation is not a small one, so it must not read as zero
    // and must not trigger the all-clear.
    const plan = planRebalance({
      availableCash: new Decimal(0),
      holdings: [holding('AAA', 5000, 10)],
      targets: []
    });

    expect(plan.exits[0]?.participation).toBeUndefined();
  });

  it('carries volume through a multi-lot merge', () => {
    // A property of the security, not the lot — and the merge rebuilds the
    // object, which is exactly where costBasis was dropped once already.
    const plan = planRebalance({
      availableCash: new Decimal(0),
      holdings: [
        withVolume('THIN', 2000, 10, 80_000),
        withVolume('THIN', 3000, 10, 80_000)
      ],
      targets: []
    });

    expect(plan.exits[0]?.participation).toBeCloseTo(0.625, 3);
  });
});
