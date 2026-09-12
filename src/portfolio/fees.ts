import { type Decimal, dec, ZERO } from '../math/decimal.ts';

/**
 * Execution cost, to the extent it can honestly be computed.
 *
 * Read this before adding to it, because the proportions are not what a fee
 * schedule suggests. Selling $10,000 costs about **$0.41** all-in at both
 * brokers this server supports — commission is zero at each, and what remains
 * is two statutory fees. The modelled round-trip **spread and market impact**
 * on a $50,000 position in a name trading $200k a day is **4–8%**, or
 * $2,000–$4,000. The ratio is roughly 100:1.
 *
 * So the danger here is precision without proportion: a penny-exact "estimated
 * cost" that omits the part costing a thousand times more gets read as *the*
 * cost. Everything below is therefore labelled as statutory fees only, and the
 * larger number is addressed by reporting **participation** — what fraction of
 * a normal day's volume an order represents — rather than by inventing a dollar
 * figure for it.
 *
 * The spread genuinely cannot be observed from here. Across all eight quote
 * providers configured in this server, bid/ask is either premium, behind an
 * exchange agreement, or IEX-only — and IEX is on both sides of the NBBO only
 * about 30% of the time even within the Russell 3000. Both halves of an
 * estimate are missing, and half an estimate is worse than none.
 */

/**
 * SEC Section 31, on **sales only**.
 *
 * This rate goes stale violently: it has been $27.80, then $0.00, then $20.60
 * per million within sixteen months, and the SEC resets it on no predictable
 * date. Treat a computed figure as indicative and check the current advisory
 * before relying on one.
 */
const SEC_RATE_PER_DOLLAR = '0.0000206';
const SEC_RATE_EFFECTIVE = '2026-04-04';

/** FINRA Trading Activity Fee, on **sales only**, per share with a cap. */
const TAF_PER_SHARE = '0.000195';
const TAF_CAP = '9.79';
const TAF_EFFECTIVE = '2026-01-01';

export interface FeeSchedule {
  /** Per-trade commission for a listed equity. Zero at both brokers today. */
  readonly commission: Decimal;
  /** Surcharge for an OTC / grey-market name, where the broker levies one. */
  readonly otcSurcharge: Decimal;
}

export interface EstimatedFees {
  readonly commission: Decimal;
  /** The dates the statutory rates took effect, so staleness is visible. */
  readonly ratesEffective: string;
  readonly secFee: Decimal;
  readonly taf: Decimal;
  readonly total: Decimal;
}

/**
 * Statutory fees plus commission for one order.
 *
 * Both regulatory fees are **sell-side only** — FINRA's own wording is that
 * members are assessed for "the sale of covered securities". A buy therefore
 * costs only commission, which is why `allocate`'s default per-trade cost of
 * zero is correct rather than merely unset.
 */
export function estimateFees({
  notional,
  schedule,
  shares,
  side
}: {
  notional: Decimal;
  schedule: FeeSchedule;
  shares: Decimal;
  side: 'buy' | 'sell';
}): EstimatedFees {
  const commission = schedule.commission;

  if (side === 'buy') {
    return {
      commission,
      ratesEffective: `${SEC_RATE_EFFECTIVE} / ${TAF_EFFECTIVE}`,
      secFee: ZERO,
      taf: ZERO,
      total: commission
    };
  }

  const secFee = notional
    .times(dec(SEC_RATE_PER_DOLLAR) ?? ZERO)
    // The pass-through is rounded up to the next penny, not to nearest.
    .toDecimalPlaces(2, 0);

  const rawTaf = shares.abs().times(dec(TAF_PER_SHARE) ?? ZERO);
  const cap = dec(TAF_CAP) ?? ZERO;
  const taf = (rawTaf.gt(cap) ? cap : rawTaf).toDecimalPlaces(2, 0);

  return {
    commission,
    ratesEffective: `${SEC_RATE_EFFECTIVE} / ${TAF_EFFECTIVE}`,
    secFee,
    taf,
    total: commission.plus(secFee).plus(taf)
  };
}

/**
 * What fraction of a normal session an order represents.
 *
 * This is the figure that actually matters, and the only one available without
 * data nobody here can reach. An order at 5% of a day's volume is ordinary; one
 * at 200% is not an order, it is a project — and in a deep-value book that is a
 * live risk, because the discount is frequently *caused* by the illiquidity.
 *
 * `undefined` when no volume figure was supplied: an unknown participation is
 * not a small one.
 */
export function participation(
  notional: Decimal,
  averageDailyVolume: Decimal | undefined
): Decimal | undefined {
  if (!averageDailyVolume || !averageDailyVolume.gt(0)) return undefined;
  return notional.div(averageDailyVolume);
}
