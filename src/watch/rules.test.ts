import { describe, expect, it } from 'vitest';

import { Decimal } from '../math/decimal.ts';
import {
  evaluate,
  isLikelyMarketHours,
  moveFraction,
  rearmedState
} from './rules.ts';

import type { RuleState, WatchRule } from './store.ts';

const NOW = 1_800_000_000;

const rule = (over: Partial<WatchRule> = {}): WatchRule => ({
  baseline: 'reference',
  channels: ['stderr'],
  cooldownSeconds: 6 * 60 * 60,
  downPct: new Decimal('0.10'),
  enabled: true,
  id: 'r1',
  kind: 'move',
  rebaseline: false,
  ticker: 'AAA',
  upPct: new Decimal('0.10'),
  ...over
});

const state = (over: Partial<RuleState> = {}): RuleState => ({
  armed: true,
  lastFiredAt: undefined,
  referenceAsOf: '2026-09-01',
  referencePrice: new Decimal(100),
  ruleId: 'r1',
  ticker: 'AAA',
  ...over
});

const seen = (price: number) => ({
  asOf: '2026-09-11',
  price: new Decimal(price),
  ticker: 'AAA'
});

describe('moveFraction', () => {
  it('is signed', () => {
    expect(moveFraction(new Decimal(100), new Decimal(90))?.toNumber()).toBe(
      -0.1
    );
    expect(moveFraction(new Decimal(100), new Decimal(110))?.toNumber()).toBe(
      0.1
    );
  });

  it('refuses a non-positive reference rather than returning zero', () => {
    // Zero would read as "flat" when the truth is "unknowable".
    expect(moveFraction(new Decimal(0), new Decimal(90))).toBeUndefined();
    expect(moveFraction(new Decimal(-5), new Decimal(90))).toBeUndefined();
  });
});

describe('evaluate', () => {
  it('holds inside the threshold', () => {
    expect(evaluate(rule(), state(), seen(95), NOW)).toMatchObject({
      fire: false
    });
  });

  it('fires downward at exactly the threshold', () => {
    // A rule set at 10% must fire at 10%, not only past it.
    const decision = evaluate(rule(), state(), seen(90), NOW);

    if (!decision.fire) throw new Error('expected a fire');
    expect(decision.direction).toBe('down');
    expect(decision.moveFraction.toNumber()).toBe(-0.1);
  });

  it('fires upward', () => {
    expect(evaluate(rule(), state(), seen(112), NOW)).toMatchObject({
      direction: 'up',
      fire: true
    });
  });

  it('does not fire on a direction that is not armed', () => {
    const downOnly = rule({ upPct: undefined });
    expect(evaluate(downOnly, state(), seen(150), NOW)).toMatchObject({
      fire: false
    });
  });

  it('respects the cooldown', () => {
    const recent = state({ lastFiredAt: NOW - 60 });
    expect(evaluate(rule(), recent, seen(80), NOW)).toMatchObject({
      fire: false
    });
  });

  it('fires again once the cooldown lapses', () => {
    const old = state({ lastFiredAt: NOW - 7 * 60 * 60 });
    expect(evaluate(rule(), old, seen(80), NOW)).toMatchObject({ fire: true });
  });

  it('stays latched while the price sits on the threshold', () => {
    // Without hysteresis a name parked at −10% re-fires every cycle the moment
    // the cooldown lapses.
    const latched = state({ armed: false, lastFiredAt: NOW - 7 * 60 * 60 });
    expect(evaluate(rule(), latched, seen(90), NOW)).toMatchObject({
      fire: false
    });
  });

  it('clears its latch when the price returns inside half the threshold', () => {
    const latched = state({ armed: false });
    // −4% is inside half of the 10% threshold.
    expect(evaluate(rule(), latched, seen(96), NOW)).toMatchObject({
      fire: false
    });
    expect(rearmedState(rule(), latched, seen(96))?.armed).toBe(true);
  });

  it('does not re-arm while still outside the band', () => {
    const latched = state({ armed: false });
    expect(rearmedState(rule(), latched, seen(92))).toBeUndefined();
  });

  it('keeps the reference when rebaseline is off', () => {
    const decision = evaluate(rule(), state(), seen(90), NOW);

    if (!decision.fire) throw new Error('expected a fire');
    expect(decision.nextState.referencePrice.toNumber()).toBe(100);
    expect(decision.nextState.armed).toBe(false);
  });

  it('moves the reference when rebaseline is on', () => {
    // So a name sliding 30% fires at −10, −20 and −30 rather than once.
    const decision = evaluate(
      rule({ rebaseline: true }),
      state(),
      seen(90),
      NOW
    );

    if (!decision.fire) throw new Error('expected a fire');
    expect(decision.nextState.referencePrice.toNumber()).toBe(90);
    expect(decision.nextState.referenceAsOf).toBe('2026-09-11');
  });

  it('never fires a disabled rule', () => {
    expect(
      evaluate(rule({ enabled: false }), state(), seen(1), NOW)
    ).toMatchObject({
      fire: false
    });
  });

  it('refuses to fire against a non-positive reference', () => {
    const broken = state({ referencePrice: new Decimal(0) });
    expect(evaluate(rule(), broken, seen(90), NOW)).toMatchObject({
      fire: false
    });
  });

  it('holds the threshold exactly, without float drift', () => {
    // 0.1 + 0.2 !== 0.3 in binary floating point. A rule set at 10% against a
    // price that is exactly 10% down must fire, every time.
    const decision = evaluate(
      rule(),
      state({ referencePrice: new Decimal('33.33') }),
      {
        asOf: '2026-09-11',
        price: new Decimal('29.997'),
        ticker: 'AAA'
      },
      NOW
    );

    expect(decision.fire).toBe(true);
  });
});

describe('isLikelyMarketHours', () => {
  // 2026-09-14 is a Monday; the 12th and 13th are Saturday and Sunday.
  it.each([
    ['2026-09-14T14:00:00Z', true],
    ['2026-09-14T20:30:00Z', true],
    ['2026-09-14T03:00:00Z', false],
    ['2026-09-14T23:00:00Z', false],
    ['2026-09-12T15:00:00Z', false],
    ['2026-09-13T15:00:00Z', false]
  ])('%s → %s', (iso, expected) => {
    expect(isLikelyMarketHours(new Date(iso))).toBe(expected);
  });

  it('spans the DST shift rather than suppressing a real session', () => {
    // 09:30 ET is 13:30 UTC in summer and 14:30 in winter. The gate takes the
    // union, because being an hour generous costs a wasted cycle while being an
    // hour strict silently skips the open.
    expect(isLikelyMarketHours(new Date('2026-09-14T13:35:00Z'))).toBe(true);
    expect(isLikelyMarketHours(new Date('2026-01-05T20:55:00Z'))).toBe(true);
  });
});
