import type { Decimal } from '../math/decimal.ts';

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

/**
 * One brokerage integration.
 *
 * Read-only by construction: there is no order method and there must never be
 * one. Automating execution is the single change that turns this from a
 * research tool into something that can lose money unattended.
 */
export interface BrokerAdapter {
  readonly accounts: () => Promise<BrokerAccount[]>;
  readonly balances: (accountId: string) => Promise<Balances>;
  /** The active environment. */
  readonly environment: () => BrokerEnvironment;
  /** This vendor's own word for an environment, e.g. "sandbox" or "paper". */
  readonly environmentLabel: (environment: BrokerEnvironment) => string;
  /** Whether the given environment has a usable credential set. */
  readonly hasCredentialsFor: (environment: BrokerEnvironment) => boolean;
  /** Whether the ACTIVE environment is configured. */
  readonly isConfigured: () => boolean;
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
