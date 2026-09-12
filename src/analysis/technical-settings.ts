import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The one persisted preference the price-statistics tool has: how much of it to
 * print.
 *
 * A key/value `meta` table on `node:sqlite`, the same shape and the same
 * lifetime rules as the watch store — a setting is not a cached response and
 * must not expire, so it does not belong in `cache.sqlite`, whose whole
 * contract is that entries go away. It gets its own small file rather than
 * riding in the watch database, because a preference outlives any particular
 * feature and an MCP server restarts every time its client reconnects: state
 * that only lives in the process is state the user has to set again every
 * session.
 *
 * Precedence, which is the part that silently inverts if it is not written
 * down: an explicit argument beats the stored preference, the stored preference
 * beats the default, and the default is `simple`.
 */

/**
 * `simple` is a plain-language read for someone running a deep-value book, not
 * a chart. `advanced` is the full table, with windows and as-of dates, for
 * someone who knows what an ATR is.
 */
export type DetailLevel = 'advanced' | 'simple';

const DETAIL_KEY = 'technical.detail';
const DEFAULT_DETAIL: DetailLevel = 'simple';

let db: DatabaseSync | undefined;

export function settingsDbPath(): string {
  const override = process.env.CIGAR_BUTT_SETTINGS_DB;
  if (override) return override;
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.cache');
  return join(base, 'cigar-butt', 'settings.sqlite');
}

function connect(): DatabaseSync {
  if (db) return db;

  const path = settingsDbPath();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
  `);
  return db;
}

/** A stored setting, or undefined when it was never set. */
export function meta(key: string): string | undefined {
  const row = connect()
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(key) as undefined | { value?: string };
  return row?.value;
}

export function setMeta(key: string, value: string): void {
  connect()
    .prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, value);
}

function isDetailLevel(value: string | undefined): value is DetailLevel {
  return value === 'advanced' || value === 'simple';
}

/**
 * The stored preference, or `undefined` when none has been set.
 *
 * Undefined means "never chosen", not "chose simple" — the same distinction the
 * rest of this codebase draws between a missing figure and a failed test. Only
 * `resolveDetail` collapses it to a level, and it says so where it does.
 */
export function detailPreference(): DetailLevel | undefined {
  const stored = meta(DETAIL_KEY);
  // A value written by a future version, or by hand, is treated as unset
  // rather than crashing a tool over a preference.
  return isDetailLevel(stored) ? stored : undefined;
}

export function setDetailPreference(level: DetailLevel): void {
  setMeta(DETAIL_KEY, level);
}

/** Explicit argument, then stored preference, then `simple`. */
export function resolveDetail(requested?: DetailLevel): DetailLevel {
  return requested ?? detailPreference() ?? DEFAULT_DETAIL;
}

export function closeSettingsDb(): void {
  db?.close();
  db = undefined;
}

/** Test seam: rebinds the module to a fresh database. */
export function openSettingsDbForTest(path = ':memory:'): void {
  closeSettingsDb();
  process.env.CIGAR_BUTT_SETTINGS_DB = path;
  connect();
}
