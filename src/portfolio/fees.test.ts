import { describe, expect, it } from 'vitest';

import { Decimal, ZERO } from '../math/decimal.ts';
import { estimateFees, participation } from './fees.ts';

const free = { commission: ZERO, otcSurcharge: ZERO };

describe('estimateFees', () => {
  it('charges nothing statutory on a buy', () => {
    // FINRA's own wording: members are assessed "for the sale of covered
    // securities". A buy costs commission and nothing else, which is why
    // allocate's default per-trade cost of zero is correct rather than unset.
    const fees = estimateFees({
      notional: new Decimal(10_000),
      schedule: free,
      shares: new Decimal(500),
      side: 'buy'
    });

    expect(fees.secFee.toNumber()).toBe(0);
    expect(fees.taf.toNumber()).toBe(0);
    expect(fees.total.toNumber()).toBe(0);
  });

  it('is about 41 cents on a $10,000 sale', () => {
    // The headline proportion: the whole statutory cost of selling $10,000 is
    // pocket change beside a spread measured in percent.
    const fees = estimateFees({
      notional: new Decimal(10_000),
      schedule: free,
      shares: new Decimal(1000),
      side: 'sell'
    });

    // 10,000 × 0.0000206 = 0.206, rounded up to the next penny.
    expect(fees.secFee.toNumber()).toBe(0.21);
    // 1000 × 0.000195 = 0.195, rounded up.
    expect(fees.taf.toNumber()).toBe(0.2);
    expect(fees.total.toNumber()).toBe(0.41);
  });

  it('caps the activity fee', () => {
    const fees = estimateFees({
      notional: new Decimal(1_000_000),
      schedule: free,
      shares: new Decimal(10_000_000),
      side: 'sell'
    });

    expect(fees.taf.toNumber()).toBe(9.79);
  });

  it('adds a broker commission on either side', () => {
    const schedule = { commission: new Decimal('6.95'), otcSurcharge: ZERO };
    const buy = estimateFees({
      notional: new Decimal(1000),
      schedule,
      shares: new Decimal(100),
      side: 'buy'
    });

    expect(buy.total.toNumber()).toBe(6.95);
  });

  it('reports when the statutory rates took effect', () => {
    // Section 31 has been $27.80, $0.00 and $20.60 per million inside sixteen
    // months, so a figure without its date is not checkable.
    const fees = estimateFees({
      notional: new Decimal(1000),
      schedule: free,
      shares: new Decimal(10),
      side: 'sell'
    });

    expect(fees.ratesEffective).toMatch(/\d{4}-\d{2}-\d{2}/);
  });
});

describe('participation', () => {
  it('is the order as a fraction of a normal session', () => {
    expect(
      participation(new Decimal(50_000), new Decimal(200_000))?.toNumber()
    ).toBe(0.25);
  });

  it('is undefined when no volume was supplied', () => {
    // An unknown participation is not a small one.
    expect(participation(new Decimal(50_000), undefined)).toBeUndefined();
  });

  it('is undefined for a name that did not trade', () => {
    expect(participation(new Decimal(50_000), ZERO)).toBeUndefined();
  });
});
