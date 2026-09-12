import { sortBy, sumBy } from 'lodash-es';

import {
  Decimal,
  dec,
  div,
  gtZero,
  money,
  out,
  ZERO
} from '../math/decimal.ts';

/** Currency for prose. Warnings read as money, not as a bare float. */
const asUsd = (value: Decimal): string =>
  (money(value) ?? 0).toLocaleString('en-US', {
    currency: 'USD',
    maximumFractionDigits: 2,
    style: 'currency'
  });

/**
 * Position sizing.
 *
 * Schloss ran 60 to 100 names at roughly equal weight, and equal weight is the
 * point: the method deliberately distrusts per-name conviction, so a weighting
 * scheme that expresses conviction is a different strategy wearing the same
 * name. The default here is equal weight, and the deviations are mechanical
 * (a per-name cap, whole-share rounding) rather than judgemental.
 */

interface AllocationCandidate {
  /** ISO date of `price`. Refused if absent — an undated price is unusable. */
  readonly asOf: string;
  readonly price: Decimal;
  /** Optional per-name conviction weight. Defaults to equal weight. */
  readonly ticker: string;
  readonly weight?: Decimal;
}

export interface AllocationInput {
  /** Allow fractional shares. Off by default: most brokers settle whole lots. */
  readonly allowFractionalShares?: boolean;
  /** Cash the user has to deploy. */
  readonly availableCash: Decimal;
  readonly candidates: readonly AllocationCandidate[];
  /** Hard ceiling on any one name, as a fraction of `availableCash`. */
  readonly maxPositionFraction?: Decimal;
  /** Per-trade commission, subtracted before sizing. */
  readonly perTradeCost?: Decimal;
}

interface AllocationLine {
  readonly asOf: string;
  readonly cost: number;
  readonly price: number;
  readonly shares: number;
  readonly targetValue: number;
  readonly ticker: string;
  readonly weight: number;
}

export interface AllocationPlan {
  readonly deployedCash: number;
  readonly lines: readonly AllocationLine[];
  /** Names dropped because one share cost more than their budget. */
  readonly notFunded: readonly { reason: string; ticker: string }[];
  readonly residualCash: number;
  readonly totalCommission: number;
  readonly warnings: readonly string[];
}

const DEFAULT_MAX_POSITION = '0.10';

/**
 * Turns a candidate list and a cash balance into whole-share targets.
 *
 * Whole-share rounding always rounds *down*, so the plan can never exceed the
 * balance. The leftover shows up as `residualCash` rather than being quietly
 * spread around.
 */
export function allocate(input: AllocationInput): AllocationPlan {
  const {
    allowFractionalShares = false,
    availableCash,
    candidates,
    maxPositionFraction = dec(DEFAULT_MAX_POSITION) ?? ZERO,
    perTradeCost = ZERO
  } = input;

  const warnings: string[] = [];
  const notFunded: { reason: string; ticker: string }[] = [];

  if (candidates.length === 0) {
    return {
      deployedCash: 0,
      lines: [],
      notFunded: [],
      residualCash: money(availableCash) ?? 0,
      totalCommission: 0,
      warnings: ['No candidates supplied — nothing to allocate.']
    };
  }

  if (candidates.length < 15) {
    warnings.push(
      `${candidates.length} names. Schloss ran 60 to 100 and Graham wanted 15 to 20 minimum; ` +
        'below that, single-name risk swamps the statistical edge the method depends on.'
    );
  }

  const commission = perTradeCost.times(candidates.length);
  const investable = availableCash.minus(commission);
  if (!gtZero(investable)) {
    return {
      deployedCash: 0,
      lines: [],
      notFunded: candidates.map(c => ({
        reason: 'Commissions exceed the available balance.',
        ticker: c.ticker
      })),
      residualCash: money(availableCash) ?? 0,
      totalCommission: money(commission) ?? 0,
      warnings: [
        ...warnings,
        `Estimated commissions (${asUsd(commission)}) exceed available cash.`
      ]
    };
  }

  // Normalise weights. Equal weight unless the caller supplied their own.
  const rawWeights = candidates.map(c => c.weight ?? new Decimal(1));
  const weightTotal = rawWeights.reduce((total, w) => total.plus(w), ZERO);

  const cap = gtZero(maxPositionFraction)
    ? investable.times(maxPositionFraction)
    : investable;

  const lines: AllocationLine[] = [];
  for (const [index, candidate] of candidates.entries()) {
    const raw = rawWeights[index] ?? ZERO;
    // Multiply before dividing. Normalising the weight first rounds 1/3 to 34
    // digits and then scales the error up, which is enough to turn a $10,000
    // budget into $9,999.99…9 and cost a whole share at $10.
    const uncapped = div(investable.times(raw), weightTotal) ?? ZERO;
    const targetValue = Decimal.min(uncapped, cap);
    const weight = div(raw, weightTotal) ?? ZERO;

    if (!gtZero(candidate.price)) {
      notFunded.push({
        reason: 'Non-positive price — refusing to size a position on it.',
        ticker: candidate.ticker
      });
      continue;
    }

    const exactShares = targetValue.div(candidate.price);
    const shares = allowFractionalShares
      ? exactShares.toDecimalPlaces(4, Decimal.ROUND_DOWN)
      : exactShares.floor();

    if (!gtZero(shares)) {
      notFunded.push({
        reason: `One share costs ${asUsd(candidate.price)} but the per-name budget is ${asUsd(targetValue)}.`,
        ticker: candidate.ticker
      });
      continue;
    }

    lines.push({
      asOf: candidate.asOf,
      cost: money(shares.times(candidate.price)) ?? 0,
      price: money(candidate.price) ?? 0,
      shares: out(shares, allowFractionalShares ? 4 : 0) ?? 0,
      targetValue: money(targetValue) ?? 0,
      ticker: candidate.ticker,
      weight: out(weight, 4) ?? 0
    });
  }

  const deployed = sumBy(lines, line => line.cost);
  const actualCommission = perTradeCost.times(lines.length);

  if (notFunded.length > 0) {
    warnings.push(
      `${notFunded.length} name(s) could not be funded at whole-share granularity. ` +
        'Either raise the balance, raise the per-name cap, or enable fractional shares.'
    );
  }

  const residual = availableCash.minus(deployed).minus(actualCommission);
  if (div(residual, availableCash)?.gt('0.05')) {
    warnings.push(
      `${asUsd(residual)} (over 5% of the balance) is left undeployed after whole-share rounding.`
    );
  }

  return {
    deployedCash: money(dec(deployed)) ?? 0,
    lines: sortBy(lines, line => line.ticker),
    notFunded: sortBy(notFunded, entry => entry.ticker),
    residualCash: money(residual) ?? 0,
    totalCommission: money(actualCommission) ?? 0,
    warnings
  };
}
