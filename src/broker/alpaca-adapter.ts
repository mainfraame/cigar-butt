import { cached } from '../cache/store.ts';
import { getCredential, saveCredentials } from '../config/store.ts';
import { fetchJson } from '../http/client.ts';
import { dec, ZERO, type Decimal } from '../math/decimal.ts';
import {
  netPositions,
  type BrokerAdapter,
  type BrokerEnvironment,
  type PlacedOrder,
  type Position
} from './contract.ts';

/**
 * Alpaca, expressed in the broker-neutral contract.
 *
 * Two things make it a materially better unattended broker than E*TRADE, and
 * both matter for the scheduled watch:
 *
 * - **Static API keys.** No OAuth dance, no verifier typed by a human, and no
 *   midnight expiry. A scheduled run can refresh positions indefinitely, which
 *   is impossible on E*TRADE by construction.
 * - **One account per key**, so there is no opaque account-id-key to look up
 *   first.
 *
 * The trade-off is that a paper account is not a real book. That is a fact
 * about the account, not the integration, and `label()` says which it is.
 */

const HOSTS: Readonly<Record<BrokerEnvironment, string>> = {
  live: 'https://api.alpaca.markets',
  test: 'https://paper-api.alpaca.markets'
};

/** Alpaca's own word for each environment, for display. */
const LABELS: Readonly<Record<BrokerEnvironment, string>> = {
  live: 'live',
  test: 'paper'
};

/**
 * Alpaca stamps the environment into the key itself: a paper key begins `PK`,
 * a live one `AK`. That is a useful *check* — it catches a key pointed at the
 * wrong host before the request fails with an opaque 403 — but it is not the
 * selector. The active environment is an explicit, persisted setting, the same
 * as E*TRADE's, so that switching books is a deliberate act rather than a
 * side effect of which credential happened to be pasted in.
 */
const KEY_PREFIXES: Readonly<Record<BrokerEnvironment, string>> = {
  live: 'AK',
  test: 'PK'
};

const ENV_ENVIRONMENT = 'ALPACA_ENVIRONMENT';
const ENV_ENVIRONMENT_ALIAS = 'ALPACA_ENV';

/**
 * Credential names.
 *
 * The key pair is stored once per environment, because a paper key is rejected
 * outright by the live host and vice versa: sharing one slot means a toggle
 * silently signs live requests with paper material. The unscoped names are
 * still read as a fallback so an existing single-pair setup keeps working.
 */
const UNSCOPED = {
  key: 'ALPACA_API_KEY_ID',
  secret: 'ALPACA_API_SECRET_KEY'
} as const;

const SUFFIX = {
  key: 'API_KEY_ID',
  secret: 'API_SECRET_KEY'
} as const;

type CredentialSlot = keyof typeof SUFFIX;

const RATE = { rateKey: 'alpaca-trading', requestsPerSecond: 3 } as const;

/** Positions move; the market clock does not need re-reading every call. */
const TTL_CLOCK = 5 * 60;

/** The environment-scoped variable name, e.g. ALPACA_PAPER_API_KEY_ID. */
function scopedName(
  slot: CredentialSlot,
  env: BrokerEnvironment = environment()
): string {
  return `ALPACA_${env === 'test' ? 'PAPER' : 'LIVE'}_${SUFFIX[slot]}`;
}

/** Scoped value if present, else the unscoped fallback. */
function slotValue(
  slot: CredentialSlot,
  env: BrokerEnvironment = environment()
): string | undefined {
  return getCredential(scopedName(slot, env)) ?? getCredential(UNSCOPED[slot]);
}

/**
 * The active environment.
 *
 * `test` is the default and the fallback for anything unrecognised. An
 * ambiguous configuration must never resolve to the book with real money in
 * it — that is the one mistake here that costs something.
 */
function environment(): BrokerEnvironment {
  // `ALPACA_ENV` is accepted as an alias because it is the shorter name people
  // reach for in a shell rc. Alpaca's own word is accepted too, since someone
  // setting this by hand will write what the dashboard says.
  const raw = (
    getCredential(ENV_ENVIRONMENT) ?? getCredential(ENV_ENVIRONMENT_ALIAS)
  )
    ?.trim()
    .toLowerCase();
  return raw === 'live' || raw === 'production' ? 'live' : 'test';
}

/**
 * Resolves the key pair for an environment, refusing anything ambiguous.
 *
 * Half a pair is an error rather than a fall-through to the other
 * environment's material: mixing a paper key with a live secret produces a 403
 * that reads exactly like a revoked key.
 */
function credentials(env: BrokerEnvironment = environment()): {
  key: string;
  secret: string;
} {
  const key = slotValue('key', env);
  const secret = slotValue('secret', env);

  if (!key || !secret) {
    if (key || secret) {
      throw new Error(
        `Only half of the Alpaca ${LABELS[env]} key pair is set. Both ` +
          `${scopedName('key', env)} and ${scopedName('secret', env)} are ` +
          'needed (the unscoped ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY ' +
          'pair is read as a fallback for both).'
      );
    }
    throw new Error(
      `No Alpaca ${LABELS[env]} key is configured. Set ` +
        `${scopedName('key', env)} and ${scopedName('secret', env)}, or run ` +
        '`setup_credentials`. The secret is shown once at creation — ' +
        'regenerate the pair if it is lost. https://alpaca.markets/'
    );
  }

  // The key prefix is a check, not a selector: a PK key sent to the live host
  // fails with a bare 403, which reads as a bad credential rather than as the
  // wrong book. Saying so here costs one string comparison.
  const expected = KEY_PREFIXES[env];
  const actual = key.slice(0, 2).toUpperCase();
  if (actual !== expected && (actual === 'PK' || actual === 'AK')) {
    const other: BrokerEnvironment = env === 'test' ? 'live' : 'test';
    throw new Error(
      `The Alpaca key resolved for the ${LABELS[env]} environment starts ` +
        `"${actual}", which is a ${LABELS[other]} key. Set ` +
        `${scopedName('key', env)} and ${scopedName('secret', env)} to a ` +
        `${LABELS[env]} pair, or switch environment to ${other}.`
    );
  }

  return { key, secret };
}

/**
 * Host follows the environment, never the key — the key is only cross-checked
 * against it. `CIGAR_BUTT_ALPACA_HOST` overrides both, for a proxy or a test.
 */
function host(env: BrokerEnvironment = environment()): string {
  return process.env.CIGAR_BUTT_ALPACA_HOST ?? HOSTS[env];
}

interface RawOrder {
  filled_qty?: string;
  id?: string;
  legs?: RawOrder[];
  limit_price?: string;
  side?: string;
  status?: string;
  submitted_at?: string;
  symbol?: string;
}

const toPlaced = (raw: RawOrder): PlacedOrder => ({
  // `legs` carries the attached exit on a one-triggers-other order. Alpaca
  // holds it until the entry fills, so it is absent from a flat order list
  // and invisible unless read from the parent.
  ...(raw.legs && raw.legs.length > 0
    ? { attached: raw.legs.map(leg => toPlaced(leg)) }
    : {}),
  filledQuantity: dec(raw.filled_qty),
  limitPrice: dec(raw.limit_price),
  orderId: raw.id ?? '',
  placedAt: raw.submitted_at ?? '',
  side: raw.side === 'sell' ? 'sell' : 'buy',
  status: raw.status ?? 'unknown',
  symbol: raw.symbol ?? ''
});

async function send<T>(
  path: string,
  method: 'DELETE' | 'GET' | 'POST',
  body?: unknown
): Promise<T> {
  const { key, secret } = credentials();
  return fetchJson<T>(`${host()}${path}`, {
    ...RATE,
    body,
    headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret },
    method
  });
}

async function get<T>(
  path: string,
  searchParams?: Record<string, string>
): Promise<T> {
  const { key, secret } = credentials();
  return fetchJson<T>(`${host()}${path}`, {
    ...RATE,
    headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret },
    searchParams
  });
}

interface RawAccount {
  account_number?: string;
  cash?: string;
  id?: string;
  portfolio_value?: string;
  status?: string;
}

interface RawPosition {
  asset_class?: string;
  cost_basis?: string;
  current_price?: string;
  qty?: string;
  symbol?: string;
  unrealized_pl?: string;
}

interface RawActivity {
  activity_type?: string;
  cum_qty?: string;
  date?: string;
  description?: string;
  net_amount?: string;
  price?: string;
  qty?: string;
  side?: string;
  symbol?: string;
  transaction_time?: string;
}

/**
 * The date a mark is as of.
 *
 * Alpaca's position payload carries a price but no timestamp, and substituting
 * today would be inventing provenance — the failure this codebase exists to
 * prevent. So the market clock is asked, which is a real sourced date: during a
 * session it is today, and outside one it is still the day the marks belong to.
 * If the clock will not say, nothing here may claim a date either.
 */
async function markDate(): Promise<string> {
  const clock = await cached(
    'alpaca-clock',
    `${environment()}@${host()}`,
    TTL_CLOCK,
    () => get<{ timestamp?: string }>('/v2/clock')
  );
  const timestamp = clock.timestamp?.slice(0, 10);
  if (!timestamp) {
    throw new Error(
      'Alpaca returned a market clock with no timestamp, so there is no date ' +
        'to attribute these marks to. Retry, or check status.alpaca.markets.'
    );
  }
  return timestamp;
}

/**
 * The cash effect of one activity.
 *
 * `net_amount` is carried by the non-trade activities only; a fill has `price`
 * and `qty` instead. Deriving the product of two figures on the same record is
 * arithmetic on sourced numbers, not a guess — reporting nothing at all would
 * lose information the broker actually gave us. Sign follows the side, so a
 * buy reads as cash out.
 */
function activityAmount(
  entry: RawActivity,
  quantity: Decimal | undefined
): Decimal | undefined {
  const net = dec(entry.net_amount);
  if (net) return net;

  const price = dec(entry.price);
  if (!price || !quantity) return undefined;

  const gross = price.times(quantity);
  return entry.side?.toLowerCase().startsWith('buy') ? gross.negated() : gross;
}

export const alpacaAdapter: BrokerAdapter = {
  accounts: async () => {
    const account = await get<RawAccount>('/v2/account');
    const paper = environment() === 'test';
    // One account per key, so there is nothing to choose between.
    return [
      {
        active: account.status?.toUpperCase() !== 'ACCOUNT_CLOSED',
        description: paper ? 'Alpaca paper trading' : 'Alpaca brokerage',
        // Alpaca's own handle for the account is the UUID, not the number.
        id: account.id ?? account.account_number ?? 'default',
        number: account.account_number ?? '',
        status: account.status ?? 'UNKNOWN',
        // Unconditionally `unknown`: this adapter is built on Alpaca's Trading
        // API, whose /v2/account carries no registration field at all. Only the
        // Broker API distinguishes an IRA from a taxable account. A future
        // author must not "fix" this by assuming a paper key means taxable —
        // that would fabricate a tax cost the data does not support.
        taxTreatment: 'unknown' as const,
        type: paper ? 'PAPER' : 'BROKERAGE'
      }
    ];
  },

  balances: async () => {
    const [account, asOf] = await Promise.all([
      get<RawAccount>('/v2/account'),
      markDate()
    ]);

    const cash = dec(account.cash);
    if (!cash) {
      // Zero would be a claim about the account rather than a report of what
      // was returned, and it is the figure an allocation sizes against.
      throw new Error(
        'Alpaca returned an account with no cash figure, so there is nothing ' +
          'to report as available. Retry rather than treat it as zero.'
      );
    }

    return {
      asOf,
      cashAvailable: cash,
      cashTotal: cash,
      // Alpaca closes positions rather than issuing a call, so there is nothing
      // to report here — undefined, not zero, because "none" and "not offered"
      // are different claims.
      openCalls: undefined,
      totalValue: dec(account.portfolio_value)
    };
  },

  environment,

  environmentLabel: env => LABELS[env],

  // Commission-free, including OTC. What remains on a sale is statutory.
  feeSchedule: () => ({ commission: ZERO, otcSurcharge: ZERO }),

  hasCredentialsFor: env =>
    slotValue('key', env) !== undefined &&
    slotValue('secret', env) !== undefined,

  isConfigured: () => alpacaAdapter.hasCredentialsFor(environment()),

  // A static key pair is the session: there is no `authorize` step to be
  // part-way through, so configured and connected are the same state.
  isConnected: () => alpacaAdapter.hasCredentialsFor(environment()),

  label: () => `Alpaca (${LABELS[environment()]})`,

  positions: async () => {
    const [raw, asOf] = await Promise.all([
      get<RawPosition[]>('/v2/positions'),
      markDate()
    ]);

    const lots = raw.flatMap<Position>(position => {
      const ticker = position.symbol?.trim().toUpperCase();
      const price = dec(position.current_price);
      const shares = dec(position.qty);
      // An unpriced position cannot be sized against, and carrying it as a
      // zero would understate the book.
      if (!ticker || !price || !shares) return [];
      return [
        {
          asOf,
          costBasis: dec(position.cost_basis),
          price,
          shares,
          ticker,
          unrealisedGain: dec(position.unrealized_pl)
        }
      ];
    });

    return netPositions(lots);
  },

  setEnvironment: env => {
    saveCredentials({ [ENV_ENVIRONMENT]: env });

    // Re-reading is exact where comparing strings is not: the file now says
    // `env`, so anything else coming back means an exported variable outranked
    // it — and after the save only an exported `ALPACA_ENVIRONMENT` can, since
    // the stored value satisfies that lookup before the alias is consulted.
    // Naming a variable that merely disagrees would send the user chasing a
    // red herring.
    return environment() === env ? {} : { shadowedBy: ENV_ENVIRONMENT };
  },

  /**
   * Switches the active environment and persists the choice.
   *
   * An exported `ALPACA_ENV` wins over the stored value by design, so a switch
   * made underneath one looks like it worked and then reverts on the next
   * process. The caller is told which variable to unset rather than left to
   * discover it.
   */
  trading: {
    /**
     * Errors propagate deliberately. Reporting a failed cancellation as a
     * success is the worst direction for this particular error to point: the
     * user believes an order is pulled while it is still working.
     */
    cancel: async (_accountId, orderId) => {
      await send<unknown>(
        `/v2/orders/${encodeURIComponent(orderId)}`,
        'DELETE'
      );
    },

    open: async () =>
      (
        await get<RawOrder[]>('/v2/orders', {
          // Without this Alpaca omits the attached legs entirely.
          nested: 'true',
          status: 'open'
        })
      ).map(toPlaced),

    /**
     * Takes the preview rather than an order, so nothing can be sent that was
     * not first priced and shown. The ref travels as `client_order_id`, which
     * makes the broker's own record point back at the preview a human saw.
     */
    place: async preview => {
      const { limitPrice, quantity, side, symbol, takeProfit, timeInForce } =
        preview.request;
      return toPlaced(
        await send<RawOrder>('/v2/orders', 'POST', {
          client_order_id: preview.ref,
          limit_price: limitPrice.toString(),
          // `oto`, not `bracket`. Alpaca's bracket class requires a
          // stop_loss.stop_price and rejects the order without one — and a
          // stop is the one leg this method will not attach, because a
          // falling price makes a net-net cheaper and the stop would sell it
          // at its most attractive. One-triggers-other carries a single exit,
          // which is exactly the shape wanted: the sell exists only if the
          // buy fills.
          ...(takeProfit
            ? {
                order_class: 'oto',
                take_profit: { limit_price: takeProfit.toString() }
              }
            : {}),
          qty: quantity.toString(),
          side,
          symbol,
          time_in_force: timeInForce,
          type: 'limit'
        })
      );
    },

    /**
     * Alpaca has no preview endpoint. The contract still requires the step,
     * because the point of it is not the broker's arithmetic — it is that a
     * person sees the order priced before anything reaches a market.
     */
    preview: request =>
      Promise.resolve({
        // Commission-free, and a limit order's worst case is the limit, so
        // the total is arithmetic rather than an estimate.
        estimatedCommission: ZERO,
        estimatedTotal: request.limitPrice.times(request.quantity),
        ref: `cb-${Date.now().toString(36)}-${request.symbol.toLowerCase()}`,
        request,
        warnings:
          environment() === 'test'
            ? ['Paper account: this order is simulated and moves no money.']
            : ['Live account: this order commits real money.']
      })
  },

  transactions: async (_accountId, options) => {
    const pageSize = Math.min(Math.max(options?.count ?? 50, 1), 100);
    const params: Record<string, string> = { page_size: String(pageSize) };
    // Alpaca's activity window is `after`/`until`, both exclusive, and both
    // accept a bare date as well as a timestamp.
    if (options?.startDate) params['after'] = options.startDate;
    if (options?.endDate) params['until'] = options.endDate;

    const raw = await get<RawActivity[]>('/v2/account/activities', params);

    return {
      // Alpaca pages by cursor rather than reporting a total, so a full page is
      // the only signal that more exist.
      more: raw.length >= pageSize,
      transactions: raw.map(entry => {
        // `qty` is this event's quantity; `cum_qty` is the running total for
        // the order, so it is only a fallback when the per-event figure is
        // absent.
        const quantity = dec(entry.qty) ?? dec(entry.cum_qty);
        return {
          amount: activityAmount(entry, quantity),
          description: entry.description?.trim() || (entry.activity_type ?? ''),
          // Alpaca reports commissions as their own activity rows rather than
          // as a field on the trade.
          fee: undefined,
          price: dec(entry.price),
          quantity,
          settledDate: undefined,
          symbol: entry.symbol?.trim(),
          tradeDate: (entry.transaction_time ?? entry.date ?? '').slice(0, 10),
          type: entry.activity_type ?? ''
        };
      })
    };
  }
};
