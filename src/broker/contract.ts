import type { Decimal } from '../math/decimal.ts';
import type { FeeSchedule } from '../portfolio/fees.ts';

/**
 * The broker-neutral contract.
 *
 * Everything above this line — tools, rebalancing, the watch — speaks only
 * these shapes. Everything below it is one adapter per brokerage, translating
 * that provider's wire format into them. Adding a broker should mean writing an
 * adapter and registering it, not editing any tool.
 *
 * Three decisions are baked in here rather than left to each adapter, because
 * they are the ones that go wrong quietly if every integration answers them
 * separately:
 *
 * 1. **Money is `Decimal`, never `number`.** Conversion happens at the wire
 *    edge inside the adapter and nowhere else.
 * 2. **Every price carries the date it is as of.** A broker that cannot supply
 *    one must say so rather than substitute today.
 * 3. **A `Position` is a netted position, not a lot.** Brokers report lots, and
 *    the same symbol can arrive as several rows — including a long and a short
 *    leg. Netting is the adapter's job, so no consumer has to remember.
 */

/**
 * Which set of books an adapter is pointed at.
 *
 * Deliberately neutral names. E*TRADE calls these sandbox and production,
 * Alpaca calls them paper and live, and a third broker will call them something
 * else again — the concept is the same and consumers should not have to learn
 * each vendor's vocabulary. `environmentLabel()` renders the vendor's own word
 * for display.
 *
 * `test` is always the safe default to develop against. No adapter may make
 * `live` the fallback when configuration is ambiguous.
 */
export type BrokerEnvironment = 'live' | 'test';

/**
 * How a sale in this account is taxed.
 *
 * The question this answers, and the only one, is: does selling here realise a
 * currently reportable capital gain? `taxable` says yes; `roth`,
 * `tax-deferred` and `tax-sheltered` say no; `unknown` says the broker did not
 * tell us.
 *
 * `unknown` is not a synonym for `taxable`. Defaulting an undetermined account
 * to taxable fabricates a cost; defaulting it to sheltered hides one. Neither
 * is a claim this server is entitled to make, so it gets its own value and the
 * output says so in words.
 */
export type TaxTreatment =
  /** Roth IRA, Roth Individual K, Coverdell ESA, HSA — post-tax in, untaxed out. */
  | 'roth'
  /** Traditional / rollover / SEP / SIMPLE IRA, 401(k), profit sharing. */
  | 'tax-deferred'
  /** Retirement money whose flavour the broker did not disclose. */
  | 'tax-sheltered'
  | 'taxable'
  | 'unknown';

/**
 * Whether a sale here realises a reportable gain.
 *
 * `undefined` for `unknown` — the three-state convention, not a boolean. A
 * caller that collapses this to false understates the cost of a plan.
 */
export function realisesGain(treatment: TaxTreatment): boolean | undefined {
  if (treatment === 'unknown') return undefined;
  return treatment === 'taxable';
}

/** A netted position in one security. */
export interface Position {
  /** ISO date `price` is as of. Never the time it was read. */
  readonly asOf: string;
  readonly costBasis: Decimal | undefined;
  /** Last trade or mark. */
  readonly price: Decimal;
  /** Net of every lot. Negative means net short. */
  readonly shares: Decimal;
  readonly ticker: string;
  readonly unrealisedGain: Decimal | undefined;
}

export interface Balances {
  /** ISO date these figures are as of. */
  readonly asOf: string;
  /** Settled and unencumbered. The figure a screen may deploy. */
  readonly cashAvailable: Decimal;
  readonly cashTotal: Decimal | undefined;
  /**
   * Unmet margin calls. Non-zero outranks everything else on the page: the
   * broker can liquidate to meet it, so "available" cash may not be yours.
   */
  readonly openCalls: Decimal | undefined;
  readonly totalValue: Decimal | undefined;
}

export interface BrokerAccount {
  /**
   * Whether this account can still hold or trade a position.
   *
   * A closed account is excluded from the combined book: you cannot sell what
   * is in it, so including its holdings would inflate a position and produce a
   * rebalance order nobody can fill. Only a *definite* close sets this false —
   * an unrecognised status leaves it true, because hiding an account the user
   * has money in is the worse error of the two.
   */
  readonly active: boolean;
  readonly description: string;
  /** The opaque key this broker's own API needs. Not the account number. */
  readonly id: string;
  /** What a human would recognise. May be masked. */
  readonly number: string;
  readonly status: string;
  /**
   * Never optional and never defaulted. An adapter that cannot determine this
   * returns `unknown`, which is a different claim from `taxable`.
   */
  readonly taxTreatment: TaxTreatment;
  /** The broker's own word, unchanged. `taxTreatment` is derived from it. */
  readonly type: string;
}

export interface Transaction {
  readonly amount: Decimal | undefined;
  readonly description: string;
  readonly fee: Decimal | undefined;
  readonly price: Decimal | undefined;
  readonly quantity: Decimal | undefined;
  readonly settledDate: string | undefined;
  readonly symbol: string | undefined;
  readonly tradeDate: string;
  readonly type: string;
}

/** Side of an order. No shorting: this server screens long-only value. */
export type OrderSide = 'buy' | 'sell';

/**
 * Limit only, deliberately.
 *
 * A market order in a name this method selects for is how you pay for
 * someone else's exit: Identiv trades $442K a day, and the discount that
 * makes these names interesting is frequently the illiquidity. A limit is
 * also the only order whose worst case a preview can state honestly.
 */
export interface OrderRequest {
  readonly accountId: string;
  /** The limit. Required — see `OrderRequest`. */
  readonly limitPrice: Decimal;
  /** Whole shares. Fractional is broker-specific and out of scope. */
  readonly quantity: Decimal;
  readonly side: OrderSide;
  readonly symbol: string;
  /**
   * Attach a sell at this price to a buy, filled only if the buy fills.
   *
   * Supported where the broker has bracket orders. E*TRADE's `PlaceOrder`
   * does not — its `orderType` list has no bracket, OCO or contingent form —
   * so there the exit is a separate good-till-cancelled sell placed after the
   * buy fills, which reaches the same place in two steps.
   *
   * Deliberately no stop-loss counterpart. A falling price makes a
   * net-net *cheaper*, so a stop would sell the position at its most
   * attractive and is the one automation this method actively argues against.
   */
  readonly takeProfit?: Decimal;
  /**
   * `day` for an entry, `gtc` for an exit.
   *
   * A day order is the right default for a buy — a resting bid nobody is
   * watching is its own hazard. It is the wrong one for an exit: this method
   * holds until the discount closes, which takes quarters or years, and a
   * take-profit that expires at the bell is not an exit strategy. Brokers cap
   * good-till-cancelled at 60 to 180 days, so it still needs re-placing; it
   * is a standing instruction, not a permanent one.
   */
  readonly timeInForce: 'day' | 'gtc';
}

/**
 * What the broker says an order would do, before it does it.
 *
 * The `ref` is the whole safety model. A preview is obtained first, shown to
 * a human, and only then can it be placed — and it can only be placed by
 * quoting the ref back. Nothing can go to market that a person has not seen
 * priced.
 */
export interface OrderPreview {
  readonly estimatedCommission: Decimal | undefined;
  readonly estimatedTotal: Decimal | undefined;
  /** Opaque handle the broker requires to place this exact order. */
  readonly ref: string;
  readonly request: OrderRequest;
  /** Anything the broker wants the user to read. Never suppressed. */
  readonly warnings: readonly string[];
}

export interface PlacedOrder {
  readonly filledQuantity: Decimal | undefined;
  readonly orderId: string;
  readonly placedAt: string;
  readonly status: string;
  readonly symbol: string;
}

/**
 * Placing orders. Present only on a broker this server can trade through,
 * and reachable only when the operator has deliberately enabled trading.
 *
 * Split into preview and place on purpose. E*TRADE's API happens to work
 * this way and Alpaca's does not, so the contract imposes it on both: an
 * order must be priced and shown before it can be sent, and `place` takes a
 * ref rather than an order, so there is no call that both decides and
 * executes.
 */
export interface TradingCapability {
  readonly cancel: (accountId: string, orderId: string) => Promise<void>;
  readonly open: (accountId: string) => Promise<PlacedOrder[]>;
  readonly place: (preview: OrderPreview) => Promise<PlacedOrder>;
  readonly preview: (request: OrderRequest) => Promise<OrderPreview>;
}

/**
 * One brokerage integration.
 *
 * Read-only unless the operator turns trading on. `trading` is absent by
 * default and absent entirely on a broker not implemented for it, so every
 * consumer must handle its absence — which is what keeps the read-only path
 * the default rather than a setting someone forgot.
 */
export interface BrokerAdapter {
  readonly accounts: () => Promise<BrokerAccount[]>;
  /**
   * Present only on a broker that needs a human to authorize a session.
   *
   * Capability by optional method, as the filings adapters do it. E*TRADE has
   * this because OAuth 1.0a hands the user a code to read back; Alpaca omits
   * it entirely, because a static key pair is already the session. A caller
   * checks for the property rather than asking which broker it is holding.
   */
  readonly authorize?: {
    /** Returns the URL the user opens, and what they will see there. */
    readonly begin: () => Promise<{ instructions: string; url: string }>;
    readonly complete: (verifier: string) => Promise<void>;
    /**
     * Revives a session that has merely idled out, before a read.
     * Cheap, best-effort, and never fatal: a failure here is as likely to be a
     * dropped connection as a dead token, and the read that follows says which.
     */
    readonly keepAlive?: () => Promise<void>;
    /** True if a token was actually revoked; false if there was none. */
    readonly revoke: () => Promise<boolean>;
  };
  readonly balances: (accountId: string) => Promise<Balances>;
  /** The active environment. */
  readonly environment: () => BrokerEnvironment;
  /** This vendor's own word for an environment, e.g. "sandbox" or "paper". */
  readonly environmentLabel: (environment: BrokerEnvironment) => string;
  /**
   * This broker's own charges. The statutory fees are identical everywhere and
   * live in `portfolio/fees.ts`; an adapter supplies only what it sets itself.
   */
  readonly feeSchedule: () => FeeSchedule;
  /** Whether the given environment has a usable credential set. */
  readonly hasCredentialsFor: (environment: BrokerEnvironment) => boolean;
  /** Whether the ACTIVE environment is configured. */
  readonly isConfigured: () => boolean;
  /**
   * Whether a read would go out right now.
   *
   * Distinct from `isConfigured` because the two come apart: E*TRADE can hold
   * a consumer key and still have no access token, and a token dies at
   * midnight while the key lives on. Aggregating across brokers needs to know
   * which ones can actually answer, and "has credentials" is not that.
   * A broker with no `authorize` step is connected as soon as it is
   * configured.
   */
  readonly isConnected: () => boolean;
  /** Human-readable, e.g. "E*TRADE (production)". Shown in tool output. */
  readonly label: () => string;
  readonly positions: (accountId: string) => Promise<Position[]>;
  /**
   * Switches environment and persists the choice. Returns the name of a shell
   * variable that overrides the stored value, when one is exported — the
   * environment wins over the credential file by design, so a switch that will
   * not survive the next process must say so rather than appear to work.
   */
  readonly setEnvironment: (environment: BrokerEnvironment) => {
    shadowedBy?: string;
  };
  /** Present only where this server can place an order. */
  readonly trading?: TradingCapability;
  readonly transactions: (
    accountId: string,
    options?: { count?: number; endDate?: string; startDate?: string }
  ) => Promise<{ more: boolean; transactions: Transaction[] }>;
}

/**
 * Nets lots into positions, newest mark winning.
 *
 * Shared rather than per-adapter: every broker reports lots, and a netting bug
 * silently drops a holding from a rebalance. One implementation, one place to
 * test it.
 */
export function netPositions(lots: readonly Position[]): Position[] {
  const byTicker = new Map<string, Position>();

  for (const lot of lots) {
    const existing = byTicker.get(lot.ticker);
    if (!existing) {
      byTicker.set(lot.ticker, lot);
      continue;
    }
    // A stale mark is the worse of the two, so the newer date wins outright.
    const newer = lot.asOf > existing.asOf ? lot : existing;
    // Summing basis across a long and a short leg produces a figure that
    // describes nothing — the legs were opened for opposite reasons and a
    // combined "cost" of the net position is not a quantity that exists. Say
    // undefined rather than a number nobody could act on.
    const opposed = existing.shares.isNegative() !== lot.shares.isNegative();
    byTicker.set(lot.ticker, {
      asOf: newer.asOf,
      costBasis: opposed ? undefined : add(existing.costBasis, lot.costBasis),
      price: newer.price,
      shares: existing.shares.plus(lot.shares),
      ticker: existing.ticker,
      unrealisedGain: opposed
        ? undefined
        : add(existing.unrealisedGain, lot.unrealisedGain)
    });
  }

  return [...byTicker.values()];
}

function add(
  left: Decimal | undefined,
  right: Decimal | undefined
): Decimal | undefined {
  if (!left) return right;
  if (!right) return left;
  return left.plus(right);
}
