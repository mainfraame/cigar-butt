import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Decimal } from '../math/decimal.ts';
import {
  clearSnapshots,
  closeWatchDb,
  finishRun,
  latestSnapshot,
  listRules,
  openWatchDbForTest,
  putRuleState,
  putSnapshot,
  recentAlerts,
  recentRuns,
  recordAlert,
  removeRule,
  ruleState,
  startRun,
  upsertRule,
  type WatchRule
} from './store.ts';

const rule = (over: Partial<WatchRule> = {}): WatchRule => ({
  baseline: 'reference',
  channels: ['stderr'],
  cooldownSeconds: 21_600,
  downPct: new Decimal('0.10'),
  enabled: true,
  id: 'r1',
  kind: 'move',
  rebaseline: false,
  ticker: 'AAA',
  upPct: new Decimal('0.10'),
  ...over
});

beforeEach(() => {
  openWatchDbForTest(':memory:');
});

afterEach(() => {
  closeWatchDb();
  delete process.env.CIGAR_BUTT_WATCH_DB;
});

describe('rules', () => {
  it('round-trips a rule with its decimals intact', () => {
    upsertRule(rule({ downPct: new Decimal('0.075') }));
    const [stored] = listRules();

    // Persisted as TEXT, not REAL: a threshold that has been through a float
    // is exactly what decimal.js is here to prevent.
    expect(stored?.downPct?.toString()).toBe('0.075');
    expect(stored?.upPct?.toString()).toBe('0.1');
  });

  it('treats an absent threshold as absent, not zero', () => {
    upsertRule(rule({ upPct: undefined }));
    expect(listRules()[0]?.upPct).toBeUndefined();
  });

  it('hides disabled rules unless asked', () => {
    upsertRule(rule({ enabled: false }));

    expect(listRules()).toHaveLength(0);
    expect(listRules(true)).toHaveLength(1);
  });

  it('updates in place rather than duplicating', () => {
    upsertRule(rule());
    upsertRule(rule({ ticker: 'BBB' }));

    expect(listRules()).toHaveLength(1);
    expect(listRules()[0]?.ticker).toBe('BBB');
  });

  it('removing a rule also drops its reference prices', () => {
    upsertRule(rule());
    putRuleState({
      armed: true,
      lastFiredAt: undefined,
      referenceAsOf: '2026-09-11',
      referencePrice: new Decimal(100),
      ruleId: 'r1',
      ticker: 'AAA'
    });

    expect(removeRule('r1')).toBe(true);
    // A stale reference outliving its rule would resurrect with the next rule
    // that happened to reuse the id.
    expect(ruleState('r1', 'AAA')).toBeUndefined();
  });
});

describe('rule state', () => {
  it('round-trips the latch and the reference date', () => {
    putRuleState({
      armed: false,
      lastFiredAt: 1_800_000_000,
      referenceAsOf: '2026-09-11',
      referencePrice: new Decimal('41.42'),
      ruleId: 'r1',
      ticker: 'AAA'
    });

    const stored = ruleState('r1', 'AAA');
    expect(stored?.armed).toBe(false);
    expect(stored?.referencePrice.toString()).toBe('41.42');
    expect(stored?.referenceAsOf).toBe('2026-09-11');
    expect(stored?.lastFiredAt).toBe(1_800_000_000);
  });
});

describe('snapshots', () => {
  it('keeps the exact holdings shape plan_rebalance takes', () => {
    putSnapshot({
      accountIdKey: undefined,
      cash: new Decimal('1234.56'),
      holdings: [
        { asOf: '2026-09-11', price: 41.42, shares: 100, ticker: 'AAA' }
      ],
      source: 'manual'
    });

    const snapshot = latestSnapshot();
    expect(snapshot?.cash.toString()).toBe('1234.56');
    expect(snapshot?.holdings[0]).toEqual({
      asOf: '2026-09-11',
      price: 41.42,
      shares: 100,
      ticker: 'AAA'
    });
  });

  it('returns nothing before the first snapshot', () => {
    expect(latestSnapshot()).toBeUndefined();
  });
});

describe('alerts and runs', () => {
  it('records an alert with both prices and both dates', () => {
    recordAlert({
      body: 'AAA -10%',
      delivered: { stderr: 'ok' },
      firedAt: 1_800_000_000,
      moveFraction: new Decimal('-0.1'),
      observedAsOf: '2026-09-11',
      observedPrice: new Decimal(90),
      referencePrice: new Decimal(100),
      ruleId: 'r1',
      ticker: 'AAA'
    });

    const [stored] = recentAlerts();
    expect(stored?.moveFraction.toString()).toBe('-0.1');
    expect(stored?.observedAsOf).toBe('2026-09-11');
    expect(stored?.delivered).toEqual({ stderr: 'ok' });
  });

  it('starts a run as failed so a crash cannot read as success', () => {
    startRun();
    // If the process dies mid-cycle nothing updates the row, and a watch that
    // died must not look like a watch that saw nothing wrong.
    expect(recentRuns()[0]?.outcome).toBe('failed');
  });

  it('records the finished outcome', () => {
    const started = startRun();
    finishRun(started, 'partial', 'no price for BBB');

    const [latest] = recentRuns();
    expect(latest?.outcome).toBe('partial');
    expect(latest?.detail).toBe('no price for BBB');
    expect(latest?.finishedAt).toBeDefined();
  });
});

describe('clearSnapshots', () => {
  it('removes a snapshot that no longer describes the book', () => {
    // A snapshot is the one input a price rule cannot sanity-check, so there
    // has to be a way to say "watch nothing" short of deleting the database.
    putSnapshot({
      accountIdKey: undefined,
      cash: new Decimal(0),
      holdings: [
        { asOf: '2026-09-11', price: 27.6, shares: 181, ticker: 'HVT' }
      ],
      source: 'manual'
    });

    expect(clearSnapshots()).toBe(1);
    expect(latestSnapshot()).toBeUndefined();
  });

  it('reports nothing removed rather than failing on an empty store', () => {
    expect(clearSnapshots()).toBe(0);
  });

  it('leaves rules armed for whatever is snapshotted next', () => {
    upsertRule(rule({ id: 'drawdown' }));
    putSnapshot({
      accountIdKey: undefined,
      cash: new Decimal(0),
      holdings: [
        { asOf: '2026-09-11', price: 27.6, shares: 181, ticker: 'HVT' }
      ],
      source: 'manual'
    });

    clearSnapshots();

    expect(listRules().map(armed => armed.id)).toEqual(['drawdown']);
  });
});
