import { sortBy } from 'lodash-es';

import { quotes } from '../data/prices.ts';
import { type Decimal, dec, out } from '../math/decimal.ts';
import { deliver } from './channels.ts';
import { evaluate, isLikelyMarketHours, rearmedState } from './rules.ts';
import {
  finishRun,
  latestSnapshot,
  listRules,
  putRuleState,
  recordAlert,
  ruleState,
  startRun,
  type RunRecord,
  type WatchRule
} from './store.ts';

/**
 * One poll cycle. The thing a launchd timer calls.
 *
 * Deliberately short-lived: it runs, decides, delivers and exits. The OS
 * scheduler already solves restart, wake and calendar, which a resident daemon
 * would have to reimplement worse.
 *
 * Two rules this must never break, both load-bearing:
 *
 * - **It never asks a question.** Elicitation is auto-rejected under every
 *   unattended approval policy, so a missing credential must end the run with a
 *   recorded, alerted failure rather than a form nobody will ever see.
 * - **It never places an order.** It produces alerts and, at most, a plan.
 */

export interface CycleResult {
  readonly alertsFired: number;
  readonly detail: string;
  readonly outcome: RunRecord['outcome'];
  readonly quotesRead: number;
  readonly tickersBlind: readonly string[];
}

const DAY = 86_400;

function pct(value: Decimal): string {
  const scaled = out(value.times(100), 2) ?? 0;
  return `${scaled > 0 ? '+' : ''}${scaled}%`;
}

/** Tickers a rule applies to, given the current snapshot. */
function tickersFor(rule: WatchRule, held: readonly string[]): string[] {
  return rule.ticker ? [rule.ticker.toUpperCase()] : [...held];
}

export interface RunOptions {
  /** Ignore the market-hours gate. For `watch run --force` and tests. */
  readonly force?: boolean;
  readonly now?: Date;
}

export async function runCycle(options: RunOptions = {}): Promise<CycleResult> {
  const now = options.now ?? new Date();
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const startedAt = startRun();

  const finish = (result: CycleResult): CycleResult => {
    finishRun(startedAt, result.outcome, result.detail);
    return result;
  };

  if (!options.force && !isLikelyMarketHours(now)) {
    return finish({
      alertsFired: 0,
      detail: 'outside US market hours; skipped to preserve free-tier quota',
      outcome: 'ok',
      quotesRead: 0,
      tickersBlind: []
    });
  }

  const snapshot = latestSnapshot();
  if (!snapshot || snapshot.holdings.length === 0) {
    return finish({
      alertsFired: 0,
      detail:
        'no positions snapshot. Record one with the `watch_snapshot_set` tool, ' +
        'passing the holdings `broker_positions` emits while you are authorised.',
      outcome: 'blind',
      quotesRead: 0,
      tickersBlind: []
    });
  }

  const rules = listRules().filter(rule => rule.kind === 'move');
  if (rules.length === 0) {
    return finish({
      alertsFired: 0,
      detail: 'no enabled move rules',
      outcome: 'ok',
      quotesRead: 0,
      tickersBlind: []
    });
  }

  const held = snapshot.holdings.map(holding => holding.ticker.toUpperCase());
  const wanted = [...new Set(rules.flatMap(rule => tickersFor(rule, held)))];

  const { failed, quotes: found } = await quotes(wanted);
  const byTicker = new Map(
    found.map(quote => [quote.ticker.toUpperCase(), quote])
  );

  const snapshotAgeDays = Math.floor((nowSeconds - snapshot.takenAt) / DAY);
  const lines: string[] = [];
  let fired = 0;

  for (const rule of rules) {
    for (const ticker of tickersFor(rule, held)) {
      const quote = byTicker.get(ticker);
      if (!quote) continue;

      const price = dec(quote.price);
      if (!price) continue;

      const observation = { asOf: quote.asOf, price, ticker };
      const existing = ruleState(rule.id, ticker);

      // First sighting establishes the reference rather than firing. A rule
      // armed today must not immediately alarm on a move it never watched.
      if (!existing) {
        putRuleState({
          armed: true,
          lastFiredAt: undefined,
          referenceAsOf: quote.asOf,
          referencePrice: price,
          ruleId: rule.id,
          ticker
        });
        continue;
      }

      const decision = evaluate(rule, existing, observation, nowSeconds);
      if (!decision.fire) {
        const rearmed = rearmedState(rule, existing, observation);
        if (rearmed) putRuleState(rearmed);
        continue;
      }

      putRuleState(decision.nextState);
      fired += 1;
      lines.push(
        `${ticker} ${pct(decision.moveFraction)} — ${quote.price} on ${quote.asOf} ` +
          `vs reference ${out(existing.referencePrice, 2)} from ${existing.referenceAsOf} ` +
          `[${rule.id}]`
      );

      recordAlert({
        body: lines.at(-1) ?? '',
        delivered: {},
        firedAt: nowSeconds,
        moveFraction: decision.moveFraction,
        observedAsOf: quote.asOf,
        observedPrice: price,
        referencePrice: existing.referencePrice,
        ruleId: rule.id,
        ticker
      });
    }
  }

  // One notification per cycle. Twelve banners on a market-wide down day is the
  // same as no banner.
  if (lines.length > 0) {
    const channels = [...new Set(rules.flatMap(rule => rule.channels))];
    const staleness =
      snapshotAgeDays >= 1
        ? `\n\nHoldings snapshot is ${snapshotAgeDays} day(s) old; share counts may have moved.`
        : '';
    await deliver(
      channels,
      `cigar-butt: ${lines.length} alert(s)`,
      `${sortBy(lines).join('\n')}${staleness}`
    );
  }

  const blind = failed.map(entry => entry.ticker);
  return finish({
    alertsFired: fired,
    detail:
      `${found.length} quote(s), ${fired} alert(s)` +
      (blind.length > 0 ? `; no price for ${blind.join(', ')}` : ''),
    // A watch that quietly stops watching is worse than no watch, so a name it
    // could not price downgrades the whole run rather than being dropped.
    outcome: blind.length > 0 ? 'partial' : 'ok',
    quotesRead: found.length,
    tickersBlind: blind
  });
}
