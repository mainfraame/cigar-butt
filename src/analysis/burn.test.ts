import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dec } from '../math/decimal.ts';

import type { CompanyFact } from '../data/sec.ts';
import type * as SecModule from '../data/sec.ts';

const facts = new Map<string, CompanyFact[]>();

vi.mock('../data/sec.ts', async importOriginal => {
  const actual = await importOriginal<typeof SecModule>();
  return {
    ...actual,
    companyConcept: (_cik: string, concept: string) =>
      Promise.resolve(facts.get(concept) ?? [])
  };
});

const { burnProfile } = await import('./burn.ts');

const FLOW = 'NetCashProvidedByUsedInOperatingActivities';

function fact(
  start: string,
  end: string,
  val: number,
  form = '10-K'
): CompanyFact {
  return { accn: 'x', end, filed: end, form, fp: 'FY', fy: 2026, start, val };
}

beforeEach(() => facts.clear());

describe('burnProfile', () => {
  it('annualises the latest interim rather than quoting last year', async () => {
    // A company that has just failed a trial is not burning at last year's
    // rate, and last year's 10-K is what a screener would quote.
    facts.set(FLOW, [
      fact('2025-01-01', '2025-12-31', -35_800_000),
      fact('2026-01-01', '2026-06-30', -23_500_000, '10-Q')
    ]);

    const profile = await burnProfile('34956', dec(118_000_000));

    expect(profile.currentBurn?.toFixed(0)).toBe('-47000000');
    expect(profile.selfFunding).toBe(false);
  });

  it('turns cash and burn into a runway', async () => {
    facts.set(FLOW, [fact('2026-01-01', '2026-06-30', -23_500_000, '10-Q')]);

    const profile = await burnProfile('34956', dec(118_000_000));

    expect(Number(profile.runwayYears?.toFixed(2))).toBeCloseTo(2.51, 1);
  });

  it('reports no runway for a business that funds itself', async () => {
    // Not an infinite runway — a different situation. A number here invites
    // the wrong comparison against a burning peer.
    facts.set(FLOW, [fact('2026-01-01', '2026-06-30', 13_000_000, '10-Q')]);

    const profile = await burnProfile('897448', dec(143_558_000));

    expect(profile.selfFunding).toBe(true);
    expect(profile.runwayYears).toBeUndefined();
  });

  it('leaves self-funding undefined when no cash flow was filed', async () => {
    const profile = await burnProfile('1', dec(1000));

    expect(profile.selfFunding).toBeUndefined();
    expect(profile.runwayYears).toBeUndefined();
  });

  it('never treats a quarter as a year in the annual history', async () => {
    facts.set(FLOW, [
      fact('2025-01-01', '2025-12-31', -35_800_000),
      fact('2026-04-01', '2026-06-30', -9_000_000, '10-Q')
    ]);

    const profile = await burnProfile('34956', dec(100_000_000));

    expect(profile.annualCashFlow).toHaveLength(1);
    expect(profile.annualCashFlow[0]?.asOf).toBe('2025-12-31');
  });

  it('reports no runway when the cash figure is missing', async () => {
    facts.set(FLOW, [fact('2026-01-01', '2026-06-30', -23_500_000, '10-Q')]);

    const profile = await burnProfile('34956', undefined);

    expect(profile.selfFunding).toBe(false);
    expect(profile.runwayYears).toBeUndefined();
  });
});
