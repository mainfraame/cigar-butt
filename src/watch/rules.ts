import { type Decimal, dec, div, gtZero } from '../math/decimal.ts';

import type { RuleState, WatchRule } from './store.ts';

/**
 * Deciding whether a rule fires. Pure: no clock of its own, no database, no
 * network — everything it needs is an argument, so every branch is testable.
 *
 * Four mechanisms keep a moving market from producing a wall of notifications,
 * and all four are needed. Cooldown alone lets a name sitting exactly on its
 * threshold re-fire the moment the cooldown lapses; hysteresis alone lets a
 * name oscillating across the line fire on every crossing.
 */

export interface Observation {
  /** The quote's own date. Never the time it was read. */
  readonly asOf: string;
  readonly price: Decimal;
  readonly ticker: string;
}

export type Decision =
  | {
      direction: 'down' | 'up';
      fire: true;
      moveFraction: Decimal;
      nextState: RuleState;
    }
  | { fire: false; reason: string };

/** Half the tripped threshold: where a fired rule re-arms. */
const REARM_FRACTION = '0.5';

/**
 * Signed move from reference to observed, as a fraction.
 *
 * Undefined rather than zero when the reference is not positive: a move
 * measured against a zero or negative base is not a percentage of anything,
 * and returning 0 would read as "flat" rather than "unknowable".
 */
export function moveFraction(
  reference: Decimal,
  observed: Decimal
): Decimal | undefined {
  if (!gtZero(reference)) return undefined;
  return div(observed.minus(reference), reference);
}

/**
 * Decides one rule against one observation.
 *
 * `nowSeconds` is injected rather than read, so cooldown behaviour is testable
 * without waiting.
 */
export function evaluate(
  rule: WatchRule,
  state: RuleState,
  observed: Observation,
  nowSeconds: number
): Decision {
  if (!rule.enabled) return { fire: false, reason: 'rule disabled' };

  const move = moveFraction(state.referencePrice, observed.price);
  if (!move) {
    return { fire: false, reason: 'reference price is not positive' };
  }

  const breachedUp = rule.upPct !== undefined && move.gte(rule.upPct);
  const breachedDown =
    rule.downPct !== undefined && move.lte(rule.downPct.neg());

  // Re-arm first, so a rule that has come back inside the band can fire again
  // on the very cycle it breaches. Checking in the other order costs a cycle.
  if (!state.armed) {
    const threshold = breachedUp ? rule.upPct : rule.downPct;
    const rearmAt = (threshold ?? dec(0))?.times(REARM_FRACTION);
    const insideBand = rearmAt === undefined || move.abs().lt(rearmAt);
    if (!insideBand) {
      return {
        fire: false,
        reason: 'latched until price returns inside the band'
      };
    }
    return {
      fire: false,
      reason: 're-armed; price is back inside the band'
    };
  }

  if (!breachedUp && !breachedDown) {
    return { fire: false, reason: 'within threshold' };
  }

  if (
    state.lastFiredAt !== undefined &&
    nowSeconds - state.lastFiredAt < rule.cooldownSeconds
  ) {
    const left = rule.cooldownSeconds - (nowSeconds - state.lastFiredAt);
    return { fire: false, reason: `cooling down for another ${left}s` };
  }

  return {
    direction: breachedUp ? 'up' : 'down',
    fire: true,
    moveFraction: move,
    nextState: {
      armed: false,
      lastFiredAt: nowSeconds,
      // Re-baselining makes a name sliding 30% fire at −10, −20 and −30 rather
      // than holding one alarm open through the whole slide.
      referenceAsOf: rule.rebaseline ? observed.asOf : state.referenceAsOf,
      referencePrice: rule.rebaseline ? observed.price : state.referencePrice,
      ruleId: rule.id,
      ticker: observed.ticker
    }
  };
}

/**
 * Whether a rule that did not fire should still have its latch reset.
 *
 * Split from `evaluate` because re-arming is a state write with no
 * notification, and conflating the two made it easy to drop the write.
 */
export function rearmedState(
  rule: WatchRule,
  state: RuleState,
  observed: Observation
): RuleState | undefined {
  if (state.armed) return undefined;

  const move = moveFraction(state.referencePrice, observed.price);
  if (!move) return undefined;

  const threshold = rule.downPct ?? rule.upPct;
  if (threshold === undefined) return undefined;

  const rearmAt = threshold.times(REARM_FRACTION);
  if (move.abs().gte(rearmAt)) return undefined;

  return { ...state, armed: true };
}

/**
 * US market hours, in UTC, as a coarse weekday gate.
 *
 * Deliberately approximate: it does not know about holidays or the DST
 * transition weeks. Its job is to stop overnight polling burning free-tier
 * quota and firing alarms nobody can act on, and being an hour off at the edges
 * costs one cycle. Holiday-accurate hours would need a calendar this server has
 * no source for, and guessing one would be worse than a coarse gate that says
 * it is coarse.
 */
export function isLikelyMarketHours(at: Date): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;

  const minutes = at.getUTCHours() * 60 + at.getUTCMinutes();
  // 09:30–16:00 ET is 14:30–21:00 UTC in winter, 13:30–20:00 in summer. The
  // union is used so the gate never suppresses a real session.
  return minutes >= 13 * 60 + 30 && minutes <= 21 * 60;
}
