import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeCache, openCacheForTest } from '../cache/store.ts';
import { resetCredentialCache } from '../config/store.ts';
import { Decimal } from '../math/decimal.ts';
import { alpacaAdapter } from './alpaca-adapter.ts';

/**
 * No network. Every response here is a trimmed copy of what the live paper
 * account actually returned — the account payload in particular, because the
 * fields that matter (`id` versus `account_number`, `cash` as a string) are
 * easy to get subtly wrong from memory.
 */

const CLOCK = {
  is_open: false,
  next_open: '2026-09-14T09:30:00-04:00',
  timestamp: '2026-09-12T12:45:11.84070837-04:00'
};

const ACCOUNT = {
  account_number: 'PA32F0I978PS',
  buying_power: '400000',
  cash: '100000',
  id: '36b6db2e-1c50-4117-ac20-e35b0b972a38',
  portfolio_value: '100000',
  status: 'ACTIVE'
};

const saved = { ...process.env };
let requests: { headers: Record<string, string>; url: URL }[] = [];

/** Routes by pathname, so a test only has to describe what it cares about. */
function stubFetch(routes: Record<string, unknown>): void {
  vi.stubGlobal(
    'fetch',
    (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      requests.push({
        headers: (init?.headers ?? {}) as Record<string, string>,
        url
      });
      const body = routes[url.pathname];
      if (body === undefined) {
        return Promise.resolve(
          new Response('{"message":"not stubbed"}', { status: 404 })
        );
      }
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          headers: { 'content-type': 'application/json' },
          status: 200
        })
      );
    }
  );
}

/** A credential file the adapter can also write back to. */
let configPath = '';

function storeFile(): Record<string, string> {
  return JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, string>;
}

beforeEach(() => {
  requests = [];
  openCacheForTest(':memory:');

  // Point the credential store at an empty file. Without this the tests read
  // the developer's real ~/.config/cigar-butt/credentials.json, so whether
  // Alpaca counts as configured depends on whose machine is running them.
  configPath = join(
    mkdtempSync(join(tmpdir(), 'cb-alpaca-')),
    'credentials.json'
  );
  writeFileSync(configPath, '{}\n');
  process.env.CIGAR_BUTT_CONFIG = configPath;

  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ALPACA_')) delete process.env[key];
  }
  delete process.env.CIGAR_BUTT_ALPACA_HOST;
  resetCredentialCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  closeCache();
  process.env = { ...saved };
  resetCredentialCache();
});

/** The unscoped pair the existing setup flow writes. */
function unscopedPaperKeys(): void {
  process.env.ALPACA_API_KEY_ID = 'PKTESTKEY';
  process.env.ALPACA_API_SECRET_KEY = 'paper-secret';
}

describe('environment selection', () => {
  it('defaults to test, because live is never a safe fallback', () => {
    expect(alpacaAdapter.environment()).toBe('test');
    expect(alpacaAdapter.label()).toBe('Alpaca (paper)');
  });

  it('treats an unrecognised setting as test rather than live', () => {
    process.env.ALPACA_ENVIRONMENT = 'whatever';
    expect(alpacaAdapter.environment()).toBe('test');
  });

  it('reads the ALPACA_ENV alias', () => {
    process.env.ALPACA_ENV = 'live';
    expect(alpacaAdapter.environment()).toBe('live');
  });

  it('renders the vendor word for each environment', () => {
    expect(alpacaAdapter.environmentLabel('test')).toBe('paper');
    expect(alpacaAdapter.environmentLabel('live')).toBe('live');
  });
});

describe('setEnvironment', () => {
  it('persists the choice to the credential file', () => {
    expect(alpacaAdapter.setEnvironment('live')).toEqual({});
    expect(storeFile()['ALPACA_ENVIRONMENT']).toBe('live');
    resetCredentialCache();
    expect(alpacaAdapter.environment()).toBe('live');
  });

  it('reports a shell variable that shadows the stored value', () => {
    process.env.ALPACA_ENVIRONMENT = 'paper';
    expect(alpacaAdapter.setEnvironment('live')).toEqual({
      shadowedBy: 'ALPACA_ENVIRONMENT'
    });
    // The file was still written; the point is that it will not take effect.
    expect(storeFile()['ALPACA_ENVIRONMENT']).toBe('live');
    expect(alpacaAdapter.environment()).toBe('test');
  });

  it('does not report a shell variable that agrees under another spelling', () => {
    process.env.ALPACA_ENVIRONMENT = 'paper';
    expect(alpacaAdapter.setEnvironment('test')).toEqual({});
  });

  it('does not report an alias the stored value already outranks', () => {
    // `ALPACA_ENVIRONMENT` in the file beats an exported `ALPACA_ENV`, so the
    // switch does take effect and there is nothing to warn about.
    process.env.ALPACA_ENV = 'paper';
    expect(alpacaAdapter.setEnvironment('live')).toEqual({});
    expect(alpacaAdapter.environment()).toBe('live');
  });
});

describe('credential resolution', () => {
  it('prefers the environment-scoped pair', async () => {
    process.env.ALPACA_PAPER_API_KEY_ID = 'PKSCOPED';
    process.env.ALPACA_PAPER_API_SECRET_KEY = 'scoped-secret';
    process.env.ALPACA_API_KEY_ID = 'PKUNSCOPED';
    process.env.ALPACA_API_SECRET_KEY = 'unscoped-secret';
    stubFetch({ '/v2/account': ACCOUNT, '/v2/clock': CLOCK });

    await alpacaAdapter.accounts();

    expect(requests[0]?.headers['APCA-API-KEY-ID']).toBe('PKSCOPED');
    expect(requests[0]?.headers['APCA-API-SECRET-KEY']).toBe('scoped-secret');
  });

  it('falls back to the unscoped pair so an existing setup keeps working', async () => {
    unscopedPaperKeys();
    stubFetch({ '/v2/account': ACCOUNT });

    await alpacaAdapter.accounts();

    expect(requests[0]?.headers['APCA-API-KEY-ID']).toBe('PKTESTKEY');
  });

  it('refuses half a pair rather than mixing environments', async () => {
    process.env.ALPACA_PAPER_API_KEY_ID = 'PKSCOPED';
    stubFetch({ '/v2/account': ACCOUNT });

    await expect(alpacaAdapter.accounts()).rejects.toThrow(
      /Only half of the Alpaca paper key pair/
    );
  });

  it('names both variables when nothing is configured', async () => {
    stubFetch({ '/v2/account': ACCOUNT });

    await expect(alpacaAdapter.accounts()).rejects.toThrow(
      /ALPACA_PAPER_API_KEY_ID and ALPACA_PAPER_API_SECRET_KEY/
    );
  });

  it('reports configuration per environment without throwing', () => {
    process.env.ALPACA_LIVE_API_KEY_ID = 'AKLIVE';
    process.env.ALPACA_LIVE_API_SECRET_KEY = 'live-secret';

    expect(alpacaAdapter.hasCredentialsFor('live')).toBe(true);
    expect(alpacaAdapter.hasCredentialsFor('test')).toBe(false);
    expect(alpacaAdapter.isConfigured()).toBe(false);
  });
});

describe('key prefix guard', () => {
  it('refuses a paper key while live is active', async () => {
    process.env.ALPACA_ENVIRONMENT = 'live';
    process.env.ALPACA_LIVE_API_KEY_ID = 'PKNOTLIVE';
    process.env.ALPACA_LIVE_API_SECRET_KEY = 'secret';
    stubFetch({ '/v2/account': ACCOUNT });

    await expect(alpacaAdapter.accounts()).rejects.toThrow(
      /starts "PK", which is a paper key/
    );
  });

  it('refuses a live key while paper is active', async () => {
    process.env.ALPACA_PAPER_API_KEY_ID = 'AKNOTPAPER';
    process.env.ALPACA_PAPER_API_SECRET_KEY = 'secret';
    stubFetch({ '/v2/account': ACCOUNT });

    await expect(alpacaAdapter.accounts()).rejects.toThrow(
      /starts "AK", which is a live key/
    );
  });

  it('lets an unrecognised prefix through, since only PK and AK are meaningful', async () => {
    process.env.ALPACA_PAPER_API_KEY_ID = 'XYZ123';
    process.env.ALPACA_PAPER_API_SECRET_KEY = 'secret';
    stubFetch({ '/v2/account': ACCOUNT });

    await expect(alpacaAdapter.accounts()).resolves.toHaveLength(1);
  });
});

describe('host selection', () => {
  it('uses the paper host for test', async () => {
    unscopedPaperKeys();
    stubFetch({ '/v2/account': ACCOUNT });

    await alpacaAdapter.accounts();

    expect(requests[0]?.url.origin).toBe('https://paper-api.alpaca.markets');
  });

  it('follows the environment, not the key prefix', async () => {
    process.env.ALPACA_ENVIRONMENT = 'live';
    process.env.ALPACA_LIVE_API_KEY_ID = 'AKLIVE';
    process.env.ALPACA_LIVE_API_SECRET_KEY = 'live-secret';
    stubFetch({ '/v2/account': ACCOUNT });

    await alpacaAdapter.accounts();

    expect(requests[0]?.url.origin).toBe('https://api.alpaca.markets');
  });

  it('honours the CIGAR_BUTT_ALPACA_HOST override in both environments', async () => {
    process.env.CIGAR_BUTT_ALPACA_HOST = 'https://alpaca.test';
    unscopedPaperKeys();
    stubFetch({ '/v2/account': ACCOUNT });

    await alpacaAdapter.accounts();
    expect(requests[0]?.url.origin).toBe('https://alpaca.test');

    process.env.ALPACA_ENVIRONMENT = 'live';
    process.env.ALPACA_LIVE_API_KEY_ID = 'AKLIVE';
    process.env.ALPACA_LIVE_API_SECRET_KEY = 'live-secret';
    await alpacaAdapter.accounts();
    expect(requests[1]?.url.origin).toBe('https://alpaca.test');
  });
});

describe('accounts', () => {
  it('reports the UUID as the id and the number as the number', async () => {
    unscopedPaperKeys();
    stubFetch({ '/v2/account': ACCOUNT });

    expect(await alpacaAdapter.accounts()).toEqual([
      {
        active: true,
        description: 'Alpaca paper trading',
        id: '36b6db2e-1c50-4117-ac20-e35b0b972a38',
        number: 'PA32F0I978PS',
        status: 'ACTIVE',
        // Unconditionally unknown: the Trading API carries no registration
        // field, and assuming a paper key means taxable would fabricate a cost.
        taxTreatment: 'unknown',
        type: 'PAPER'
      }
    ]);
  });
});

describe('balances', () => {
  it('dates the figures from the market clock and returns Decimals', async () => {
    unscopedPaperKeys();
    stubFetch({ '/v2/account': ACCOUNT, '/v2/clock': CLOCK });

    const balances = await alpacaAdapter.balances('any');

    expect(balances.asOf).toBe('2026-09-12');
    expect(balances.cashAvailable).toBeInstanceOf(Decimal);
    expect(balances.cashTotal).toBeInstanceOf(Decimal);
    expect(balances.totalValue).toBeInstanceOf(Decimal);
    expect(balances.cashAvailable.toString()).toBe('100000');
    expect(balances.totalValue?.toString()).toBe('100000');
  });

  it('leaves openCalls undefined rather than claiming zero', async () => {
    unscopedPaperKeys();
    stubFetch({ '/v2/account': ACCOUNT, '/v2/clock': CLOCK });

    const balances = await alpacaAdapter.balances('any');

    expect(balances.openCalls).toBeUndefined();
    // The distinction is load-bearing: zero would assert "no margin call",
    // which Alpaca never told us.
    expect('openCalls' in balances).toBe(true);
  });

  it('refuses to substitute today when the clock has no timestamp', async () => {
    unscopedPaperKeys();
    stubFetch({ '/v2/account': ACCOUNT, '/v2/clock': {} });

    await expect(alpacaAdapter.balances('any')).rejects.toThrow(/no timestamp/);
  });

  it('refuses to report a missing cash figure as zero', async () => {
    unscopedPaperKeys();
    stubFetch({
      '/v2/account': { ...ACCOUNT, cash: undefined },
      '/v2/clock': CLOCK
    });

    await expect(alpacaAdapter.balances('any')).rejects.toThrow(/no cash/);
  });
});

describe('positions', () => {
  it('returns an empty array for an empty book, which is the real state', async () => {
    unscopedPaperKeys();
    stubFetch({ '/v2/clock': CLOCK, '/v2/positions': [] });

    expect(await alpacaAdapter.positions('any')).toEqual([]);
  });

  it('carries every money field as a Decimal, dated from the clock', async () => {
    unscopedPaperKeys();
    stubFetch({
      '/v2/clock': CLOCK,
      '/v2/positions': [
        {
          cost_basis: '1234.56',
          current_price: '20.10',
          qty: '100',
          symbol: ' aapl ',
          unrealized_pl: '-45.60'
        }
      ]
    });

    const [position] = await alpacaAdapter.positions('any');

    expect(position?.ticker).toBe('AAPL');
    expect(position?.asOf).toBe('2026-09-12');
    expect(position?.price).toBeInstanceOf(Decimal);
    expect(position?.shares).toBeInstanceOf(Decimal);
    expect(position?.costBasis).toBeInstanceOf(Decimal);
    expect(position?.unrealisedGain).toBeInstanceOf(Decimal);
    expect(position?.price.toString()).toBe('20.1');
    expect(position?.unrealisedGain?.toString()).toBe('-45.6');
  });

  it('drops a position with no price rather than marking it at zero', async () => {
    unscopedPaperKeys();
    stubFetch({
      '/v2/clock': CLOCK,
      '/v2/positions': [
        { current_price: '5', qty: '10', symbol: 'GOOD' },
        { qty: '10', symbol: 'NOPRICE' },
        { current_price: '5', symbol: 'NOQTY' },
        { current_price: '5', qty: '10' }
      ]
    });

    const positions = await alpacaAdapter.positions('any');

    expect(positions.map(p => p.ticker)).toEqual(['GOOD']);
  });

  it('nets several lots of one symbol, newest mark winning', async () => {
    unscopedPaperKeys();
    stubFetch({
      '/v2/clock': CLOCK,
      '/v2/positions': [
        {
          cost_basis: '100',
          current_price: '11',
          qty: '10',
          symbol: 'MSFT',
          unrealized_pl: '10'
        },
        {
          cost_basis: '250',
          current_price: '11',
          qty: '-4',
          symbol: 'MSFT',
          unrealized_pl: '-6'
        }
      ]
    });

    const positions = await alpacaAdapter.positions('any');

    expect(positions).toHaveLength(1);
    expect(positions[0]?.shares.toString()).toBe('6');
    // Basis and gain are dropped when a long is netted against a short: the
    // legs were opened for opposite reasons, and a combined "cost" of the net
    // position is not a quantity that exists.
    expect(positions[0]?.costBasis).toBeUndefined();
    expect(positions[0]?.unrealisedGain).toBeUndefined();
  });

  it('sums basis across lots pointing the same way', async () => {
    unscopedPaperKeys();
    stubFetch({
      '/v2/clock': CLOCK,
      '/v2/positions': [
        {
          cost_basis: '100',
          current_price: '11',
          qty: '10',
          symbol: 'MSFT',
          unrealized_pl: '10'
        },
        {
          cost_basis: '250',
          current_price: '11',
          qty: '20',
          symbol: 'MSFT',
          unrealized_pl: '6'
        }
      ]
    });

    const positions = await alpacaAdapter.positions('any');
    expect(positions[0]?.shares.toString()).toBe('30');
    expect(positions[0]?.costBasis?.toString()).toBe('350');
    expect(positions[0]?.unrealisedGain?.toString()).toBe('16');
  });

  it('keeps an undefined cost basis undefined', async () => {
    unscopedPaperKeys();
    stubFetch({
      '/v2/clock': CLOCK,
      '/v2/positions': [{ current_price: '5', qty: '10', symbol: 'X' }]
    });

    const [position] = await alpacaAdapter.positions('any');

    expect(position?.costBasis).toBeUndefined();
    expect(position?.unrealisedGain).toBeUndefined();
  });
});

describe('transactions', () => {
  it('handles an empty activity list, which is the real state', async () => {
    unscopedPaperKeys();
    stubFetch({ '/v2/account/activities': [] });

    expect(await alpacaAdapter.transactions('any')).toEqual({
      more: false,
      transactions: []
    });
  });

  it('sends the window as after/until, the names Alpaca parses', async () => {
    unscopedPaperKeys();
    stubFetch({ '/v2/account/activities': [] });

    await alpacaAdapter.transactions('any', {
      count: 10,
      endDate: '2026-09-12',
      startDate: '2025-01-01'
    });

    const { searchParams } = requests[0]!.url;
    expect(searchParams.get('after')).toBe('2025-01-01');
    expect(searchParams.get('until')).toBe('2026-09-12');
    expect(searchParams.get('page_size')).toBe('10');
  });

  it('flags more only when the page came back full', async () => {
    unscopedPaperKeys();
    const rows = Array.from({ length: 3 }, (_, index) => ({
      activity_type: 'DIV',
      date: '2026-08-01',
      net_amount: String(index + 1)
    }));
    stubFetch({ '/v2/account/activities': rows });

    expect((await alpacaAdapter.transactions('any', { count: 3 })).more).toBe(
      true
    );
    expect((await alpacaAdapter.transactions('any', { count: 4 })).more).toBe(
      false
    );
  });

  it('reads a non-trade activity from net_amount and date', async () => {
    unscopedPaperKeys();
    stubFetch({
      '/v2/account/activities': [
        {
          activity_type: 'DIV',
          date: '2026-08-01',
          description: '  AAPL dividend  ',
          net_amount: '24.00',
          qty: '100',
          symbol: 'AAPL'
        }
      ]
    });

    const [entry] = (await alpacaAdapter.transactions('any')).transactions;

    expect(entry?.amount).toBeInstanceOf(Decimal);
    expect(entry?.amount?.toString()).toBe('24');
    expect(entry?.description).toBe('AAPL dividend');
    expect(entry?.tradeDate).toBe('2026-08-01');
    expect(entry?.type).toBe('DIV');
    expect(entry?.fee).toBeUndefined();
    expect(entry?.settledDate).toBeUndefined();
  });

  it('derives a fill amount from price and quantity, signed by side', async () => {
    unscopedPaperKeys();
    stubFetch({
      '/v2/account/activities': [
        {
          activity_type: 'FILL',
          cum_qty: '30',
          price: '10.25',
          qty: '20',
          side: 'buy',
          symbol: 'MSFT',
          transaction_time: '2026-08-03T14:31:02.123Z'
        },
        {
          activity_type: 'FILL',
          price: '10.25',
          qty: '20',
          side: 'sell',
          symbol: 'MSFT',
          transaction_time: '2026-08-04T14:31:02.123Z'
        }
      ]
    });

    const { transactions } = await alpacaAdapter.transactions('any');

    // `qty` is this event's quantity; `cum_qty` is the order's running total.
    expect(transactions[0]?.quantity?.toString()).toBe('20');
    expect(transactions[0]?.amount?.toString()).toBe('-205');
    expect(transactions[0]?.tradeDate).toBe('2026-08-03');
    expect(transactions[1]?.amount?.toString()).toBe('205');
    for (const entry of transactions) {
      expect(entry.price).toBeInstanceOf(Decimal);
      expect(entry.quantity).toBeInstanceOf(Decimal);
      expect(entry.amount).toBeInstanceOf(Decimal);
    }
  });

  it('falls back to cum_qty only when the per-event quantity is absent', async () => {
    unscopedPaperKeys();
    stubFetch({
      '/v2/account/activities': [
        {
          activity_type: 'FILL',
          cum_qty: '30',
          symbol: 'MSFT',
          transaction_time: '2026-08-03T14:31:02.123Z'
        }
      ]
    });

    const [entry] = (await alpacaAdapter.transactions('any')).transactions;

    expect(entry?.quantity?.toString()).toBe('30');
    // No price, so there is nothing to derive an amount from — and undefined
    // says that, where zero would claim a free trade.
    expect(entry?.amount).toBeUndefined();
  });
});
