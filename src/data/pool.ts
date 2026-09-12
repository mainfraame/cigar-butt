import { sortBy } from 'lodash-es';
import { DatabaseSync } from 'node:sqlite';

import { providerById } from '../config/providers.ts';
import { getCredential } from '../config/store.ts';
import { HttpError } from '../http/client.ts';

/**
 * A pool of interchangeable data providers, with failover.
 *
 * Three problems this exists to solve, all of which were previously hardcoded:
 *
 * **Free-tier caps are the binding constraint.** Alpha Vantage allows ~25
 * requests a day, Polygon 5 a minute, Tiingo ~50 tickers an hour. A screen of
 * any size exhausts at least one of them, and the useful response is to move to
 * the next provider rather than fail the call. So a provider that reports a cap
 * is put on a cooldown and skipped until it lifts.
 *
 * **A paid plan should be usable.** Rate limits were previously constants
 * matching each provider's *free* tier, which throttled anyone paying for more
 * to the speed of someone paying nothing. Every limit is now overridable.
 *
 * **Keys are optional.** A provider with no credential is skipped silently
 * rather than counted as a failure, so the pool degrades to whatever the user
 * actually configured.
 *
 * Cooldowns are persisted, because an MCP server restarts whenever its client
 * reconnects and a daily cap does not reset just because the process did.
 */

/**
 * How a provider meters usage. Several apply at once — Tiingo caps requests per
 * hour *and* per day *and* distinct symbols per month — and the tightest one
 * that is currently spent is what stops a call.
 */
export interface Budget {
  readonly limit: number;
  readonly per: 'day' | 'hour' | 'minute' | 'month';
  /**
   * `symbols` counts DISTINCT inputs rather than calls. Tiingo's real
   * constraint is 500 unique symbols a month, which a single wide screen can
   * exhaust while the request counters look healthy.
   */
  readonly unit?: 'requests' | 'symbols';
}

export interface Provider<T> {
  /** Documented free-tier limits. Overridable per budget; see `budgetsFor`. */
  readonly budgets: readonly Budget[];
  /** Matches a `ProviderSpec.id` in the credential registry. */
  readonly id: string;
  /**
   * Recognises "you have hit your cap" for this provider. Necessary per
   * provider because the signal is not standardised: some answer 429, and
   * Alpha Vantage answers HTTP 200 with an explanatory prose body.
   */
  readonly isQuotaError?: (error: unknown) => boolean;
  readonly label: string;
  /** How long to skip this provider after it reports a cap. */
  readonly quotaCooldownSeconds: number;
  /** Free-tier default. Override with CIGAR_BUTT_RATE_<ID>. */
  readonly requestsPerSecond: number;
  readonly run: (input: string, key: string, rate: number) => Promise<T>;
}

export interface PoolAttempt {
  readonly id: string;
  readonly outcome:
    | 'budget-spent'
    | 'cooling-down'
    | 'error'
    | 'no-key'
    | 'quota'
    | 'success';
  readonly reason?: string;
}

export interface PoolOutcome<T> {
  readonly attempts: readonly PoolAttempt[];
  readonly providerId: string;
  readonly value: T;
}

/* ------------------------------------------------------------ persistence */

let db: DatabaseSync | undefined;

function connect(): DatabaseSync {
  if (db) return db;
  // Rides in the response cache's database: this is the same kind of state —
  // derived, discardable, and worthless to back up.
  const path = process.env.CIGAR_BUTT_CACHE ?? ':memory:';
  db = new DatabaseSync(path);
  db.exec(`
    CREATE TABLE IF NOT EXISTS provider_state (
      id             TEXT PRIMARY KEY,
      cooldown_until INTEGER NOT NULL,
      last_reason    TEXT NOT NULL,
      hits           INTEGER NOT NULL DEFAULT 0
    ) STRICT;

    CREATE TABLE IF NOT EXISTS usage (
      provider     TEXT NOT NULL,
      window_kind  TEXT NOT NULL,
      window_start TEXT NOT NULL,
      calls        INTEGER NOT NULL,
      PRIMARY KEY (provider, window_kind, window_start)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS usage_symbols (
      provider     TEXT NOT NULL,
      window_kind  TEXT NOT NULL,
      window_start TEXT NOT NULL,
      symbol       TEXT NOT NULL,
      PRIMARY KEY (provider, window_kind, window_start, symbol)
    ) STRICT;
  `);
  return db;
}

/* --------------------------------------------------------------- budgets */

/**
 * The bucket a moment falls in, as a sortable string.
 *
 * Rollover needs no scheduled cleanup: a new period simply produces a new key,
 * and the previous period's rows stop matching. `sweepUsage` reclaims the space
 * later, but correctness does not depend on it having run.
 */
export function windowStart(per: Budget['per'], at = new Date()): string {
  const iso = at.toISOString();
  switch (per) {
    case 'day': {
      return iso.slice(0, 10);
    }
    case 'hour': {
      return iso.slice(0, 13);
    }
    case 'minute': {
      return iso.slice(0, 16);
    }
    case 'month': {
      return iso.slice(0, 7);
    }
  }
}

/** Seconds until the current window rolls over. */
function secondsUntilReset(per: Budget['per'], at = new Date()): number {
  const next = new Date(at);
  switch (per) {
    case 'day': {
      next.setUTCHours(24, 0, 0, 0);
      break;
    }
    case 'hour': {
      next.setUTCMinutes(60, 0, 0);
      break;
    }
    case 'minute': {
      next.setUTCSeconds(60, 0);
      break;
    }
    case 'month': {
      next.setUTCMonth(next.getUTCMonth() + 1, 1);
      next.setUTCHours(0, 0, 0, 0);
      break;
    }
  }
  return Math.max(1, Math.ceil((next.getTime() - at.getTime()) / 1000));
}

/** `CIGAR_BUTT_BUDGET_<ID>_<PER>` overrides a documented free-tier limit. */
function limitFor(id: string, budget: Budget): number {
  const raw =
    process.env[
      `CIGAR_BUTT_BUDGET_${id.toUpperCase().replaceAll('-', '_')}_${budget.per.toUpperCase()}`
    ];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  // 0 means "no limit" — the natural way to say "I pay for this one".
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : budget.limit;
}

function used(id: string, budget: Budget): number {
  const start = windowStart(budget.per);
  if (budget.unit === 'symbols') {
    const row = connect()
      .prepare(
        `SELECT COUNT(*) AS n FROM usage_symbols
          WHERE provider = ? AND window_kind = ? AND window_start = ?`
      )
      .get(id, budget.per, start) as { n: number };
    return row.n;
  }
  const row = connect()
    .prepare(
      `SELECT calls AS n FROM usage
        WHERE provider = ? AND window_kind = ? AND window_start = ?`
    )
    .get(id, budget.per, start) as undefined | { n?: number };
  return row?.n ?? 0;
}

/**
 * Records an attempt. Called whether or not the request succeeded, because a
 * rejected request still counts against most providers' quotas — assuming
 * otherwise is how a counter drifts under the real one and stops protecting.
 */
function recordUsage<T>(provider: Provider<T>, input: string): void {
  const handle = connect();
  for (const budget of provider.budgets) {
    const start = windowStart(budget.per);
    if (budget.unit === 'symbols') {
      handle
        .prepare(
          `INSERT OR IGNORE INTO usage_symbols
             (provider, window_kind, window_start, symbol) VALUES (?, ?, ?, ?)`
        )
        .run(provider.id, budget.per, start, input.toUpperCase());
      continue;
    }
    handle
      .prepare(
        `INSERT INTO usage (provider, window_kind, window_start, calls)
         VALUES (?, ?, ?, 1)
         ON CONFLICT(provider, window_kind, window_start)
         DO UPDATE SET calls = usage.calls + 1`
      )
      .run(provider.id, budget.per, start);
  }
}

export interface BudgetState {
  readonly limit: number;
  readonly per: Budget['per'];
  readonly resetsInSeconds: number;
  readonly unit: 'requests' | 'symbols';
  readonly used: number;
}

/** Every budget for a provider, with how much of it is spent. */
export function budgetsFor<T>(provider: Provider<T>): BudgetState[] {
  return provider.budgets.map(budget => ({
    limit: limitFor(provider.id, budget),
    per: budget.per,
    resetsInSeconds: secondsUntilReset(budget.per),
    unit: budget.unit ?? 'requests',
    used: used(provider.id, budget)
  }));
}

/**
 * The first budget that is spent, if any.
 *
 * Checked *before* a request rather than inferred from a 429 afterwards. On a
 * daily cap the difference matters: the rejected call still counts, so learning
 * reactively costs a request that was never going to work and can push the
 * counter further past the limit.
 */
function exhausted<T>(
  provider: Provider<T>,
  input: string
): BudgetState | undefined {
  return budgetsFor(provider).find(state => {
    if (state.limit === 0) return false;
    // A symbol already counted this period is free to fetch again.
    if (state.unit === 'symbols' && countsAlready(provider.id, input)) {
      return false;
    }
    return state.used >= state.limit;
  });
}

function countsAlready(id: string, input: string): boolean {
  return (
    connect()
      .prepare(
        `SELECT 1 FROM usage_symbols
          WHERE provider = ? AND window_kind = 'month'
            AND window_start = ? AND symbol = ?`
      )
      .get(id, windowStart('month'), input.toUpperCase()) !== undefined
  );
}

/** Drops usage rows for windows that have rolled over. */
export function sweepUsage(): number {
  const handle = connect();
  let removed = 0;
  for (const [table, column] of [
    ['usage', 'window_start'],
    ['usage_symbols', 'window_start']
  ] as const) {
    for (const per of ['day', 'hour', 'minute', 'month'] as const) {
      const result = handle
        .prepare(`DELETE FROM ${table} WHERE window_kind = ? AND ${column} < ?`)
        .run(per, windowStart(per));
      removed += Number(result.changes);
    }
  }
  return removed;
}

const now = (): number => Math.floor(Date.now() / 1000);

function cooldownUntil(id: string): number {
  const row = connect()
    .prepare('SELECT cooldown_until FROM provider_state WHERE id = ?')
    .get(id) as undefined | { cooldown_until?: number };
  return row?.cooldown_until ?? 0;
}

function startCooldown(id: string, seconds: number, reason: string): void {
  connect()
    .prepare(
      `INSERT INTO provider_state (id, cooldown_until, last_reason, hits)
       VALUES (?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET
         cooldown_until = excluded.cooldown_until,
         last_reason = excluded.last_reason,
         hits = provider_state.hits + 1`
    )
    .run(id, now() + seconds, reason.slice(0, 300));
}

export interface ProviderStatus {
  readonly budgets: readonly BudgetState[];
  readonly configured: boolean;
  readonly cooldownSeconds: number;
  readonly id: string;
  readonly label: string;
  readonly lastReason: string | undefined;
  readonly quotaHits: number;
  readonly requestsPerSecond: number;
}

/** Whatever is on record about every provider in a pool. */
export function poolStatus<T>(
  providers: readonly Provider<T>[]
): ProviderStatus[] {
  const rows = connect()
    .prepare('SELECT id, cooldown_until, last_reason, hits FROM provider_state')
    .all() as {
    cooldown_until: number;
    hits: number;
    id: string;
    last_reason: string;
  }[];
  const byId = new Map(rows.map(row => [row.id, row]));

  return order(providers).map(provider => {
    const row = byId.get(provider.id);
    return {
      budgets: budgetsFor(provider),
      configured: credentialFor(provider.id) !== undefined,
      cooldownSeconds: Math.max(0, (row?.cooldown_until ?? 0) - now()),
      id: provider.id,
      label: provider.label,
      lastReason: row?.last_reason,
      quotaHits: row?.hits ?? 0,
      requestsPerSecond: rateFor(provider)
    };
  });
}

/** Clears every cooldown and usage counter, for when a cap is known to have reset. */
export function clearCooldowns(): number {
  const handle = connect();
  const cooldowns = Number(
    handle.prepare('DELETE FROM provider_state').run().changes
  );
  handle.prepare('DELETE FROM usage').run();
  handle.prepare('DELETE FROM usage_symbols').run();
  return cooldowns;
}

export function closePool(): void {
  db?.close();
  db = undefined;
}

/* --------------------------------------------------------- configuration */

const envKey = (id: string): string =>
  `CIGAR_BUTT_RATE_${id.toUpperCase().replaceAll('-', '_')}`;

/**
 * Requests per second for a provider. The declared value is the free-tier
 * limit; `CIGAR_BUTT_RATE_<ID>` overrides it so a paid plan runs at its own
 * speed rather than being held to the free one.
 */
export function rateFor<T>(provider: Provider<T>): number {
  const raw = process.env[envKey(provider.id)];
  const parsed = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : provider.requestsPerSecond;
}

/**
 * A provider is usable when its credential is present. The provider id is the
 * join key into the credential registry, so adding a provider stays a
 * one-file change on each side.
 */
function credentialFor(id: string): string | undefined {
  const spec = providerById(id);
  return spec ? getCredential(spec.envVar) : undefined;
}

/**
 * Preference order. `CIGAR_BUTT_PROVIDER_ORDER` lets a user put the service
 * they pay for first; anything unlisted keeps its declared order behind them.
 */
function order<T>(providers: readonly Provider<T>[]): Provider<T>[] {
  const preferred = (process.env.CIGAR_BUTT_PROVIDER_ORDER ?? '')
    .split(',')
    .map(entry => entry.trim().toLowerCase())
    .filter(entry => entry.length > 0);

  if (preferred.length === 0) return [...providers];

  return sortBy(providers, provider => {
    const rank = preferred.indexOf(provider.id.toLowerCase());
    return rank === -1 ? preferred.length : rank;
  });
}

/* ------------------------------------------------------------- execution */

/** 429, or a provider-specific cap message. */
function looksLikeQuota<T>(provider: Provider<T>, error: unknown): boolean {
  if (error instanceof HttpError && error.status === 429) return true;
  return provider.isQuotaError?.(error) ?? false;
}

/**
 * Runs `input` against the first provider that answers.
 *
 * Every provider's outcome is recorded and returned, because a single "no data"
 * hides which of "no key", "rate limited" and "bad ticker" actually happened —
 * and those call for three different fixes.
 */
export async function runPool<T>(
  providers: readonly Provider<T>[],
  input: string
): Promise<PoolOutcome<T>> {
  const attempts: PoolAttempt[] = [];

  for (const provider of order(providers)) {
    const key = credentialFor(provider.id);
    if (!key) {
      attempts.push({ id: provider.id, outcome: 'no-key' });
      continue;
    }

    const cooling = cooldownUntil(provider.id) - now();
    if (cooling > 0) {
      attempts.push({
        id: provider.id,
        outcome: 'cooling-down',
        reason: `cap reported by the provider; retrying in ${cooling}s`
      });
      continue;
    }

    // Checked before spending a request, not inferred from the rejection.
    const spent = exhausted(provider, input);
    if (spent) {
      attempts.push({
        id: provider.id,
        outcome: 'budget-spent',
        reason:
          `${spent.used}/${spent.limit} ${spent.unit} per ${spent.per} used; ` +
          `resets in ${spent.resetsInSeconds}s`
      });
      continue;
    }

    try {
      recordUsage(provider, input);
      const value = await provider.run(input, key, rateFor(provider));
      attempts.push({ id: provider.id, outcome: 'success' });
      return { attempts, providerId: provider.id, value };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (looksLikeQuota(provider, error)) {
        startCooldown(provider.id, provider.quotaCooldownSeconds, reason);
        attempts.push({ id: provider.id, outcome: 'quota', reason });
      } else {
        attempts.push({ id: provider.id, outcome: 'error', reason });
      }
    }
  }

  throw new PoolExhausted(input, attempts);
}

export class PoolExhausted extends Error {
  readonly attempts: readonly PoolAttempt[];

  constructor(input: string, attempts: readonly PoolAttempt[]) {
    const detail = attempts
      .map(
        attempt =>
          `  - ${attempt.id}: ${attempt.outcome}${attempt.reason ? ` — ${attempt.reason}` : ''}`
      )
      .join('\n');
    super(
      `No provider could answer for ${input}.\n${detail}\n\n` +
        '`no-key` needs a credential. `budget-spent` and `cooling-down` recover ' +
        'on their own when the window rolls over — `provider_status` shows when. ' +
        'If you pay for a higher limit than the free tier assumed here, raise it ' +
        'with CIGAR_BUTT_BUDGET_<PROVIDER>_<PERIOD> (0 means unlimited).'
    );
    this.attempts = attempts;
    this.name = 'PoolExhausted';
  }
}

/** Test seam. */
export function resetPoolForTest(path = ':memory:'): void {
  closePool();
  process.env.CIGAR_BUTT_CACHE = path;
  connect();
}
