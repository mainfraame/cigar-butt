import { Decimal } from 'decimal.js';

/**
 * All arithmetic in this server goes through decimal.js.
 *
 * Two reasons, and only the second is about pennies. The first is that these
 * numbers are compared against hard thresholds — P/TBV against 1.0, price
 * against two-thirds of NCAV — and binary floating point puts a name on the
 * wrong side of a threshold often enough to matter when the whole method is
 * "buy below the line". The second is share counts: an allocation that sizes
 * whole shares from a cash balance must not leave the user overdrawn by a
 * float's worth of rounding.
 *
 * The rule for this codebase: `number` appears at the I/O boundary (JSON in
 * from an API, JSON out to the MCP client) and nowhere in between.
 */

// 34 significant digits — comfortably past anything a balance sheet carries,
// and ROUND_HALF_EVEN so repeated rounding does not drift upward.
Decimal.set({ precision: 34, rounding: Decimal.ROUND_HALF_EVEN });

export { Decimal };

export const ZERO = new Decimal(0);

/** Coerces an untrusted upstream value into a Decimal, or undefined. */
export function dec(value: unknown): Decimal | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (value instanceof Decimal) return value;
  try {
    const parsed = new Decimal(value as Decimal.Value);
    return parsed.isFinite() ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Strictly greater than zero.
 *
 * `Decimal.isPositive()` is NOT this: decimal.js reads zero's sign as positive,
 * so `new Decimal(0).isPositive()` is `true`. Every "do we have a usable
 * quantity here?" guard in this codebase means `> 0` — a zero share count, a
 * zero denominator, a zero net-cash position — so they all go through this.
 */
export function gtZero(value: Decimal | undefined): value is Decimal {
  return value !== undefined && value.gt(0);
}

/** Division that yields undefined rather than Infinity or NaN. */
export function div(
  numerator: Decimal | undefined,
  denominator: Decimal | undefined
): Decimal | undefined {
  if (!numerator || !denominator || denominator.isZero()) return undefined;
  return numerator.div(denominator);
}

/** Sums the defined operands; undefined when nothing was defined. */
export function sum(...values: (Decimal | undefined)[]): Decimal | undefined {
  const present = values.filter((v): v is Decimal => v !== undefined);
  return present.length === 0
    ? undefined
    : present.reduce((total, v) => total.plus(v), ZERO);
}

/**
 * Serialises a Decimal for a tool response. Ratios and per-share figures are
 * rounded for legibility; the caller picks the scale.
 */
export function out(
  value: Decimal | undefined,
  decimalPlaces = 4
): number | undefined {
  return value?.toDecimalPlaces(decimalPlaces).toNumber();
}

/** Currency serialisation: two places, always, as a number. */
export function money(value: Decimal | undefined): number | undefined {
  return out(value, 2);
}
