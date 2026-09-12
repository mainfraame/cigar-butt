import { beforeEach, describe, expect, it, vi } from 'vitest';

import type * as SecModule from '../data/sec.ts';
import type { CompanyFact } from '../data/sec.ts';

const facts = new Map<string, CompanyFact[]>();

vi.mock('../data/sec.ts', async importOriginal => {
  const actual = await importOriginal<typeof SecModule>();
  return {
    ...actual,
    companyConcept: (_cik: string, concept: string, taxonomy = 'us-gaap') =>
      Promise.resolve(facts.get(`${taxonomy}:${concept}`) ?? [])
  };
});

const { computeMetrics, fetchBalanceSheet } = await import('./metrics.ts');

const ACCN = '0001628280-26-052652';

function fact(
  end: string,
  val: number,
  accn = ACCN,
  filed = '2026-08-04'
): CompanyFact {
  return { accn, end, filed, form: '10-Q', fp: 'Q2', fy: 2026, val };
}

beforeEach(() => {
  facts.clear();
  facts.set('us-gaap:AssetsCurrent', [fact('2026-06-30', 237_303_000)]);
  facts.set('us-gaap:Liabilities', [fact('2026-06-30', 361_984_000)]);
  facts.set('us-gaap:StockholdersEquity', [fact('2026-06-30', 294_072_000)]);
});

describe('fetchBalanceSheet share count', () => {
  it('prefers the us-gaap count when the filer still tags it', async () => {
    facts.set('us-gaap:CommonStockSharesOutstanding', [
      fact('2026-06-30', 22_994_624)
    ]);
    facts.set('dei:EntityCommonStockSharesOutstanding', [
      fact('2026-07-31', 99_999_999)
    ]);

    const { sheet } = await fetchBalanceSheet('216085');

    expect(sheet.sharesOutstanding?.value.toString()).toBe('22994624');
  });

  it('falls back to the cover page when the us-gaap tag lapsed', async () => {
    // Haverty and others stopped tagging the us-gaap count while still filing
    // quarterly, which left P/TBV — the primary Schloss test — reading n/a on
    // a company whose share count was on the cover of the same filing.
    facts.set('dei:EntityCommonStockSharesOutstanding', [
      fact('2026-07-31', 48_898_734)
    ]);

    const { sheet } = await fetchBalanceSheet('216085');

    expect(sheet.sharesOutstanding?.value.toString()).toBe('48898734');
    expect(sheet.sharesOutstanding?.stale).toBeFalsy();
  });

  it('dates the cover count by the cover, not by the period end', async () => {
    // A share count is a divisor, not a line item to be summed, so the
    // current count is the right one — but it must carry its own date.
    facts.set('dei:EntityCommonStockSharesOutstanding', [
      fact('2026-07-31', 48_898_734)
    ]);

    const { sheet } = await fetchBalanceSheet('216085');

    expect(sheet.sharesOutstanding?.asOf).toBe('2026-07-31');
  });

  it('takes the cover count only from the same filing', async () => {
    // A count from a neighbouring quarter is exactly the period-mixing the
    // pinning exists to prevent.
    facts.set('dei:EntityCommonStockSharesOutstanding', [
      fact('2025-07-31', 48_000_000, '0000216085-25-000010', '2025-08-04')
    ]);

    const { sheet } = await fetchBalanceSheet('216085');

    expect(sheet.sharesOutstanding).toBeUndefined();
  });

  it('replaces a stale us-gaap count rather than reporting it', async () => {
    facts.set('us-gaap:CommonStockSharesOutstanding', [
      fact('2020-03-31', 18_665_189, '0000216085-20-000034', '2020-05-21')
    ]);
    facts.set('dei:EntityCommonStockSharesOutstanding', [
      fact('2026-07-31', 48_898_734)
    ]);

    const { sheet, stale } = await fetchBalanceSheet('216085');

    expect(sheet.sharesOutstanding?.value.toString()).toBe('48898734');
    expect(stale.map(entry => entry.key)).not.toContain('sharesOutstanding');
  });

  it('leaves the count missing when neither taxonomy has one', async () => {
    // A dual-class filer tags the cover count per class, so the concept API
    // returns no undimensioned fact at all. Missing is the honest answer.
    const { sheet } = await fetchBalanceSheet('216085');

    expect(sheet.sharesOutstanding).toBeUndefined();
  });
});

describe('liquidity beyond the cash line', () => {
  it('adds short-term investments to cash', async () => {
    // Medifast reported $71.9M of cash while its own activist put liquidity
    // at $167M — the rest was parked in Treasuries. Reading the cash line
    // alone understates net cash, which is one of the five checks.
    facts.set('us-gaap:CashAndCashEquivalentsAtCarryingValue', [
      fact('2026-06-30', 71_910_000)
    ]);
    facts.set('us-gaap:ShortTermInvestments', [fact('2026-06-30', 95_000_000)]);
    facts.set('us-gaap:LongTermDebtNoncurrent', []);

    const { sheet } = await fetchBalanceSheet('910329');
    const metrics = computeMetrics(sheet);

    expect(metrics.netCash?.toString()).toBe('166910000');
  });

  it('falls through to another tag for the same concept', async () => {
    // Filers differ: a concept absent under one name is routinely present
    // under another, and the first that answers wins.
    facts.set('us-gaap:CashAndCashEquivalentsAtCarryingValue', [
      fact('2026-06-30', 10_000_000)
    ]);
    facts.set('us-gaap:MarketableSecuritiesCurrent', [
      fact('2026-06-30', 40_000_000)
    ]);

    const { sheet } = await fetchBalanceSheet('910329');

    expect(sheet.shortTermInvestments?.value.toString()).toBe('40000000');
  });

  it('reports no liquidity when neither tag is present', async () => {
    // Not zero. A filer that tags neither has no figure, and zero would fail
    // the net-cash check on evidence that does not exist.
    const { sheet } = await fetchBalanceSheet('910329');
    const metrics = computeMetrics(sheet);

    expect(sheet.cash).toBeUndefined();
    expect(metrics.netCash).toBeUndefined();
  });
});
