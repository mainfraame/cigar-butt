import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openCacheForTest } from '../cache/store.ts';
import { resetCredentialCache } from '../config/store.ts';
import { dailyBars } from './bars.ts';
import { closePool, resetPoolForTest } from './pool.ts';

/**
 * No network. Every request is served from a stubbed `fetch`, and the point of
 * these tests is the parsing and the caching rather than any provider being up.
 */

const saved = { ...process.env };

interface Call {
  readonly url: string;
}

let calls: Call[] = [];

function stubFetch(payload: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: Parameters<typeof fetch>[0]) => {
      calls.push({ url: String(input) });
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          headers: { 'content-type': 'application/json' },
          status
        })
      );
    })
  );
}

/** Tiingo's shape, trimmed to the fields the client reads. */
const TIINGO_ROWS = [
  {
    adjClose: 9.5,
    adjHigh: 10,
    adjLow: 9,
    adjOpen: 9.25,
    adjVolume: 1000,
    close: 95,
    date: '2026-09-10T00:00:00.000Z',
    high: 100
  },
  {
    adjClose: 10.5,
    adjHigh: 11,
    adjLow: 10,
    adjOpen: 9.5,
    adjVolume: 0,
    date: '2026-09-11T00:00:00.000Z'
  },
  // A row the provider could not fill. Dropped, not defaulted.
  { adjClose: null, adjHigh: 11, adjLow: 10, adjOpen: 10, date: '2026-09-12' }
];

beforeEach(() => {
  calls = [];
  resetPoolForTest(':memory:');
  openCacheForTest(':memory:');

  // Point the credential store at a file holding only a Tiingo key, so the
  // test does not depend on which providers the developer has configured.
  const directory = mkdtempSync(join(tmpdir(), 'cb-bars-'));
  const store = join(directory, 'credentials.json');
  writeFileSync(store, JSON.stringify({ TIINGO_API_KEY: 'test-key' }));
  process.env.CIGAR_BUTT_CONFIG = store;
  for (const key of Object.keys(process.env)) {
    if (key.endsWith('_API_KEY') || key.endsWith('_API_KEY_ID')) {
      delete process.env[key];
    }
  }
  resetCredentialCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  closePool();
  process.env = { ...saved };
  resetCredentialCache();
});

describe('dailyBars', () => {
  it('parses Tiingo’s adjusted fields and drops unusable rows', async () => {
    stubFetch(TIINGO_ROWS);

    const series = await dailyBars({ calendarDays: 730, ticker: 'aste' });

    expect(series.source).toBe('tiingo');
    expect(series.ticker).toBe('ASTE');
    // Adjusted for both, which is what makes a drawdown across a split honest.
    expect(series.adjustment).toBe('dividends-and-splits');
    expect(series.bars).toHaveLength(2);
    // The ADJUSTED close, not the raw one — 9.5 rather than 95.
    expect(series.bars[0]).toEqual({
      close: 9.5,
      date: '2026-09-10',
      high: 10,
      low: 9,
      open: 9.25,
      volume: 1000
    });
    // A zero-volume session is kept: not trading is a fact about the name.
    expect(series.bars[1]?.volume).toBe(0);
  });

  it('asks for the window it was given, and sends the key as a header', async () => {
    stubFetch(TIINGO_ROWS);
    await dailyBars({ calendarDays: 30, ticker: 'ASTE' });

    const url = new URL(calls[0]?.url ?? '');
    expect(url.pathname).toBe('/tiingo/daily/ASTE/prices');
    expect(url.searchParams.get('resampleFreq')).toBe('daily');

    const from = Date.parse(`${url.searchParams.get('startDate')}T00:00:00Z`);
    const to = Date.parse(`${url.searchParams.get('endDate')}T00:00:00Z`);
    expect(Math.round((to - from) / 86_400_000)).toBe(30);

    // The credential never rides in the query string.
    expect(url.search).not.toContain('test-key');
  });

  it('serves a second call for the same window from the cache', async () => {
    stubFetch(TIINGO_ROWS);

    await dailyBars({ calendarDays: 730, ticker: 'ASTE' });
    await dailyBars({ calendarDays: 730, ticker: 'ASTE' });

    // A past daily bar never changes, so the second call must cost nothing.
    expect(calls).toHaveLength(1);
  });

  it('fails loudly when every row is unusable', async () => {
    stubFetch([{ date: '2026-09-10' }]);
    await expect(
      dailyBars({ calendarDays: 730, ticker: 'ASTE' })
    ).rejects.toThrow(/No provider could answer/);
  });
});
