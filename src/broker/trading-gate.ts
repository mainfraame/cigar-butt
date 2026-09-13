import { getCredential } from '../config/store.ts';
import { dec, Decimal, gtZero } from '../math/decimal.ts';

import type { BrokerEnvironment, OrderRequest } from './contract.ts';

/**
 * Whether this installation may place orders at all, and on what.
 *
 * The threat this exists for is not a typed ticket. It is an assistant
 * placing an order nobody asked for — the whole reason this server was
 * read-only until someone deliberately turned trading on. Three gates, each
 * independent:
 *
 * 1. **Off unless enabled.** `CIGAR_BUTT_ENABLE_ORDERS` must be set. A fresh
 *    install of the published package cannot trade, whatever a caller asks.
 * 2. **Simulated books first.** Enabling trading enables it on paper and
 *    sandbox only. Real money needs `CIGAR_BUTT_ENABLE_LIVE_ORDERS` as well,
 *    which is a second, separate decision.
 * 3. **A ceiling.** `CIGAR_BUTT_MAX_ORDER_VALUE` caps the notional of any one
 *    order, defaulting to $2,500 — enough for a position in a book this size
 *    and not enough for a mistake to matter.
 */

const ENABLE = 'CIGAR_BUTT_ENABLE_ORDERS';
const ENABLE_LIVE = 'CIGAR_BUTT_ENABLE_LIVE_ORDERS';
const MAX_VALUE = 'CIGAR_BUTT_MAX_ORDER_VALUE';

/** Deliberately small. Raise it consciously or not at all. */
const DEFAULT_MAX_ORDER_VALUE = '2500';

/**
 * Resolved the same way as every other setting here: environment first, then
 * the 0600 credential file.
 *
 * Reading `process.env` alone meant a switch set in `credentials.json` looked
 * enabled and silently was not — the worst shape for a safety control, since
 * the user believes a guard is off when it is on, or on when it is off.
 */
const switchOn = (name: string): boolean => {
  const value = getCredential(name)?.trim().toLowerCase();
  return value === '1' || value === 'true';
};

export function ordersEnabled(): boolean {
  return switchOn(ENABLE);
}

export function liveOrdersEnabled(): boolean {
  return ordersEnabled() && switchOn(ENABLE_LIVE);
}

export function maxOrderValue(): Decimal {
  // `dec` rather than the Decimal constructor: a malformed setting must fall
  // back to the safe default, not throw on the way to deciding whether an
  // order is safe.
  const parsed = dec(getCredential(MAX_VALUE)?.trim());
  return gtZero(parsed) ? parsed : new Decimal(DEFAULT_MAX_ORDER_VALUE);
}

/**
 * Why an order may not be placed, or `undefined` if it may.
 *
 * Returns a reason rather than throwing so a tool can print it: a refusal a
 * user cannot act on is the same as a bug.
 */
export function refuseOrder(
  request: OrderRequest,
  environment: BrokerEnvironment
): string | undefined {
  if (!ordersEnabled()) {
    return (
      'Order placement is switched off. This server is read-only until ' +
      `\`${ENABLE}=1\` is set in the environment, and it stays read-only for ` +
      `real money until \`${ENABLE_LIVE}=1\` is set as well. Both are ` +
      'deliberate, separate decisions taken outside this conversation.'
    );
  }

  if (environment === 'live' && !liveOrdersEnabled()) {
    return (
      'Orders are enabled for simulated books only. This account is the real ' +
      `one, which additionally needs \`${ENABLE_LIVE}=1\`. Test on paper ` +
      'first — that is what it is for.'
    );
  }

  if (!gtZero(request.quantity) || !request.quantity.isInteger()) {
    return 'Quantity must be a positive whole number of shares.';
  }

  if (!gtZero(request.limitPrice)) {
    return 'A limit price is required. This server does not send market orders.';
  }

  const notional = request.limitPrice.times(request.quantity);
  const ceiling = maxOrderValue();
  if (notional.gt(ceiling)) {
    return (
      `That order is $${notional.toFixed(2)}, above the $${ceiling.toFixed(2)} ` +
      `per-order ceiling. Raise \`${MAX_VALUE}\` if you mean it, or split the ` +
      'order. The ceiling exists so that a mistake is small.'
    );
  }

  return undefined;
}

/**
 * Whether this installation can place orders, in one line for the setup
 * report.
 *
 * Lives here rather than beside the tools because `setup/` must not import
 * from `tools/` — the data flow runs config → http → data → analysis →
 * portfolio → tools, and reaching back up it is a cycle.
 */
export function tradingStatus(): string {
  if (!ordersEnabled()) return 'read-only (order placement disabled)';
  const cap = `capped at $${maxOrderValue().toFixed(2)} per order`;
  return liveOrdersEnabled()
    ? `enabled for real money, ${cap}`
    : `enabled for simulated books only, ${cap}`;
}
