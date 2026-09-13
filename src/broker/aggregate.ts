import { groupBy, sortBy, uniq } from 'lodash-es';

import { div, gtZero, ZERO, type Decimal } from '../math/decimal.ts';
import { connectedBrokers, type RegisteredBroker } from './registry.ts';

import type {
  Balances,
  BrokerAccount,
  BrokerEnvironment,
  Position,
  TaxTreatment
} from './contract.ts';

/**
 * One book across every connected brokerage.
 *
 * The premise, which is the user's: a position is a position. Holding 300
 * shares split 200/100 across two brokers is one 300-share bet, and sizing it
 * against a target weight per broker would produce a plan that is wrong at the
 * only level that matters. So the tools read every connected account and
 * combine them.
 *
 * Three things must survive the combining, and each is a way this could go
 * quietly wrong:
 *
 * 1. **Where a share actually sits.** A combined row keeps its legs. Selling
 *    is done at a broker, not at an aggregate, and a plan that cannot say
 *    which account to sell from is not actionable.
 * 2. **Tax treatment, which does not combine.** The same ticker in a Roth and
 *    a taxable account has no single answer to "does selling realise a gain?".
 *    That reads `mixed` and never collapses to one value.
 * 3. **Real and simulated money never mix.** A paper balance summed into a
 *    live one produces a cash figure someone could deploy against. Scoping
 *    refuses it outright rather than footnoting it.
 */

/** An account, tagged with the broker it came from. */
export interface AccountRef {
  readonly account: BrokerAccount;
  readonly brokerId: string;
  readonly brokerLabel: string;
  readonly environment: BrokerEnvironment;
  /** `etrade:abc123`. Unique across brokers, unlike the broker's own id. */
  readonly ref: string;
}

/** A broker that could not be read. Never fatal — the rest of the book is. */
export interface BrokerFailure {
  readonly brokerId: string;
  readonly label: string;
  readonly reason: string;
}

/** A broker deliberately left out, with the reason to show the user. */
export interface Exclusion {
  readonly brokerId: string;
  readonly label: string;
  readonly reason: string;
}

export interface BookScope {
  readonly accounts: readonly AccountRef[];
  /** The environment every included account is in. */
  readonly environment: BrokerEnvironment | undefined;
  readonly excluded: readonly Exclusion[];
  readonly failures: readonly BrokerFailure[];
}

export interface PositionLeg {
  readonly account: AccountRef;
  readonly position: Position;
}

export interface CombinedPosition {
  /** The date of `price`, never of anything else. */
  readonly asOf: string;
  readonly costBasis: Decimal | undefined;
  readonly legs: readonly PositionLeg[];
  readonly marketValue: Decimal;
  /** Fractional gap between the highest and lowest leg mark, when they differ. */
  readonly markSpread: Decimal | undefined;
  readonly price: Decimal;
  readonly shares: Decimal;
  /** Oldest leg mark. A combined row is only as fresh as its stalest leg. */
  readonly stalestAsOf: string;
  readonly taxTreatment: 'mixed' | TaxTreatment;
  readonly ticker: string;
  readonly unrealisedGain: Decimal | undefined;
}

export interface CombinedBalances {
  /** Oldest of the parts: a total is only as current as its stalest input. */
  readonly asOf: string;
  readonly cashAvailable: Decimal;
  readonly cashTotal: Decimal | undefined;
  /** How many accounts did not report a figure the total needed. */
  readonly incomplete: {
    cashTotal: number;
    openCalls: number;
    totalValue: number;
  };
  readonly openCalls: Decimal | undefined;
  readonly rows: readonly { account: AccountRef; balances: Balances }[];
  readonly totalValue: Decimal | undefined;
}

export interface Book {
  readonly balances: CombinedBalances | undefined;
  readonly failures: readonly BrokerFailure[];
  readonly positions: readonly CombinedPosition[];
  readonly scope: BookScope;
}

const reasonOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Which accounts are in scope, and which were left out and why.
 *
 * The environment rule is the load-bearing part. When one connected broker is
 * live and another is in its test book, the live one wins and the test one is
 * excluded by name. Summing a paper account's synthetic cash into a real
 * balance would produce a number an allocation could be sized against, and
 * E*TRADE's sandbox in particular answers with canned data — ask for GOOG, get
 * AAPL. Naming a single broker overrides this, because then the user has said
 * which book they mean.
 */
export async function openBook(
  options: { account?: string; broker?: string } = {}
): Promise<BookScope> {
  const connected = connectedBrokers();

  // An account ref is `<broker>:<id>`, and naming one is at least as explicit
  // a choice of book as naming the broker. Without this, asking for a paper
  // account by ref while another broker is live returned "no account
  // matches" — the environment arbitration having already discarded it.
  const namedBroker =
    options.broker ??
    (options.account?.includes(':') === true
      ? options.account.split(':')[0]
      : undefined);

  const wanted = namedBroker
    ? connected.filter(broker => broker.id === namedBroker)
    : connected;

  if (wanted.length === 0) {
    return { accounts: [], environment: undefined, excluded: [], failures: [] };
  }

  // An explicit broker or account is the user's choice of book, so no
  // environment arbitration applies — there is only one environment in play.
  const scoped = namedBroker
    ? wanted[0]!.adapter.environment()
    : liveWins(wanted);

  const excluded: Exclusion[] = wanted
    .filter(broker => broker.adapter.environment() !== scoped)
    .map(broker => ({
      brokerId: broker.id,
      label: broker.adapter.label(),
      reason:
        `in its ${broker.adapter.environmentLabel(broker.adapter.environment())} ` +
        `book while ${scoped === 'live' ? 'real money is' : 'the rest of the book is'} ` +
        'in play. Simulated positions are not summed into a real one'
    }));

  const included = wanted.filter(
    broker => broker.adapter.environment() === scoped
  );

  const accounts: AccountRef[] = [];
  const failures: BrokerFailure[] = [];

  for (const broker of included) {
    try {
      // Sequential on purpose: every upstream is rate limited, and the whole
      // codebase serialises rather than racing a limit it knows about.
      // eslint-disable-next-line no-await-in-loop
      const listed = await broker.adapter.accounts();
      accounts.push(
        ...listed.map(account => ({
          account,
          brokerId: broker.id,
          brokerLabel: broker.adapter.label(),
          environment: broker.adapter.environment(),
          ref: `${broker.id}:${account.id}`
        }))
      );
    } catch (error) {
      failures.push({
        brokerId: broker.id,
        label: broker.adapter.label(),
        reason: reasonOf(error)
      });
    }
  }

  // A closed account cannot be sold out of, so its holdings must not swell a
  // combined position into an order nobody can fill. Naming it explicitly is
  // still honoured — reading a closed account is a legitimate thing to want.
  const closed = accounts.filter(entry => !entry.account.active);
  const live = options.account
    ? accounts
    : accounts.filter(entry => entry.account.active);

  for (const entry of closed) {
    if (options.account) break;
    excluded.push({
      brokerId: entry.brokerId,
      label: `${entry.brokerLabel} ${entry.account.number}`,
      reason:
        `is ${entry.account.status.toLowerCase()}. Nothing in it can be sold, ` +
        'so counting its holdings would inflate a position'
    });
  }

  const filtered = options.account
    ? live.filter(
        entry =>
          entry.ref === options.account || entry.account.id === options.account
      )
    : live;

  return {
    accounts: sortBy(filtered, entry => entry.ref),
    environment: scoped,
    excluded,
    failures
  };
}

/** Live outranks test whenever both are connected. */
function liveWins(brokers: readonly RegisteredBroker[]): BrokerEnvironment {
  return brokers.some(broker => broker.adapter.environment() === 'live')
    ? 'live'
    : 'test';
}

/**
 * Reads every account in scope and combines the results.
 *
 * One account failing does not fail the book: a dropped connection at one
 * broker must not hide the positions at another, and a plan built from a book
 * that silently lost a broker is worse than one that says a broker is missing.
 */
export async function readBook(scope: BookScope): Promise<Book> {
  const legs: PositionLeg[] = [];
  const rows: { account: AccountRef; balances: Balances }[] = [];
  const failures: BrokerFailure[] = [...scope.failures];

  for (const account of scope.accounts) {
    const adapter = brokerFor(account.brokerId);
    if (!adapter) continue;

    try {
      // eslint-disable-next-line no-await-in-loop
      const positions = await adapter.adapter.positions(account.account.id);
      legs.push(...positions.map(position => ({ account, position })));
    } catch (error) {
      failures.push({
        brokerId: account.brokerId,
        label: `${account.brokerLabel} ${account.account.number} positions`,
        reason: reasonOf(error)
      });
    }

    try {
      // eslint-disable-next-line no-await-in-loop
      const balances = await adapter.adapter.balances(account.account.id);
      rows.push({ account, balances });
    } catch (error) {
      failures.push({
        brokerId: account.brokerId,
        label: `${account.brokerLabel} ${account.account.number} balances`,
        reason: reasonOf(error)
      });
    }
  }

  return {
    balances: combineBalances(rows),
    failures,
    positions: combinePositions(legs),
    scope
  };
}

function brokerFor(id: string): RegisteredBroker | undefined {
  return connectedBrokers().find(broker => broker.id === id);
}

/**
 * Folds every leg of a ticker into one row.
 *
 * `price` is the newest leg's mark and `asOf` is that same leg's date — a
 * price and a date that came from different rows is the exact failure this
 * codebase exists to prevent. Market value follows from the pair, so the
 * arithmetic on screen is self-consistent, and where two brokers disagree
 * about the mark, `markSpread` says so rather than the difference vanishing
 * into a total.
 */
export function combinePositions(
  legs: readonly PositionLeg[]
): CombinedPosition[] {
  const combined = Object.values(groupBy(legs, leg => leg.position.ticker)).map(
    group => {
      // Newest mark wins, broker id breaking a tie so the choice is stable.
      const ordered = sortBy(group, [
        leg => leg.position.asOf,
        leg => leg.account.ref
      ]);
      const newest = ordered.at(-1)!;
      const shares = group.reduce(
        (total, leg) => total.plus(leg.position.shares),
        ZERO
      );

      const treatments = uniq(
        group.map(leg => leg.account.account.taxTreatment)
      );

      return {
        asOf: newest.position.asOf,
        costBasis: combineOptional(group, leg => leg.position.costBasis),
        legs: sortBy(group, leg => leg.account.ref),
        marketValue: newest.position.price.times(shares),
        markSpread: spread(group.map(leg => leg.position.price)),
        price: newest.position.price,
        shares,
        stalestAsOf: ordered[0]!.position.asOf,
        taxTreatment: treatments.length === 1 ? treatments[0]! : 'mixed',
        ticker: newest.position.ticker,
        unrealisedGain: combineOptional(
          group,
          leg => leg.position.unrealisedGain
        )
      } satisfies CombinedPosition;
    }
  );

  return sortBy(combined, position => position.ticker);
}

/**
 * Sums a per-leg figure, or reports nothing.
 *
 * All-or-nothing by design: a total assembled from the legs that happened to
 * report one is not the book's cost basis, it is a fragment presented as a
 * whole. A long leg netted against a short one is worse still — the legs were
 * opened for opposite reasons and their combined "cost" is not a quantity that
 * exists.
 */
function combineOptional(
  legs: readonly PositionLeg[],
  pick: (leg: PositionLeg) => Decimal | undefined
): Decimal | undefined {
  const opposed =
    legs.some(leg => leg.position.shares.isNegative()) &&
    legs.some(leg => !leg.position.shares.isNegative());
  if (opposed) return undefined;

  const values = legs.map(pick);
  if (values.some(value => value === undefined)) return undefined;
  return values.reduce<Decimal>((total, value) => total.plus(value!), ZERO);
}

/** How far apart two brokers' marks are, as a fraction of the lower one. */
function spread(prices: readonly Decimal[]): Decimal | undefined {
  if (prices.length < 2) return undefined;
  const ordered = sortBy(prices, price => price.toNumber());
  const low = ordered[0]!;
  const high = ordered.at(-1)!;
  if (!gtZero(low) || low.eq(high)) return undefined;
  return div(high.minus(low), low);
}

function combineBalances(
  rows: readonly { account: AccountRef; balances: Balances }[]
): CombinedBalances | undefined {
  if (rows.length === 0) return undefined;

  const sum = (pick: (balances: Balances) => Decimal | undefined) => {
    const values = rows.map(row => pick(row.balances));
    const known = values.filter(
      (value): value is Decimal => value !== undefined
    );
    return {
      missing: values.length - known.length,
      total:
        known.length === 0
          ? undefined
          : known.reduce<Decimal>((running, value) => running.plus(value), ZERO)
    };
  };

  const cashTotal = sum(balances => balances.cashTotal);
  const openCalls = sum(balances => balances.openCalls);
  const totalValue = sum(balances => balances.totalValue);

  return {
    // A sum is as current as its stalest part, so the oldest date labels it.
    asOf: sortBy(rows, row => row.balances.asOf)[0]!.balances.asOf,
    cashAvailable: rows.reduce(
      (total, row) => total.plus(row.balances.cashAvailable),
      ZERO
    ),
    cashTotal: cashTotal.total,
    incomplete: {
      cashTotal: cashTotal.missing,
      openCalls: openCalls.missing,
      totalValue: totalValue.missing
    },
    openCalls: openCalls.total,
    rows: sortBy(rows, row => row.account.ref),
    totalValue: totalValue.total
  };
}

/**
 * The book's tax treatment, for the `plan_rebalance` handoff.
 *
 * Anything but unanimity is `unknown`, which is the value that fabricates
 * nothing. `mixed` would have to be interpreted by the caller, and every
 * interpretation of it is a claim about which account a sale comes out of —
 * a claim only the user can make.
 */
export function bookTaxTreatment(
  accounts: readonly AccountRef[]
): TaxTreatment {
  const treatments = uniq(accounts.map(entry => entry.account.taxTreatment));
  return treatments.length === 1 ? treatments[0]! : 'unknown';
}
