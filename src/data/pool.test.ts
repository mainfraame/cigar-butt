import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetCredentialCache } from '../config/store.ts';
import { HttpError } from '../http/client.ts';
import {
  budgetsFor,
  clearCooldowns,
  closePool,
  poolStatus,
  PoolExhausted,
  rateFor,
  resetPoolForTest,
  runPool,
  sweepUsage,
  windowStart,
  type Provider
} from './pool.ts';

const saved = { ...process.env };

/** Ids must match the credential registry; these are real provider ids. */
function stub(
  id: string,
  behaviour: () => Promise<string>,
  over: Partial<Provider<string>> = {}
): Provider<string> {
  return {
    budgets: [],
    id,
    label: id,
    quotaCooldownSeconds: 300,
    requestsPerSecond: 1,
    run: behaviour,
    ...over
  };
}

/** A provider's daily call budget, or Infinity when it declares none. */
function dailyLimit(provider: Provider<unknown>): number {
  return (
    provider.budgets.find(budget => budget.per === 'day')?.limit ?? Infinity
  );
}

const ok = (value: string) => () => Promise.resolve(value);
const boom = (message: string) => () => Promise.reject(new Error(message));
const rateLimited = () => () =>
  Promise.reject(new HttpError(429, 'https://example.test', 'slow down'));

beforeEach(() => {
  resetPoolForTest(':memory:');

  // Point the credential store at an empty file. Without this the tests read
  // the developer's real ~/.config/cigar-butt/credentials.json, so whether a
  // provider counts as configured depends on whose machine is running them.
  const store = join(
    mkdtempSync(join(tmpdir(), 'cb-pool-')),
    'credentials.json'
  );
  writeFileSync(store, '{}\n');
  process.env.CIGAR_BUTT_CONFIG = store;
  resetCredentialCache();

  for (const key of Object.keys(process.env)) {
    if (
      key.startsWith('CIGAR_BUTT_RATE_') ||
      key === 'CIGAR_BUTT_PROVIDER_ORDER'
    ) {
      delete process.env[key];
    }
  }
  process.env.TIINGO_API_KEY = 'tiingo-key';
  process.env.POLYGON_API_KEY = 'polygon-key';
  delete process.env.ALPHAVANTAGE_API_KEY;
});

afterEach(() => {
  closePool();
  process.env = { ...saved };
  resetCredentialCache();
});

describe('runPool', () => {
  it('returns the first provider that answers', async () => {
    const outcome = await runPool(
      [stub('tiingo', ok('from-tiingo')), stub('polygon', ok('from-polygon'))],
      'AAPL'
    );

    expect(outcome.value).toBe('from-tiingo');
    expect(outcome.providerId).toBe('tiingo');
  });

  it('skips a provider with no credential rather than failing', async () => {
    const outcome = await runPool(
      [stub('alphavantage', ok('unreachable')), stub('tiingo', ok('served'))],
      'AAPL'
    );

    expect(outcome.value).toBe('served');
    expect(outcome.attempts[0]).toEqual({
      id: 'alphavantage',
      outcome: 'no-key'
    });
  });

  it('falls through an ordinary error to the next provider', async () => {
    const outcome = await runPool(
      [stub('tiingo', boom('bad ticker')), stub('polygon', ok('served'))],
      'AAPL'
    );

    expect(outcome.providerId).toBe('polygon');
    expect(outcome.attempts[0]?.outcome).toBe('error');
  });

  it('puts a rate-limited provider on cooldown and skips it next time', async () => {
    const providers = [
      stub('tiingo', rateLimited()),
      stub('polygon', ok('served'))
    ];

    const first = await runPool(providers, 'AAPL');
    expect(first.attempts[0]?.outcome).toBe('quota');

    // The cap is remembered, so the second call does not spend a request
    // rediscovering it.
    const second = await runPool(providers, 'MSFT');
    expect(second.attempts[0]?.outcome).toBe('cooling-down');
    expect(second.providerId).toBe('polygon');
  });

  it('treats a provider-specific prose cap as a quota, not an error', async () => {
    // Alpha Vantage answers HTTP 200 with prose when the daily cap is spent;
    // scored as a plain error it would be retried until the day ended.
    process.env.ALPHAVANTAGE_API_KEY = 'av-key';
    const providers = [
      stub('alphavantage', boom('Thank you for using Alpha Vantage'), {
        isQuotaError: error => /thank you for using/i.test(String(error))
      }),
      stub('tiingo', ok('served'))
    ];

    const outcome = await runPool(providers, 'AAPL');
    expect(outcome.attempts[0]?.outcome).toBe('quota');
  });

  it('reports every attempt when nothing can answer', async () => {
    const failure = await runPool(
      [stub('tiingo', boom('down')), stub('alphavantage', ok('no key though'))],
      'AAPL'
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PoolExhausted);
    // A single "no data" hides which of no-key, rate-limited and bad-ticker
    // happened, and those need three different fixes.
    expect(String(failure)).toContain('tiingo: error');
    expect(String(failure)).toContain('alphavantage: no-key');
  });

  it('clearCooldowns makes a capped provider eligible again', async () => {
    const providers = [
      stub('tiingo', rateLimited()),
      stub('polygon', ok('served'))
    ];
    await runPool(providers, 'AAPL');

    expect(clearCooldowns()).toBe(1);
    const after = await runPool(providers, 'MSFT');
    expect(after.attempts[0]?.outcome).toBe('quota');
  });
});

describe('configuration', () => {
  it('uses the declared free-tier rate by default', () => {
    expect(rateFor(stub('polygon', ok('x'), { requestsPerSecond: 0.08 }))).toBe(
      0.08
    );
  });

  it('lets a paid plan override the free-tier rate', () => {
    // Without this, someone paying for a higher limit is held to the speed of
    // someone paying nothing.
    process.env.CIGAR_BUTT_RATE_POLYGON = '100';
    expect(rateFor(stub('polygon', ok('x'), { requestsPerSecond: 0.08 }))).toBe(
      100
    );
  });

  it('ignores a nonsense rate override', () => {
    process.env.CIGAR_BUTT_RATE_POLYGON = 'fast';
    expect(rateFor(stub('polygon', ok('x'), { requestsPerSecond: 0.08 }))).toBe(
      0.08
    );
  });

  it('honours a preferred provider order', async () => {
    process.env.CIGAR_BUTT_PROVIDER_ORDER = 'polygon';
    const outcome = await runPool(
      [stub('tiingo', ok('from-tiingo')), stub('polygon', ok('from-polygon'))],
      'AAPL'
    );

    expect(outcome.providerId).toBe('polygon');
  });
});

describe('poolStatus', () => {
  it('reports configuration and readiness per provider', () => {
    const status = poolStatus([
      stub('tiingo', ok('x')),
      stub('alphavantage', ok('x'))
    ]);
    const byId = new Map(status.map(entry => [entry.id, entry]));

    expect(byId.get('tiingo')?.configured).toBe(true);
    expect(byId.get('alphavantage')?.configured).toBe(false);
    expect(byId.get('tiingo')?.cooldownSeconds).toBe(0);
  });
});

describe('budget accounting', () => {
  it('stops before spending a request once a budget is used up', async () => {
    // Reactive 429 handling would burn the rejected call, which most providers
    // still count against the quota.
    let calls = 0;
    const capped = stub(
      'tiingo',
      () => {
        calls += 1;
        return Promise.resolve('served');
      },
      { budgets: [{ limit: 2, per: 'day' }] }
    );
    const backup = stub('polygon', ok('backup'));

    await runPool([capped, backup], 'A');
    await runPool([capped, backup], 'B');
    const third = await runPool([capped, backup], 'C');

    expect(calls).toBe(2);
    expect(third.providerId).toBe('polygon');
    expect(third.attempts[0]?.outcome).toBe('budget-spent');
  });

  it('counts a failed request, because the provider does too', async () => {
    const failing = stub('tiingo', boom('bad ticker'), {
      budgets: [{ limit: 1, per: 'day' }]
    });

    await runPool([failing, stub('polygon', ok('x'))], 'A');
    const [state] = budgetsFor(failing);
    expect(state?.used).toBe(1);
  });

  it('counts distinct symbols, not calls, for a symbol budget', async () => {
    const provider = stub('tiingo', ok('served'), {
      budgets: [{ limit: 10, per: 'month', unit: 'symbols' }]
    });

    await runPool([provider], 'AAPL');
    await runPool([provider], 'AAPL');
    await runPool([provider], 'MSFT');

    expect(budgetsFor(provider)[0]?.used).toBe(2);
  });

  it('still serves a symbol already counted this period', async () => {
    // Tiingo bills unique symbols per month, so re-reading one already fetched
    // costs nothing and must not be blocked by an exhausted symbol budget.
    const provider = stub('tiingo', ok('served'), {
      budgets: [{ limit: 1, per: 'month', unit: 'symbols' }]
    });

    await runPool([provider], 'AAPL');
    const again = await runPool([provider], 'AAPL');
    expect(again.providerId).toBe('tiingo');

    const fresh = await runPool(
      [provider, stub('polygon', ok('backup'))],
      'MSFT'
    );
    expect(fresh.providerId).toBe('polygon');
  });

  it('treats a limit of 0 as unlimited, for a paid plan', async () => {
    process.env.CIGAR_BUTT_BUDGET_POLYGON_MINUTE = '0';
    const provider = stub('polygon', ok('served'), {
      budgets: [{ limit: 5, per: 'minute' }]
    });

    for (let i = 0; i < 8; i += 1) await runPool([provider], `T${i}`);
    const outcome = await runPool([provider], 'MORE');
    expect(outcome.providerId).toBe('polygon');
  });

  it('lets a paid plan raise a documented free-tier limit', () => {
    process.env.CIGAR_BUTT_BUDGET_TIINGO_HOUR = '5000';
    const provider = stub('tiingo', ok('x'), {
      budgets: [{ limit: 50, per: 'hour' }]
    });

    expect(budgetsFor(provider)[0]?.limit).toBe(5000);
  });
});

describe('usage windows', () => {
  it.each([
    ['minute', '2026-09-12T11:03'],
    ['hour', '2026-09-12T11'],
    ['day', '2026-09-12'],
    ['month', '2026-09']
  ] as const)('buckets by %s', (per, expected) => {
    expect(windowStart(per, new Date('2026-09-12T11:03:45Z'))).toBe(expected);
  });

  it('rolls over without a scheduled reset', async () => {
    // A new period produces a new key, so the previous period's rows simply
    // stop matching — correctness never waits on a sweep.
    const provider = stub('tiingo', ok('x'), {
      budgets: [{ limit: 1, per: 'day' }]
    });
    await runPool([provider], 'A');
    expect(budgetsFor(provider)[0]?.used).toBe(1);

    const tomorrow = new Date(Date.now() + 86_400_000);
    expect(windowStart('day', tomorrow)).not.toBe(windowStart('day'));
  });

  it('sweeps rolled-over rows without touching the current window', async () => {
    const provider = stub('tiingo', ok('x'), {
      budgets: [{ limit: 5, per: 'day' }]
    });
    await runPool([provider], 'A');

    sweepUsage();
    expect(budgetsFor(provider)[0]?.used).toBe(1);
  });
});

describe('quote provider declarations', () => {
  it('declares a budget for every provider in the pool', async () => {
    // A provider with no declared budget is invisible to the accounting and
    // will run until the service rejects it — the reactive failure this
    // module exists to avoid.
    const { QUOTE_PROVIDERS_FOR_TEST } = await import('./prices.ts');
    for (const provider of QUOTE_PROVIDERS_FOR_TEST) {
      expect(
        provider.budgets.length,
        `${provider.id} declares no budget`
      ).toBeGreaterThan(0);
      for (const budget of provider.budgets) {
        expect(budget.limit, `${provider.id} ${budget.per}`).toBeGreaterThan(0);
      }
    }
  });

  it('orders the pool so the tightest free tier is tried last', async () => {
    const { QUOTE_PROVIDERS_FOR_TEST } = await import('./prices.ts');

    const last = QUOTE_PROVIDERS_FOR_TEST.at(-1);
    const smallest = Math.min(
      ...QUOTE_PROVIDERS_FOR_TEST.map(provider => dailyLimit(provider))
    );
    expect(last && dailyLimit(last)).toBe(smallest);
  });
});
