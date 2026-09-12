import { describe, expect, it, vi } from 'vitest';

import { openCacheForTest } from '../cache/store.ts';

import type * as HttpModule from '../http/client.ts';

let payload: unknown = {};

vi.mock('../http/client.ts', async importOriginal => {
  const actual = await importOriginal<typeof HttpModule>();
  return { ...actual, fetchJson: () => Promise.resolve(payload) };
});

const { companyConcept } = await import('./sec.ts');

describe('companyConcept unit selection', () => {
  it('survives a units map whose entry is not an array', async () => {
    // Tiptree crashed the whole analysis on
    // "(data.units.USD ?? …).toSorted is not a function". One filer's odd
    // payload must not take down a company.
    openCacheForTest(':memory:');
    payload = { cik: 1, entityName: 'X', units: { USD: { oops: true } } };

    await expect(companyConcept('1393726', 'Liabilities')).resolves.toEqual([]);
  });

  it('reads a concept reported in an unexpected unit', async () => {
    openCacheForTest(':memory:');
    payload = {
      cik: 1,
      entityName: 'X',
      units: {
        CAD: [
          { accn: 'a', end: '2026-06-30', filed: 'x', form: '10-Q', val: 5 }
        ]
      }
    };

    const facts = await companyConcept('1', 'Liabilities');

    expect(facts).toHaveLength(1);
  });

  it('prefers USD when several units are present', async () => {
    openCacheForTest(':memory:');
    payload = {
      cik: 1,
      entityName: 'X',
      units: {
        USD: [
          { accn: 'a', end: '2026-06-30', filed: 'x', form: '10-Q', val: 7 }
        ],
        'USD/shares': [
          { accn: 'b', end: '2026-06-30', filed: 'x', form: '10-Q', val: 1 }
        ]
      }
    };

    const facts = await companyConcept('1', 'Liabilities');

    expect(facts[0]?.val).toBe(7);
  });

  it('returns nothing when units is absent entirely', async () => {
    openCacheForTest(':memory:');
    payload = { cik: 1, entityName: 'X' };

    await expect(companyConcept('1', 'Liabilities')).resolves.toEqual([]);
  });
});
