import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cached,
  closeCache,
  openCacheForTest,
  purge,
  read,
  stats,
  write
} from './store.ts';

beforeEach(() => {
  openCacheForTest(':memory:');
});

afterEach(() => {
  closeCache();
});

describe('cache', () => {
  it('round-trips a value', () => {
    write('quote', 'AAPL', { asOf: '2026-09-11', price: 1 }, 60);
    expect(read('quote', 'AAPL')).toEqual({ asOf: '2026-09-11', price: 1 });
  });

  it('misses on an expired entry', () => {
    write('quote', 'STALE', { price: 1 }, -1);
    expect(read('quote', 'STALE')).toBeUndefined();
  });

  it('keeps namespaces separate', () => {
    write('quote', 'X', 'a', 60);
    write('sec-concept', 'X', 'b', 60);

    expect(read('quote', 'X')).toBe('a');
    expect(read('sec-concept', 'X')).toBe('b');
  });

  it('produces once and serves from cache thereafter', async () => {
    let calls = 0;
    const produce = () => {
      calls += 1;
      return Promise.resolve({ n: calls });
    };

    expect(await cached('quote', 'ONCE', 60, produce)).toEqual({ n: 1 });
    expect(await cached('quote', 'ONCE', 60, produce)).toEqual({ n: 1 });
    expect(calls).toBe(1);
  });

  it('purges one namespace without touching another', () => {
    write('quote', 'X', 1, 60);
    write('sec-concept', 'Y', 2, 60);

    expect(purge('quote')).toBe(1);
    expect(read('quote', 'X')).toBeUndefined();
    expect(read('sec-concept', 'Y')).toBe(2);
  });

  it('counts live and expired entries separately', () => {
    write('quote', 'LIVE', 1, 60);
    write('quote', 'DEAD', 1, -1);

    const snapshot = stats();
    expect(snapshot.live).toBe(1);
    expect(snapshot.expired).toBe(1);
  });
});
