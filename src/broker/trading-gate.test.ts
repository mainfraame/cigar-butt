import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetCredentialCache } from '../config/store.ts';
import { dec } from '../math/decimal.ts';
import {
  liveOrdersEnabled,
  maxOrderValue,
  ordersEnabled,
  refuseOrder
} from './trading-gate.ts';

import type { OrderRequest } from './contract.ts';

const order = (over: Partial<OrderRequest> = {}): OrderRequest => ({
  accountId: 'a',
  limitPrice: dec('2.58')!,
  quantity: dec(100)!,
  side: 'buy',
  symbol: 'INVE',
  timeInForce: 'day',
  ...over
});

const KEYS = [
  'CIGAR_BUTT_ENABLE_ORDERS',
  'CIGAR_BUTT_ENABLE_LIVE_ORDERS',
  'CIGAR_BUTT_MAX_ORDER_VALUE'
];

beforeEach(() => {
  for (const key of KEYS) delete process.env[key];
  resetCredentialCache();
});

afterEach(() => {
  for (const key of KEYS) delete process.env[key];
  resetCredentialCache();
});

describe('trading gate', () => {
  it('is off in a fresh install', () => {
    // A published package must not be able to trade because a caller asked.
    expect(ordersEnabled()).toBe(false);
    expect(refuseOrder(order(), 'test')).toContain('switched off');
  });

  it('enabling trading does not enable real money', () => {
    // Two separate decisions on purpose.
    process.env['CIGAR_BUTT_ENABLE_ORDERS'] = '1';

    expect(refuseOrder(order(), 'test')).toBeUndefined();
    expect(refuseOrder(order(), 'live')).toContain('simulated books only');
    expect(liveOrdersEnabled()).toBe(false);
  });

  it('allows a real order only when both switches are set', () => {
    process.env['CIGAR_BUTT_ENABLE_ORDERS'] = '1';
    process.env['CIGAR_BUTT_ENABLE_LIVE_ORDERS'] = '1';

    expect(refuseOrder(order(), 'live')).toBeUndefined();
  });

  it('caps the notional of a single order', () => {
    process.env['CIGAR_BUTT_ENABLE_ORDERS'] = '1';

    // 1,000 x $2.58 = $2,580, over the $2,500 default.
    const refusal = refuseOrder(order({ quantity: dec(1000)! }), 'test');

    expect(refusal).toContain('per-order ceiling');
  });

  it('honours a raised ceiling', () => {
    process.env['CIGAR_BUTT_ENABLE_ORDERS'] = '1';
    process.env['CIGAR_BUTT_MAX_ORDER_VALUE'] = '10000';

    expect(
      refuseOrder(order({ quantity: dec(1000)! }), 'test')
    ).toBeUndefined();
    expect(maxOrderValue().toString()).toBe('10000');
  });

  it('falls back to the default ceiling on nonsense', () => {
    process.env['CIGAR_BUTT_MAX_ORDER_VALUE'] = 'lots';

    expect(maxOrderValue().toString()).toBe('2500');
  });

  it('refuses a fractional or zero quantity', () => {
    process.env['CIGAR_BUTT_ENABLE_ORDERS'] = '1';

    expect(refuseOrder(order({ quantity: dec('1.5')! }), 'test')).toContain(
      'whole number'
    );
    expect(refuseOrder(order({ quantity: dec(0)! }), 'test')).toContain(
      'whole number'
    );
  });

  it('refuses an order with no limit', () => {
    // A market order into a name trading $442K a day is how you pay for
    // someone else's exit.
    process.env['CIGAR_BUTT_ENABLE_ORDERS'] = '1';

    expect(refuseOrder(order({ limitPrice: dec(0)! }), 'test')).toContain(
      'does not send market orders'
    );
  });
});

describe('switches resolve from the credential file', () => {
  it('honours a switch set in credentials.json, not just the environment', () => {
    // Reading process.env alone meant a switch set in the file looked
    // enabled and silently was not — the worst shape for a safety control.
    const dir = mkdtempSync(join(tmpdir(), 'cb-gate-'));
    const path = join(dir, 'credentials.json');
    writeFileSync(
      path,
      JSON.stringify({
        CIGAR_BUTT_ENABLE_LIVE_ORDERS: '1',
        CIGAR_BUTT_ENABLE_ORDERS: '1'
      })
    );
    process.env['CIGAR_BUTT_CONFIG'] = path;
    resetCredentialCache();

    expect(ordersEnabled()).toBe(true);
    expect(liveOrdersEnabled()).toBe(true);

    delete process.env['CIGAR_BUTT_CONFIG'];
    rmSync(dir, { force: true, recursive: true });
    resetCredentialCache();
  });
});
