import { describe, expect, it } from 'vitest';

import { Decimal } from '../math/decimal.ts';
import { allocate } from './allocate.ts';

const candidate = (ticker: string, price: number) => ({
  asOf: '2026-09-11',
  price: new Decimal(price),
  ticker
});

describe('allocate', () => {
  it('sizes equal-weight whole-share positions inside the balance', () => {
    const plan = allocate({
      availableCash: new Decimal(30_000),
      candidates: [
        candidate('AAA', 10),
        candidate('BBB', 25),
        candidate('CCC', 4)
      ],
      maxPositionFraction: new Decimal(1)
    });

    // 30,000 / 3 = 10,000 per name.
    expect(plan.lines.map(line => [line.ticker, line.shares])).toEqual([
      ['AAA', 1000],
      ['BBB', 400],
      ['CCC', 2500]
    ]);
    expect(plan.deployedCash).toBe(30_000);
    expect(plan.residualCash).toBe(0);
  });

  it('never exceeds the balance — rounding is always down', () => {
    const plan = allocate({
      availableCash: new Decimal(1000),
      candidates: [candidate('AAA', 33.33), candidate('BBB', 77.77)],
      maxPositionFraction: new Decimal(1)
    });

    expect(plan.deployedCash).toBeLessThanOrEqual(1000);
    expect(plan.residualCash).toBeGreaterThan(0);
    // 500/33.33 = 15.0015 → 15 shares, not 16.
    expect(plan.lines.find(line => line.ticker === 'AAA')?.shares).toBe(15);
  });

  it('caps a single name at maxPositionFraction', () => {
    const plan = allocate({
      availableCash: new Decimal(10_000),
      candidates: [candidate('AAA', 10), candidate('BBB', 10)],
      maxPositionFraction: new Decimal('0.1')
    });

    // Equal weight would be 5,000 each; the 10% cap holds each to 1,000.
    for (const line of plan.lines) expect(line.cost).toBe(1000);
    expect(plan.residualCash).toBe(8000);
  });

  it('reports a name it cannot fund instead of dropping it silently', () => {
    const plan = allocate({
      availableCash: new Decimal(1000),
      candidates: [candidate('AAA', 10), candidate('EXPENSIVE', 5000)],
      maxPositionFraction: new Decimal(1)
    });

    expect(plan.lines.map(line => line.ticker)).toEqual(['AAA']);
    expect(plan.notFunded[0]?.ticker).toBe('EXPENSIVE');
    expect(plan.notFunded[0]?.reason).toContain('One share costs');
  });

  it('subtracts commissions before sizing', () => {
    const plan = allocate({
      availableCash: new Decimal(1000),
      candidates: [candidate('AAA', 100)],
      maxPositionFraction: new Decimal(1),
      perTradeCost: new Decimal(50)
    });

    // 1000 − 50 commission = 950 investable → 9 shares, not 10.
    expect(plan.lines[0]?.shares).toBe(9);
    expect(plan.totalCommission).toBe(50);
  });

  it('refuses when commissions swallow the balance', () => {
    const plan = allocate({
      availableCash: new Decimal(10),
      candidates: [candidate('AAA', 5), candidate('BBB', 5)],
      perTradeCost: new Decimal(20)
    });

    expect(plan.lines).toHaveLength(0);
    expect(plan.warnings.join(' ')).toContain('exceed available cash');
  });

  it('warns when the book is too concentrated to be this strategy', () => {
    const plan = allocate({
      availableCash: new Decimal(10_000),
      candidates: [candidate('AAA', 10)],
      maxPositionFraction: new Decimal(1)
    });

    expect(plan.warnings.join(' ')).toContain('Schloss ran 60 to 100');
  });

  it('honours explicit weights when the caller overrides equal weight', () => {
    const plan = allocate({
      availableCash: new Decimal(10_000),
      candidates: [
        { ...candidate('AAA', 10), weight: new Decimal(3) },
        { ...candidate('BBB', 10), weight: new Decimal(1) }
      ],
      maxPositionFraction: new Decimal(1)
    });

    expect(plan.lines.find(line => line.ticker === 'AAA')?.cost).toBe(7500);
    expect(plan.lines.find(line => line.ticker === 'BBB')?.cost).toBe(2500);
  });

  it('supports fractional shares when the broker does', () => {
    const plan = allocate({
      allowFractionalShares: true,
      availableCash: new Decimal(1000),
      candidates: [candidate('AAA', 33.33)],
      maxPositionFraction: new Decimal(1)
    });

    expect(plan.lines[0]?.shares).toBeCloseTo(30.003, 3);
  });
});

describe('undeployed cash diagnosis', () => {
  const three = [
    candidate('ASTE', 41.42),
    candidate('HVT', 27.6),
    candidate('NL', 7.01)
  ];

  it('blames the per-name cap when the cap is what binds', () => {
    // 3 names at a 10% cap can hold 30% of the balance however it is
    // weighted. Calling the other 70% "rounding" sends the reader hunting a
    // sizing fault that is not there.
    const plan = allocate({
      availableCash: new Decimal(50_000),
      candidates: three
    });

    const warning = plan.warnings.find(note => note.includes('undeployed'));
    expect(warning).toContain('per-name cap');
    expect(warning).toContain('10%');
    expect(warning).not.toContain('whole-share rounding');
  });

  it('still blames rounding when the cap is not binding', () => {
    const plan = allocate({
      availableCash: new Decimal(50_000),
      candidates: three,
      maxPositionFraction: new Decimal(1)
    });

    const warning = plan.warnings.find(note => note.includes('undeployed'));
    expect(warning).toBeUndefined();
  });

  it('names how much the cap allows in total', () => {
    const plan = allocate({
      availableCash: new Decimal(50_000),
      candidates: three
    });

    expect(plan.warnings.join(' ')).toContain('$15,000.00');
  });
});
