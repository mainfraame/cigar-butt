import { groupBy, keyBy, sortBy, sumBy } from 'lodash-es';

import {
  Decimal,
  dec,
  div,
  gtZero,
  money,
  out,
  ZERO
} from '../math/decimal.ts';

/**
 * Turning a target allocation into orders.
 *
 * The comparison is always current *market value* against target market value,
 * never share count against share count: a name that has doubled is overweight
 * even though its share count never moved, and that is precisely the position
 * Schloss's "selling is harder than buying" advice is about.
 */

interface Holding {
  /** ISO date of `price`. */
  readonly asOf: string;
  /** Price the position is currently marked at. */
  readonly price: Decimal;
  readonly shares: Decimal;
  readonly ticker: string;
}

interface TargetWeight {
  readonly asOf: string;
  readonly price: Decimal;
  readonly ticker: string;
  /** Fraction of the total portfolio. Normalised by the caller or here. */
  readonly weight: Decimal;
}

export interface RebalanceInput {
  /** Allow fractional-share orders. Off by default. */
  readonly allowFractionalShares?: boolean;
  /** Uninvested cash to fold into the portfolio value. */
  readonly availableCash: Decimal;
  /** Ignore drift smaller than this fraction of the target. Default 0.05. */
  readonly driftTolerance?: Decimal;
  readonly holdings: readonly Holding[];
  /** Don't emit an order whose notional is below this. Default 0. */
  readonly minTradeValue?: Decimal;
  readonly targets: readonly TargetWeight[];
}

export interface Order {
  readonly asOf: string;
  readonly currentShares: number;
  readonly currentValue: number;
  readonly driftFraction: number;
  readonly estimatedProceeds: number;
  readonly price: number;
  readonly shares: number;
  readonly side: 'buy' | 'sell';
  readonly targetShares: number;
  readonly targetValue: number;
  readonly ticker: string;
}

export interface RebalancePlan {
  readonly buys: readonly Order[];
  readonly cashAfter: number;
  /** Positions held but absent from the targets — full exits. */
  readonly exits: readonly Order[];
  readonly netCashFlow: number;
  readonly notes: readonly string[];
  readonly portfolioValue: number;
  readonly sells: readonly Order[];
  /** Names inside tolerance. Listed so silence is not mistaken for an omission. */
  readonly unchanged: readonly { driftFraction: number; ticker: string }[];
}

const DEFAULT_DRIFT_TOLERANCE = '0.05';

/** Currency for prose. Notes read as money, not as a bare float. */
const asUsd = (value: Decimal): string =>
  (money(value) ?? 0).toLocaleString('en-US', {
    currency: 'USD',
    maximumFractionDigits: 2,
    style: 'currency'
  });

/**
 * Nets multiple lots of the same ticker into one position.
 *
 * A broker reports lots, not positions: E*TRADE returns a long and a short leg
 * of the same symbol as separate rows. Keying straight off the array would keep
 * whichever came last and silently discard the rest — a holding vanishing from
 * a rebalance without a word is exactly the failure this codebase exists to
 * avoid. The price of the most recently marked lot wins, because a stale mark
 * is the worse of the two.
 */
function mergeHoldings(holdings: readonly Holding[]): Holding[] {
  return Object.values(groupBy(holdings, holding => holding.ticker)).map(
    lots => {
      const newest = sortBy(lots, lot => lot.asOf).at(-1);
      /* c8 ignore next -- groupBy never produces an empty group. */
      if (!newest) throw new Error('empty holding group');
      return {
        asOf: newest.asOf,
        price: newest.price,
        shares: lots.reduce((total, lot) => total.plus(lot.shares), ZERO),
        ticker: newest.ticker
      };
    }
  );
}

function roundShares(value: Decimal, fractional: boolean): Decimal {
  return fractional
    ? value.toDecimalPlaces(4, Decimal.ROUND_DOWN)
    : value.toDecimalPlaces(0, Decimal.ROUND_DOWN);
}

/**
 * Produces buys, sells, and full exits that move the book toward the targets.
 *
 * Sells are computed before buys and reported first, because the proceeds fund
 * the buys — a plan whose buys assume cash the sells have not yet raised is not
 * executable.
 */
export function planRebalance(input: RebalanceInput): RebalancePlan {
  const {
    allowFractionalShares = false,
    availableCash,
    driftTolerance = dec(DEFAULT_DRIFT_TOLERANCE) ?? ZERO,
    holdings,
    minTradeValue = ZERO,
    targets
  } = input;

  const notes: string[] = [];

  // Merge once and use the result everywhere. Valuing raw lots while comparing
  // merged positions would price the same book two different ways inside one
  // function.
  const merged = mergeHoldings(holdings);
  const holdingsByTicker = keyBy(merged, holding => holding.ticker);
  const targetsByTicker = keyBy(targets, target => target.ticker);

  const holdingsValue = merged.reduce(
    (total, holding) => total.plus(holding.shares.times(holding.price)),
    ZERO
  );
  const portfolioValue = holdingsValue.plus(availableCash);

  if (!gtZero(portfolioValue)) {
    return {
      buys: [],
      cashAfter: money(availableCash) ?? 0,
      exits: [],
      netCashFlow: 0,
      notes: ['Portfolio value is zero — nothing to rebalance.'],
      portfolioValue: 0,
      sells: [],
      unchanged: []
    };
  }

  const weightTotal = targets.reduce(
    (total, target) => total.plus(target.weight),
    ZERO
  );
  if (weightTotal.isZero() && targets.length > 0) {
    notes.push(
      'All target weights are zero — treating the plan as a full liquidation.'
    );
  }

  const buys: Order[] = [];
  const sells: Order[] = [];
  const exits: Order[] = [];
  const unchanged: { driftFraction: number; ticker: string }[] = [];

  // Every ticker on either side of the comparison.
  const tickers = sortBy([
    ...new Set([
      ...Object.keys(holdingsByTicker),
      ...Object.keys(targetsByTicker)
    ])
  ]);

  for (const ticker of tickers) {
    const holding = holdingsByTicker[ticker];
    const target = targetsByTicker[ticker];

    const price = target?.price ?? holding?.price;
    const asOf = target?.asOf ?? holding?.asOf ?? 'unknown';
    if (!gtZero(price)) {
      notes.push(`${ticker}: no usable price, so no order was generated.`);
      continue;
    }

    const currentShares = holding?.shares ?? ZERO;
    const currentValue = currentShares.times(price);

    const normalisedWeight = target
      ? (div(target.weight, weightTotal) ?? ZERO)
      : ZERO;
    const targetValue = portfolioValue.times(normalisedWeight);
    const targetShares = roundShares(
      div(targetValue, price) ?? ZERO,
      allowFractionalShares
    );

    const shareDelta = targetShares.minus(currentShares);
    const notional = shareDelta.abs().times(price);

    // Drift measured against the target, except for a position with no target
    // at all, where "100% drift" is the honest reading.
    const drift = targetValue.isZero()
      ? currentValue.isZero()
        ? ZERO
        : new Decimal(1)
      : (div(currentValue.minus(targetValue).abs(), targetValue) ?? ZERO);

    if (shareDelta.isZero()) {
      if (!currentShares.isZero() || target) {
        unchanged.push({ driftFraction: out(drift) ?? 0, ticker });
      }
      continue;
    }

    const isExit = !target && gtZero(currentShares);

    // Tolerance is a de-minimis filter, not a hold signal: an exit is never
    // suppressed by it, because a name that failed the screen should leave the
    // book regardless of how close its weight happens to sit.
    if (!isExit && drift.lt(driftTolerance)) {
      unchanged.push({ driftFraction: out(drift) ?? 0, ticker });
      continue;
    }
    if (!isExit && notional.lt(minTradeValue)) {
      unchanged.push({ driftFraction: out(drift) ?? 0, ticker });
      continue;
    }

    const order: Order = {
      asOf,
      currentShares: out(currentShares, allowFractionalShares ? 4 : 0) ?? 0,
      currentValue: money(currentValue) ?? 0,
      driftFraction: out(drift) ?? 0,
      estimatedProceeds: money(notional) ?? 0,
      price: money(price) ?? 0,
      shares: out(shareDelta.abs(), allowFractionalShares ? 4 : 0) ?? 0,
      side: gtZero(shareDelta) ? 'buy' : 'sell',
      targetShares: out(targetShares, allowFractionalShares ? 4 : 0) ?? 0,
      targetValue: money(targetValue) ?? 0,
      ticker
    };

    if (isExit) exits.push(order);
    else if (order.side === 'buy') buys.push(order);
    else sells.push(order);
  }

  const proceeds = sumBy(
    [...sells, ...exits],
    order => order.estimatedProceeds
  );
  const outlay = sumBy(buys, order => order.estimatedProceeds);
  const netCashFlow = (dec(proceeds) ?? ZERO).minus(dec(outlay) ?? ZERO);
  const cashAfter = availableCash.plus(netCashFlow);

  if (cashAfter.isNegative()) {
    notes.push(
      `Buys exceed cash plus sale proceeds by ${asUsd(cashAfter.abs())}. Execute the sells first, ` +
        'or trim the buy list — the orders below are not simultaneously fundable.'
    );
  }

  if (exits.length > 0) {
    notes.push(
      `${exits.length} position(s) are held but absent from the targets and are ` +
        'listed as full exits. Confirm each is a deliberate removal and not a ' +
        'name that merely failed to price this run.'
    );
  }

  const stale = [...buys, ...sells, ...exits].filter(
    order => order.asOf === 'unknown'
  );
  if (stale.length > 0) {
    notes.push(
      `${stale.length} order(s) carry no price date. Do not execute on an undated price.`
    );
  }

  return {
    buys: sortBy(buys, order => order.ticker),
    cashAfter: money(cashAfter) ?? 0,
    exits: sortBy(exits, order => order.ticker),
    netCashFlow: money(netCashFlow) ?? 0,
    notes,
    portfolioValue: money(portfolioValue) ?? 0,
    sells: sortBy(sells, order => order.ticker),
    unchanged: sortBy(unchanged, entry => entry.ticker)
  };
}
