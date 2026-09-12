import { groupBy, keyBy, sortBy, sumBy } from 'lodash-es';

import { realisesGain, type TaxTreatment } from '../broker/contract.ts';
import {
  Decimal,
  dec,
  div,
  gtZero,
  money,
  out,
  ZERO
} from '../math/decimal.ts';
import { estimateFees, participation, type FeeSchedule } from './fees.ts';

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
  /**
   * Typical dollar volume in a session. Supply it to learn what fraction of a
   * normal day an order represents — the cost that actually matters here, and
   * the only one computable without data no free provider exposes.
   * `price_history_stats` reports it.
   */
  readonly averageDailyVolume?: Decimal;
  /** Broker-reported aggregate basis. Absent means the broker did not supply one. */
  readonly costBasis?: Decimal;
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
  /**
   * The broker's own charges. Omit and no fee is estimated — better than
   * asserting zero, which is right for a buy and wrong for a sale.
   */
  readonly feeSchedule?: FeeSchedule;
  readonly holdings: readonly Holding[];
  /** Don't emit an order whose notional is below this. Default 0. */
  readonly minTradeValue?: Decimal;
  readonly targets: readonly TargetWeight[];
  /**
   * How a sale in this account is taxed. Omit when unknown — never default it
   * to `taxable`, which would fabricate a cost the data does not support.
   */
  readonly taxTreatment?: TaxTreatment;
}

export interface Order {
  readonly asOf: string;
  /** Broker-reported basis for the whole position, when supplied. */
  readonly costBasis?: number;
  readonly currentShares: number;
  readonly currentValue: number;
  readonly driftFraction: number;
  /**
   * Statutory fees plus commission. **Not the cost of the trade.** Selling
   * $10,000 costs about $0.41 here, while spread and market impact on a
   * micro cap run to a hundred times that — so read `participation` first,
   * and treat this as the small, knowable part.
   */
  readonly estimatedFees?: number;
  readonly estimatedProceeds: number;
  /**
   * `estimatedProceeds − costBasis`, on a FULL exit only, and only when the
   * account is taxable and the basis is known.
   *
   * A full exit is lot-independent: every lot goes, so the figure is exact
   * whatever basis method the account uses. A partial sell is deliberately left
   * absent rather than estimated — the gain depends on *which* shares go, and
   * the tempting pro-rata shortcut is average cost, which is not a permitted
   * basis method for individual equities at all. An inadmissible method's
   * output has no defensible label.
   *
   * Absent means "not computed", never zero. Not a tax figure: no fees, no
   * wash-sale or basis adjustment, no holding-period split.
   */
  readonly gainOnExit?: number;
  /**
   * The order as a fraction of a normal session's dollar volume. Absent when
   * no volume was supplied — an unknown participation is not a small one.
   */
  readonly participation?: number;
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
      // Basis sums only when the lots point the same way. Netting a long
      // against a short would produce a "cost" for a position nobody bought as
      // one, so the aggregate is dropped rather than made up.
      const opposed =
        lots.some(lot => lot.shares.isNegative()) &&
        lots.some(lot => !lot.shares.isNegative());
      const known = lots.filter(lot => lot.costBasis !== undefined);

      return {
        asOf: newest.asOf,
        // A property of the security, not of the lot, so the newest reading
        // wins rather than being summed.
        averageDailyVolume: newest.averageDailyVolume,
        costBasis:
          opposed || known.length === 0
            ? undefined
            : known.reduce<Decimal>(
                (total, lot) => total.plus(lot.costBasis ?? ZERO),
                ZERO
              ),
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

    // Exact only because the whole position goes: every lot is sold, so the
    // figure holds whatever basis method the account uses.
    const fullExit = targetShares.isZero() && gtZero(currentShares);
    const gainOnExit =
      fullExit &&
      holding?.costBasis &&
      realisesGain(input.taxTreatment ?? 'unknown')
        ? currentValue.minus(holding.costBasis)
        : undefined;

    const fees = input.feeSchedule
      ? estimateFees({
          notional,
          schedule: input.feeSchedule,
          shares: shareDelta,
          side: gtZero(shareDelta) ? 'buy' : 'sell'
        })
      : undefined;

    const dayShare = participation(notional, holding?.averageDailyVolume);

    const order: Order = {
      asOf,
      costBasis: money(holding?.costBasis),
      currentShares: out(currentShares, allowFractionalShares ? 4 : 0) ?? 0,
      currentValue: money(currentValue) ?? 0,
      driftFraction: out(drift) ?? 0,
      estimatedFees: money(fees?.total),
      estimatedProceeds: money(notional) ?? 0,
      gainOnExit: money(gainOnExit),
      participation: out(dayShare, 4),
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

  // Participation is where the real cost lives, so a heavy order gets said out
  // loud rather than left in a column. 20% of a session is the point at which
  // an order stops being absorbed and starts moving the price against itself.
  const heavy = [...buys, ...sells, ...exits].filter(
    order => order.participation !== undefined && order.participation > 0.2
  );
  if (heavy.length > 0) {
    notes.push(
      `${heavy.length} order(s) exceed 20% of a normal session's volume: ` +
        `${heavy.map(order => `${order.ticker} at ${Math.round((order.participation ?? 0) * 100)}%`).join(', ')}. ` +
        'That is where execution cost actually lives — spread and impact on a ' +
        'thin name run to a hundred times the statutory fees — and in a ' +
        'deep-value book it is a live risk, because the discount is often ' +
        'caused by the illiquidity. Work the order over days, or size it down.'
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
