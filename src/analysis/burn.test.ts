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

    const profile = await burnProfile(
      '34956',
      dec(118_000_000),
      dec(121_663_000)
    );

    expect(profile.currentBurn?.toFixed(0)).toBe('-47000000');
    expect(profile.selfFunding).toBe(false);
  });

  it('turns cash and burn into a runway for a cash box', async () => {
    facts.set(FLOW, [fact('2026-01-01', '2026-06-30', -23_500_000, '10-Q')]);

    // Tenax: $118M of cash inside $121.7M of current assets.
    const profile = await burnProfile(
      '34956',
      dec(118_000_000),
      dec(121_663_000)
    );

    expect(Number(profile.runwayYears?.toFixed(2))).toBeCloseTo(2.51, 1);
  });

  it('offers no runway for a business funded by working capital', async () => {
    // Bridgford: $333K of cash inside $60.3M of current assets, against a
    // $5.7M burn. Cash over burn said six weeks for a hundred-year-old
    // manufacturer doing $231M of revenue, which describes nothing.
    facts.set(FLOW, [fact('2024-11-02', '2025-10-31', -5_692_000)]);

    const profile = await burnProfile('14177', dec(333_000), dec(60_272_000));

    expect(profile.selfFunding).toBe(false);
    expect(profile.runwayYears).toBeUndefined();
    expect(Number(profile.cashShare?.toFixed(3))).toBeCloseTo(0.006, 2);
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

describe('working-capital cover', () => {
  it('separates a fast burn from a slow one', async () => {
    // Geospace burns $36.5M against $39.4M of net current assets; Clarus
    // burns $4.8M against $116.8M. Both read as "operations consume cash",
    // and the cover is the number that tells them apart.
    facts.set(FLOW, [fact('2024-10-01', '2025-09-30', -36_464_000)]);
    const fast = await burnProfile(
      '1001115',
      dec(2_833_000),
      dec(68_809_000),
      dec(39_392_000)
    );

    facts.set(FLOW, [fact('2025-01-01', '2025-12-31', -4_786_000)]);
    const slow = await burnProfile(
      '913277',
      dec(28_925_000),
      dec(173_555_000),
      dec(116_797_000)
    );

    expect(Number(fast.workingCapitalYears?.toFixed(1))).toBeCloseTo(1.1, 1);
    expect(Number(slow.workingCapitalYears?.toFixed(0))).toBeCloseTo(24, 0);
  });

  it('offers no cover for a cash box, which gets a runway instead', async () => {
    facts.set(FLOW, [fact('2026-01-01', '2026-06-30', -23_500_000, '10-Q')]);

    const profile = await burnProfile(
      '34956',
      dec(118_000_000),
      dec(121_663_000),
      dec(113_590_000)
    );

    expect(profile.runwayYears).toBeDefined();
    expect(profile.workingCapitalYears).toBeUndefined();
  });

  it('offers no cover for a business that funds itself', async () => {
    facts.set(FLOW, [fact('2025-01-01', '2025-12-31', 6_863_000)]);

    const profile = await burnProfile(
      '910329',
      dec(71_910_000),
      dec(202_034_000),
      dec(138_010_000)
    );

    expect(profile.selfFunding).toBe(true);
    expect(profile.workingCapitalYears).toBeUndefined();
  });
});

describe('anomalous periods', () => {
  it('ignores a stub period shorter than a quarter', async () => {
    // MagnaChip: annual cash flow of -$24.2M, and a short stub that
    // annualised to "$5,892 a year" and from there to a runway of fourteen
    // thousand years. A number that wrong reads as a company with no problem.
    facts.set(FLOW, [
      fact('2025-01-01', '2025-12-31', -24_208_000),
      fact('2026-06-01', '2026-06-30', -491, '10-Q')
    ]);

    const profile = await burnProfile(
      '1325702',
      dec(87_936_000),
      dec(164_473_000)
    );

    expect(profile.currentBurn?.toFixed(0)).toBe('-24208000');
    expect(profile.burnPeriod?.months).toBe(12);
  });

  it('reports no runway when the burn rounds to nothing', async () => {
    // Half a century of runway is arithmetic, not a fact about the company.
    facts.set(FLOW, [fact('2026-01-01', '2026-06-30', -100, '10-Q')]);

    const profile = await burnProfile('1', dec(87_936_000), dec(90_000_000));

    expect(profile.selfFunding).toBe(false);
    expect(profile.runwayYears).toBeUndefined();
  });

  it('names the period the burn was annualised from', async () => {
    facts.set(FLOW, [fact('2026-01-01', '2026-06-30', -23_500_000, '10-Q')]);

    const profile = await burnProfile(
      '34956',
      dec(118_000_000),
      dec(121_663_000)
    );

    expect(profile.burnPeriod?.from).toBe('2026-01-01');
    expect(profile.burnPeriod?.months).toBe(6);
  });
});
