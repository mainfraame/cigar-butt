import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { type Decimal, dec, ZERO } from '../math/decimal.ts';

/**
 * State for the portfolio watch.
 *
 * A third database beside `cache.sqlite` and `congress.sqlite`, for the reason
 * the congress index gives for being separate from the cache: different
 * lifetime. The cache expires by design; alert history must not.
 *
 * **Decimal columns are TEXT**, holding `Decimal.toString()`, never REAL. Hard
 * rule: a threshold comparison against a float that has been through sqlite is
 * exactly the class of bug decimal.js is here to prevent, and a persisted
 * figure is no exception.
 */

let db: DatabaseSync | undefined;

export function watchDbPath(): string {
  const override = process.env.CIGAR_BUTT_WATCH_DB;
  if (override) return override;
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.cache');
  return join(base, 'cigar-butt', 'watch.sqlite');
}

function connect(): DatabaseSync {
  if (db) return db;

  const path = watchDbPath();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS rules (
      id         TEXT PRIMARY KEY,
      kind       TEXT    NOT NULL,
      ticker     TEXT,
      up_pct     TEXT,
      down_pct   TEXT,
      baseline   TEXT    NOT NULL,
      cooldown_s INTEGER NOT NULL,
      rebaseline INTEGER NOT NULL,
      channels   TEXT    NOT NULL,
      enabled    INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS rule_state (
      rule_id         TEXT    NOT NULL,
      ticker          TEXT    NOT NULL,
      reference_price TEXT    NOT NULL,
      reference_as_of TEXT    NOT NULL,
      armed           INTEGER NOT NULL,
      last_fired_at   INTEGER,
      PRIMARY KEY (rule_id, ticker)
    ) STRICT;

    CREATE TABLE IF NOT EXISTS alerts (
      id              INTEGER PRIMARY KEY,
      rule_id         TEXT    NOT NULL,
      ticker          TEXT,
      fired_at        INTEGER NOT NULL,
      reference_price TEXT    NOT NULL,
      observed_price  TEXT    NOT NULL,
      observed_as_of  TEXT    NOT NULL,
      move_fraction   TEXT    NOT NULL,
      body            TEXT    NOT NULL,
      delivered       TEXT    NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS snapshots (
      taken_at       INTEGER PRIMARY KEY,
      source         TEXT NOT NULL,
      account_id_key TEXT,
      holdings       TEXT NOT NULL,
      cash           TEXT NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS runs (
      started_at  INTEGER PRIMARY KEY,
      finished_at INTEGER,
      outcome     TEXT NOT NULL,
      detail      TEXT
    ) STRICT;

    CREATE INDEX IF NOT EXISTS alerts_fired ON alerts (fired_at);
  `);
  return db;
}

const now = (): number => Math.floor(Date.now() / 1000);

/**
 * Only `move` exists. Earlier drafts declared `drift` and `broker_auth` too,
 * but neither is implemented or settable, and a type advertising capability
 * the code does not have is a lie the compiler helps tell. They are described
 * as future work in docs/scheduling-research.md instead.
 */
type RuleKind = 'move';
type Baseline = 'cost' | 'previous_close' | 'reference';

export interface WatchRule {
  readonly baseline: Baseline;
  readonly channels: readonly string[];
  readonly cooldownSeconds: number;
  readonly downPct: Decimal | undefined;
  readonly enabled: boolean;
  readonly id: string;
  readonly kind: RuleKind;
  readonly rebaseline: boolean;
  /** undefined means every held name. */
  readonly ticker: string | undefined;
  readonly upPct: Decimal | undefined;
}

export interface RuleState {
  readonly armed: boolean;
  readonly lastFiredAt: number | undefined;
  readonly referenceAsOf: string;
  readonly referencePrice: Decimal;
  readonly ruleId: string;
  readonly ticker: string;
}

interface Holding {
  readonly asOf: string;
  readonly price: number;
  readonly shares: number;
  readonly ticker: string;
}

export interface Snapshot {
  readonly accountIdKey: string | undefined;
  readonly cash: Decimal;
  readonly holdings: readonly Holding[];
  readonly source: string;
  readonly takenAt: number;
}

export interface FiredAlert {
  readonly body: string;
  readonly delivered: Record<string, string>;
  readonly firedAt: number;
  readonly moveFraction: Decimal;
  readonly observedAsOf: string;
  readonly observedPrice: Decimal;
  readonly referencePrice: Decimal;
  readonly ruleId: string;
  readonly ticker: string | undefined;
}

type Row = Record<string, null | number | string>;

const asDecimal = (value: unknown): Decimal | undefined =>
  typeof value === 'string' ? dec(value) : undefined;

function toRule(row: Row): WatchRule {
  return {
    baseline: String(row['baseline']) as Baseline,
    channels: JSON.parse(String(row['channels'])) as string[],
    cooldownSeconds: Number(row['cooldown_s']),
    downPct: asDecimal(row['down_pct']),
    enabled: row['enabled'] === 1,
    id: String(row['id']),
    kind: String(row['kind']) as RuleKind,
    rebaseline: row['rebaseline'] === 1,
    ticker: row['ticker'] === null ? undefined : String(row['ticker']),
    upPct: asDecimal(row['up_pct'])
  };
}

export function listRules(includeDisabled = false): WatchRule[] {
  const rows = connect()
    .prepare(
      `SELECT * FROM rules ${includeDisabled ? '' : 'WHERE enabled = 1'} ORDER BY id`
    )
    .all() as Row[];
  return rows.map(row => toRule(row));
}

export function upsertRule(rule: WatchRule): void {
  connect()
    .prepare(
      `INSERT INTO rules
         (id, kind, ticker, up_pct, down_pct, baseline, cooldown_s, rebaseline,
          channels, enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         kind = excluded.kind, ticker = excluded.ticker,
         up_pct = excluded.up_pct, down_pct = excluded.down_pct,
         baseline = excluded.baseline, cooldown_s = excluded.cooldown_s,
         rebaseline = excluded.rebaseline, channels = excluded.channels,
         enabled = excluded.enabled`
    )
    .run(
      rule.id,
      rule.kind,
      rule.ticker ?? null,
      rule.upPct?.toString() ?? null,
      rule.downPct?.toString() ?? null,
      rule.baseline,
      rule.cooldownSeconds,
      rule.rebaseline ? 1 : 0,
      JSON.stringify(rule.channels),
      rule.enabled ? 1 : 0,
      now()
    );
}

export function removeRule(id: string): boolean {
  const handle = connect();
  handle.prepare('DELETE FROM rule_state WHERE rule_id = ?').run(id);
  return (
    Number(handle.prepare('DELETE FROM rules WHERE id = ?').run(id).changes) > 0
  );
}

export function ruleState(
  ruleId: string,
  ticker: string
): RuleState | undefined {
  const row = connect()
    .prepare('SELECT * FROM rule_state WHERE rule_id = ? AND ticker = ?')
    .get(ruleId, ticker) as Row | undefined;
  if (!row) return undefined;

  const price = asDecimal(row['reference_price']);
  if (!price) return undefined;

  return {
    armed: row['armed'] === 1,
    lastFiredAt:
      row['last_fired_at'] === null ? undefined : Number(row['last_fired_at']),
    referenceAsOf: String(row['reference_as_of']),
    referencePrice: price,
    ruleId,
    ticker
  };
}

export function putRuleState(state: RuleState): void {
  connect()
    .prepare(
      `INSERT INTO rule_state
         (rule_id, ticker, reference_price, reference_as_of, armed, last_fired_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(rule_id, ticker) DO UPDATE SET
         reference_price = excluded.reference_price,
         reference_as_of = excluded.reference_as_of,
         armed = excluded.armed,
         last_fired_at = excluded.last_fired_at`
    )
    .run(
      state.ruleId,
      state.ticker,
      state.referencePrice.toString(),
      state.referenceAsOf,
      state.armed ? 1 : 0,
      state.lastFiredAt ?? null
    );
}

export function recordAlert(alert: FiredAlert): void {
  connect()
    .prepare(
      `INSERT INTO alerts
         (rule_id, ticker, fired_at, reference_price, observed_price,
          observed_as_of, move_fraction, body, delivered)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      alert.ruleId,
      alert.ticker ?? null,
      alert.firedAt,
      alert.referencePrice.toString(),
      alert.observedPrice.toString(),
      alert.observedAsOf,
      alert.moveFraction.toString(),
      alert.body,
      JSON.stringify(alert.delivered)
    );
}

export function recentAlerts(limit = 50): FiredAlert[] {
  const rows = connect()
    .prepare('SELECT * FROM alerts ORDER BY fired_at DESC LIMIT ?')
    .all(limit) as Row[];

  return rows.flatMap(row => {
    const reference = asDecimal(row['reference_price']);
    const observed = asDecimal(row['observed_price']);
    const move = asDecimal(row['move_fraction']);
    if (!reference || !observed || !move) return [];
    return [
      {
        body: String(row['body']),
        delivered: JSON.parse(String(row['delivered'])) as Record<
          string,
          string
        >,
        firedAt: Number(row['fired_at']),
        moveFraction: move,
        observedAsOf: String(row['observed_as_of']),
        observedPrice: observed,
        referencePrice: reference,
        ruleId: String(row['rule_id']),
        ticker: row['ticker'] === null ? undefined : String(row['ticker'])
      }
    ];
  });
}

export function putSnapshot(snapshot: Omit<Snapshot, 'takenAt'>): void {
  connect()
    .prepare(
      `INSERT OR REPLACE INTO snapshots
         (taken_at, source, account_id_key, holdings, cash) VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      now(),
      snapshot.source,
      snapshot.accountIdKey ?? null,
      JSON.stringify(snapshot.holdings),
      snapshot.cash.toString()
    );
}

/**
 * Drops every recorded snapshot. Returns how many went.
 *
 * The counterpart to `putSnapshot`, and not merely for tidiness: a snapshot
 * that no longer describes the book is the one input a price rule cannot
 * sanity-check, so there has to be a way to say "watch nothing" short of
 * deleting the database. Rules survive — they are armed against whatever is
 * snapshotted next.
 */
export function clearSnapshots(): number {
  const before = connect().prepare('SELECT COUNT(*) n FROM snapshots').get() as
    | Row
    | undefined;
  connect().prepare('DELETE FROM snapshots').run();
  return Number(before?.['n'] ?? 0);
}

export function latestSnapshot(): Snapshot | undefined {
  const row = connect()
    .prepare('SELECT * FROM snapshots ORDER BY taken_at DESC LIMIT 1')
    .get() as Row | undefined;
  if (!row) return undefined;

  return {
    accountIdKey:
      row['account_id_key'] === null
        ? undefined
        : String(row['account_id_key']),
    cash: asDecimal(row['cash']) ?? ZERO,
    holdings: JSON.parse(String(row['holdings'])) as Holding[],
    source: String(row['source']),
    takenAt: Number(row['taken_at'])
  };
}

export interface RunRecord {
  readonly detail: string | undefined;
  readonly finishedAt: number | undefined;
  readonly outcome: 'blind' | 'failed' | 'ok' | 'partial';
  readonly startedAt: number;
}

export function startRun(): number {
  const startedAt = now();
  connect()
    .prepare('INSERT OR REPLACE INTO runs (started_at, outcome) VALUES (?, ?)')
    .run(startedAt, 'failed');
  return startedAt;
}

export function finishRun(
  startedAt: number,
  outcome: RunRecord['outcome'],
  detail?: string
): void {
  connect()
    .prepare(
      'UPDATE runs SET finished_at = ?, outcome = ?, detail = ? WHERE started_at = ?'
    )
    .run(now(), outcome, detail ?? null, startedAt);
}

export function recentRuns(limit = 10): RunRecord[] {
  const rows = connect()
    .prepare('SELECT * FROM runs ORDER BY started_at DESC LIMIT ?')
    .all(limit) as Row[];
  return rows.map(row => ({
    detail: row['detail'] === null ? undefined : String(row['detail']),
    finishedAt:
      row['finished_at'] === null ? undefined : Number(row['finished_at']),
    outcome: String(row['outcome']) as RunRecord['outcome'],
    startedAt: Number(row['started_at'])
  }));
}

export function closeWatchDb(): void {
  db?.close();
  db = undefined;
}

/** Test seam: rebinds the module to a fresh database. */
export function openWatchDbForTest(path = ':memory:'): void {
  closeWatchDb();
  process.env.CIGAR_BUTT_WATCH_DB = path;
  connect();
}
