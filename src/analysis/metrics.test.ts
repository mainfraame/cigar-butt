import { describe, expect, it } from 'vitest';

import { Decimal } from '../math/decimal.ts';
import {
  type BalanceSheet,
  type DatedValue,
  computeMetrics,
  isFinancial,
  judge
} from './metrics.ts';

const item = (
  value: number,
  overrides: Partial<DatedValue> = {}
): DatedValue => ({
  accn: '0000000000-26-000001',
  asOf: '2026-06-30',
  filed: '2026-08-05',
  form: '10-Q',
  value: new Decimal(value),
  ...overrides
});

/** A clean industrial: net cash, no goodwill, comfortable current ratio. */
const netNet: BalanceSheet = {
  assetsCurrent: item(1000),
  cash: item(600),
  goodwill: item(0),
  intangibles: item(0),
  inventory: item(200),
  liabilities: item(300),
  liabilitiesCurrent: item(200),
  longTermDebt: item(50),
  preferredStock: item(0),
  receivables: item(100),
  sharesOutstanding: item(100),
  stockholdersEquity: item(800)
};

describe('computeMetrics', () => {
  it('derives the asset tests from line items', () => {
    const metrics = computeMetrics(netNet);

    expect(metrics.tangibleBook?.toNumber()).toBe(800);
    expect(metrics.tangibleBookPerShare?.toNumber()).toBe(8);
    // 1000 current assets − 300 liabilities − 0 preferred.
    expect(metrics.ncav?.toNumber()).toBe(700);
    // 600 cash + 0.75(100) + 0.5(200) − 300.
    expect(metrics.nnwc?.toNumber()).toBe(475);
    expect(metrics.netCash?.toNumber()).toBe(550);
    expect(metrics.currentRatio?.toNumber()).toBe(5);
    expect(metrics.debtToEquity?.toNumber()).toBe(0.0625);
    expect(metrics.asOf).toBe('2026-06-30');
  });

  it('strips goodwill and intangibles from book value', () => {
    const metrics = computeMetrics({
      ...netNet,
      goodwill: item(300),
      intangibles: item(100)
    });

    // Plain book is still 800; tangible book is not, which is the whole point
    // of not trusting a screener's P/B.
    expect(metrics.tangibleBook?.toNumber()).toBe(400);
  });

  it('reports a missing line item rather than defaulting it', () => {
    const { liabilities: _dropped, ...withoutLiabilities } = netNet;
    const metrics = computeMetrics(withoutLiabilities);

    expect(metrics.ncav).toBeUndefined();
    expect(metrics.nnwc).toBeUndefined();
    expect(metrics.missing).toContain('liabilities');
  });

  it('excludes a stale line item from the arithmetic', () => {
    const metrics = computeMetrics({
      ...netNet,
      // The filer stopped tagging receivables in 2019; using that figure would
      // build NNWC from a seven-year-old number.
      receivables: item(100, { asOf: '2019-09-30', stale: true })
    });

    // 600 cash + 0.75(0) + 0.5(200) − 300 — the stale receivable contributes nothing.
    expect(metrics.nnwc?.toNumber()).toBe(400);
    expect(metrics.missing).toContain('receivables');
  });

  it('does not divide by a zero or negative denominator', () => {
    const metrics = computeMetrics({
      ...netNet,
      liabilitiesCurrent: item(0),
      sharesOutstanding: item(0),
      stockholdersEquity: item(-50)
    });

    expect(metrics.currentRatio).toBeUndefined();
    expect(metrics.debtToEquity).toBeUndefined();
    expect(metrics.tangibleBookPerShare).toBeUndefined();
  });
});

describe('judge', () => {
  it('passes both screens on a genuine net-net', () => {
    // Tangible book/share 8, NCAV/share 7. At $4 the name is below two-thirds
    // of NCAV (4.67) and half of tangible book.
    const verdict = judge(computeMetrics(netNet), new Decimal(4));

    expect(verdict.priceToTangibleBook?.toNumber()).toBe(0.5);
    expect(verdict.passesSchloss).toBe(true);
    expect(verdict.passesGraham).toBe(true);
  });

  it('fails Graham but passes Schloss between the two thresholds', () => {
    // $6 is under tangible book (8) but above two-thirds of NCAV (4.67).
    const verdict = judge(computeMetrics(netNet), new Decimal(6));

    expect(verdict.passesSchloss).toBe(true);
    expect(verdict.passesGraham).toBe(false);
  });

  it('distinguishes "could not compute" from "failed"', () => {
    const { assetsCurrent: _a, liabilities: _l, ...partial } = netNet;
    const verdict = judge(computeMetrics(partial), new Decimal(4));

    const ncavCheck = verdict.checks.find(c => c.name === 'Price < 2/3 NCAV');
    // undefined, not false: the evidence is missing, the test did not fail.
    expect(ncavCheck?.pass).toBeUndefined();
    expect(verdict.passesGraham).toBe(false);
  });

  it('waives the debt rule for a financial but never claims net cash', () => {
    const levered = computeMetrics({
      ...netNet,
      longTermDebt: item(4000),
      stockholdersEquity: item(800)
    });
    const verdict = judge(levered, new Decimal(4), { financial: true });

    // Leverage is the business model for a bank; Schloss owned them anyway.
    expect(verdict.passesSchloss).toBe(true);
    // Deposits and the securities book are not spare cash, so the check is n/a
    // rather than a number that would read as a positive net-cash position.
    expect(
      verdict.checks.find(c => c.name === 'Net cash positive')?.pass
    ).toBeUndefined();
  });

  it('holds the P/TBV threshold exactly, without float drift', () => {
    // 0.1 + 0.2 in binary floating point is 0.30000000000000004. A price that
    // lands exactly on tangible book must read as "not below it".
    const atBook = judge(computeMetrics(netNet), new Decimal('8'));
    expect(atBook.priceToTangibleBook?.toNumber()).toBe(1);
    expect(atBook.checks.find(c => c.name === 'P/TBV < 1.0')?.pass).toBe(false);
  });
});

describe('isFinancial', () => {
  it.each([
    ['6021', true],
    ['6799', true],
    ['6000', true],
    ['3531', false],
    ['6800', false],
    [undefined, false]
  ])('SIC %s → %s', (sic, expected) => {
    expect(isFinancial(sic)).toBe(expected);
  });
});
