import { beforeEach, describe, expect, it, vi } from 'vitest';

import { dec, ZERO, type Decimal } from '../math/decimal.ts';

import type { BrokerAdapter, BrokerEnvironment } from './contract.ts';
import type { RegisteredBroker } from './registry.ts';

const registered: RegisteredBroker[] = [];

vi.mock('./registry.ts', () => ({
  allBrokers: () => registered,
  brokerAdapter: (id: string) =>
    registered.find(entry => entry.id === id)!.adapter,
  configuredBrokers: () => [],
  connectedBrokers: () =>
    registered.filter(entry => entry.adapter.isConnected())
}));

const { openBook, readBook } = await import('./aggregate.ts');

const d = (value: string): Decimal => dec(value)!;

interface FakeOptions {
  cash?: string;
  environment?: BrokerEnvironment;
  failAccounts?: boolean;
  failPositions?: boolean;
  shares?: string;
}

function fake(id: string, options: FakeOptions = {}): RegisteredBroker {
  const env = options.environment ?? 'live';
  const adapter: BrokerAdapter = {
    accounts: () =>
      options.failAccounts
        ? Promise.reject(new Error(`${id} is down`))
        : Promise.resolve([
            {
              description: `${id} account`,
              id: `${id}-1`,
              number: `${id}-0001`,
              status: 'ACTIVE',
              taxTreatment: 'unknown' as const,
              type: 'BROKERAGE'
            }
          ]),
    balances: () =>
      Promise.resolve({
        asOf: '2026-09-11',
        cashAvailable: d(options.cash ?? '1000'),
        cashTotal: undefined,
        openCalls: undefined,
        totalValue: undefined
      }),
    environment: () => env,
    environmentLabel: value => (value === 'test' ? 'paper' : 'live'),
    feeSchedule: () => ({ commission: ZERO, otcSurcharge: ZERO }),
    hasCredentialsFor: () => true,
    isConfigured: () => true,
    isConnected: () => true,
    label: () => `${id} (${env})`,
    positions: () =>
      options.failPositions
        ? Promise.reject(new Error(`${id} positions unavailable`))
        : Promise.resolve([
            {
              asOf: '2026-09-11',
              costBasis: undefined,
              price: d('25'),
              shares: d(options.shares ?? '100'),
              ticker: 'HVT',
              unrealisedGain: undefined
            }
          ]),
    setEnvironment: () => ({}),
    transactions: () => Promise.resolve({ more: false, transactions: [] })
  };
  return { adapter, id };
}

function only(...brokers: RegisteredBroker[]): void {
  registered.length = 0;
  registered.push(...brokers);
}

beforeEach(() => {
  registered.length = 0;
});

describe('openBook scoping', () => {
  it('includes every connected broker in the same book', async () => {
    only(fake('etrade'), fake('alpaca'));

    const scope = await openBook();

    expect(scope.accounts.map(entry => entry.brokerId).toSorted()).toEqual([
      'alpaca',
      'etrade'
    ]);
    expect(scope.excluded).toHaveLength(0);
  });

  it('never sums a simulated book into a real one', async () => {
    // A paper balance folded into a live one is a cash figure someone could
    // size an allocation against.
    only(fake('etrade'), fake('alpaca', { environment: 'test' }));

    const scope = await openBook();

    expect(scope.environment).toBe('live');
    expect(scope.accounts.map(entry => entry.brokerId)).toEqual(['etrade']);
    expect(scope.excluded.map(entry => entry.brokerId)).toEqual(['alpaca']);
  });

  it('names what it left out rather than dropping it silently', async () => {
    only(fake('etrade'), fake('alpaca', { environment: 'test' }));

    const scope = await openBook();

    expect(scope.excluded[0]?.reason).toContain('paper');
  });

  it('combines simulated books when nothing live is connected', async () => {
    only(
      fake('etrade', { environment: 'test' }),
      fake('alpaca', { environment: 'test' })
    );

    const scope = await openBook();

    expect(scope.environment).toBe('test');
    expect(scope.accounts).toHaveLength(2);
  });

  it('honours an explicit broker over the live-wins rule', async () => {
    // Naming a broker is the user saying which book they mean.
    only(fake('etrade'), fake('alpaca', { environment: 'test' }));

    const scope = await openBook({ broker: 'alpaca' });

    expect(scope.environment).toBe('test');
    expect(scope.accounts.map(entry => entry.brokerId)).toEqual(['alpaca']);
    expect(scope.excluded).toHaveLength(0);
  });

  it('narrows to one account by ref', async () => {
    only(fake('etrade'), fake('alpaca'));

    const scope = await openBook({ account: 'etrade:etrade-1' });

    expect(scope.accounts).toHaveLength(1);
    expect(scope.accounts[0]?.ref).toBe('etrade:etrade-1');
  });

  it('reports a broker that would not list accounts, and keeps the rest', async () => {
    only(fake('etrade', { failAccounts: true }), fake('alpaca'));

    const scope = await openBook();

    expect(scope.accounts.map(entry => entry.brokerId)).toEqual(['alpaca']);
    expect(scope.failures[0]?.reason).toContain('etrade is down');
  });

  it('returns an empty scope when nothing is connected', async () => {
    only();

    const scope = await openBook();

    expect(scope.accounts).toHaveLength(0);
    expect(scope.environment).toBeUndefined();
  });
});

describe('readBook', () => {
  it('combines positions and cash across brokers', async () => {
    only(
      fake('etrade', { cash: '1500', shares: '200' }),
      fake('alpaca', { cash: '500', shares: '100' })
    );

    const book = await readBook(await openBook());

    expect(book.positions).toHaveLength(1);
    expect(book.positions[0]?.shares.toString()).toBe('300');
    expect(book.balances?.cashAvailable.toString()).toBe('2000');
  });

  it('keeps one broker’s failure from hiding the other’s positions', async () => {
    // A plan built from a book that silently lost a broker is worse than one
    // that says a broker is missing.
    only(fake('etrade', { failPositions: true }), fake('alpaca'));

    const book = await readBook(await openBook());

    expect(book.positions[0]?.shares.toString()).toBe('100');
    expect(book.failures.map(entry => entry.reason)).toContain(
      'etrade positions unavailable'
    );
  });

  it('dates a summed balance by its stalest part', async () => {
    only(fake('etrade'), fake('alpaca'));

    const book = await readBook(await openBook());

    expect(book.balances?.asOf).toBe('2026-09-11');
    expect(book.balances?.rows).toHaveLength(2);
  });
});
