import { div, gtZero, type Decimal } from '../math/decimal.ts';

/**
 * Cross-checks the filing's share count against the vendor's.
 *
 * A price is quoted per *traded unit*. For most US filers that is the same
 * thing the 10-Q counts, and the two agree. For a foreign private issuer with
 * an ADR it is not: Amarin's 10-Q reports 420,044,022 ordinary shares while
 * 21,122,834 ADSs trade, twenty ordinaries to one ADS. Dividing a market
 * price by the ordinary count made every per-share figure wrong by exactly
 * that ratio — P/TBV came out at 13.07 on a company trading at 0.66× book,
 * which reads as "expensive" rather than as "wrong".
 *
 * An unadjusted split produces the same shape, which is why the check is on
 * the ratio rather than on anything ADR-specific.
 *
 * This deliberately does not pick a winner. The filing is authoritative about
 * the company and the vendor is authoritative about what trades, so neither is
 * "the" share count — the caller is told both, and told the figures are
 * unsafe until it knows which unit the price belongs to.
 */

/** Beyond this the two counts are not describing the same unit. */
const TOLERANCE = 0.1;

export interface ShareCountCheck {
  /** The nearest whole number to `ratio`, when the ratio is close to one. */
  readonly impliedUnit: number | undefined;
  /** True when the two disagree by more than a rounding's worth. */
  readonly inconsistent: boolean;
  /** Filing count over vendor count. ~20 for a 20:1 ADR. */
  readonly ratio: Decimal | undefined;
}

export function checkShareCounts(
  filingShares: Decimal | undefined,
  vendorShares: Decimal | undefined
): ShareCountCheck {
  if (!gtZero(filingShares) || !gtZero(vendorShares)) {
    // No cross-check available is not a clean bill of health.
    return { impliedUnit: undefined, inconsistent: false, ratio: undefined };
  }

  const ratio = div(filingShares, vendorShares);
  if (!ratio) {
    return { impliedUnit: undefined, inconsistent: false, ratio: undefined };
  }

  const inconsistent = ratio.minus(1).abs().gt(TOLERANCE);
  if (!inconsistent) {
    return { impliedUnit: undefined, inconsistent: false, ratio };
  }

  // A ratio landing on a whole number is the signature of a bundling ratio or
  // an unadjusted split, rather than of two counts taken on different days.
  // The comparison is relative: Amarin's counts are dated weeks apart and come
  // to 19.886, which is 0.6% off twenty and unmistakably a 20:1 ratio, while
  // an absolute tolerance tight enough for a ratio of 2 would reject it.
  const nearest = ratio.toDecimalPlaces(0).toNumber();
  const whole =
    nearest >= 2 && ratio.minus(nearest).abs().div(nearest).lt('0.02')
      ? nearest
      : undefined;

  return { impliedUnit: whole, inconsistent: true, ratio };
}
