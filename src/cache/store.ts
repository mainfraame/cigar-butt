import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * A disk-backed response cache, on `node:sqlite` — a release candidate in the
 * Node 24 LTS this package targets, so it costs no dependency.
 *
 * Why a cache is not optional here. The free tiers this server runs on are
 * tight enough to be the binding constraint on what it can do:
 *
 *   Alpha Vantage  ~25 requests/day
 *   Polygon        5 calls/minute
 *   Tiingo         ~50 unique tickers/hour, 500 requests/day
 *   SEC EDGAR      10 requests/second, but a full per-name balance sheet is
 *                  twelve `companyconcept` calls plus a `submissions` fetch,
 *                  so a 200-name screen is ~2,600 requests
 *
 * MCP servers are also restarted whenever a client reconnects, so an in-memory
 * cache throws away the expensive work on every session boundary. Persisting
 * it is the difference between a screen that reruns in seconds and one that
 * burns a day's Alpha Vantage quota.
 *
 * TTLs are set per source, and the price TTL is deliberately short. Stale
 * prices are the single largest source of wrong answers in this domain: the
 * same ticker has come back 60% apart from two caches minutes apart, and a
 * cheerfully-cached quote is exactly the failure the skill exists to prevent.
 * Fundamentals, by contrast, change only when a filing lands.
 */

interface CacheOptions {
  /** Overrides the on-disk location. `:memory:` is honoured, for tests. */
  readonly path?: string;
}

/**
 * Every namespace `cached()` is called with, so `cache_clear` can name them.
 *
 * A namespace missing from here cannot be cleared individually, which matters
 * more than it sounds: a day list that came back empty during an outage sits
 * in the cache for a week, and the only way out was deleting the whole
 * database. `cache-namespaces.test.ts` fails if a call site uses a namespace
 * that is not listed.
 */
export const CACHE_NAMESPACES = [
  'alpaca-clock',
  'bars',
  'ch-profile',
  'ch-search',
  'congress-committees',
  'congress-house-index',
  'congress-membership',
  'congress-senate-annual',
  'congress-senate-annual-list',
  'congress-senate-list',
  'congress-senate-ptr',
  'edinet-csv',
  'edinet-day',
  'etrade-accounts',
  'etrade-balance',
  'etrade-portfolio',
  'etrade-transactions',
  'fdic-financials',
  'fdic-institution',
  'finra-short-interest',
  'fidelity-balances',
  'fidelity-context',
  'fidelity-positions',
  'fred',
  'fx',
  'polygon-dividends',
  'polygon-grouped',
  'polygon-splits',
  'polygon-ticker',
  'quote',
  'sec-concept',
  'sec-filing-index',
  'sec-filing-text',
  'sec-frames',
  'sec-ownership',
  'sec-stake-header',
  'sec-submissions',
  'sec-tickers'
] as const;

/** Seconds. Chosen by how often the underlying fact can actually change. */
export const TTL = {
  /** A past daily bar never changes; only the last one is volatile. */
  bars: 7 * 24 * 60 * 60,
  /** Whole-market frames: a quarter's data is fixed once filed. */
  frames: 7 * 24 * 60 * 60,
  /** Balance-sheet concepts change only when a filing lands. */
  fundamentals: 24 * 60 * 60,
  /** Quotes. Short on purpose — see the note above. */
  prices: 60 * 60,
  /** The filing index gains rows continuously; a new 8-K must not be missed. */
  submissions: 6 * 60 * 60,
  /** Ticker→CIK index. A ~1MB payload that changes at the margins. */
  tickerIndex: 7 * 24 * 60 * 60
} as const;

let db: DatabaseSync | undefined;

function defaultPath(): string {
  const override = process.env.CIGAR_BUTT_CACHE;
  if (override) return override;
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.cache');
  return join(base, 'cigar-butt', 'cache.sqlite');
}

function connect(options: CacheOptions = {}): DatabaseSync {
  if (db) return db;

  const path = options.path ?? defaultPath();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  db = new DatabaseSync(path);
  // WAL so a second server process reading the same cache does not block, and
  // NORMAL sync because losing the tail of a cache on power loss costs a refetch.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      key        TEXT PRIMARY KEY,
      namespace  TEXT NOT NULL,
      payload    TEXT NOT NULL,
      stored_at  INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX IF NOT EXISTS entries_expiry ON entries (expires_at);
  `);
  return db;
}

const now = (): number => Math.floor(Date.now() / 1000);

/** Reads a live entry, or undefined when absent or expired. */
export function read<T>(namespace: string, key: string): T | undefined {
  if (process.env.CIGAR_BUTT_NO_CACHE === '1') return undefined;

  const row = connect()
    .prepare('SELECT payload FROM entries WHERE key = ? AND expires_at > ?')
    .get(`${namespace}:${key}`, now()) as undefined | { payload?: string };

  if (!row?.payload) return undefined;
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    // A corrupt row is indistinguishable from a miss, and refetching is cheap.
    return undefined;
  }
}

/** Stores an entry with a TTL in seconds. */
export function write(
  namespace: string,
  key: string,
  value: unknown,
  ttlSeconds: number
): void {
  if (process.env.CIGAR_BUTT_NO_CACHE === '1') return;

  const timestamp = now();
  connect()
    .prepare(
      `INSERT INTO entries (key, namespace, payload, stored_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         payload = excluded.payload,
         stored_at = excluded.stored_at,
         expires_at = excluded.expires_at`
    )
    .run(
      `${namespace}:${key}`,
      namespace,
      JSON.stringify(value),
      timestamp,
      timestamp + ttlSeconds
    );
}

/**
 * Read-through wrapper. The single entry point callers should use — it keeps
 * the "did this come from the network?" question answerable in one place.
 */
export async function cached<T>(
  namespace: string,
  key: string,
  ttlSeconds: number,
  produce: () => Promise<T>
): Promise<T> {
  const hit = read<T>(namespace, key);
  if (hit !== undefined) return hit;

  const value = await produce();
  write(namespace, key, value, ttlSeconds);
  return value;
}

export interface CacheStats {
  readonly byNamespace: readonly { entries: number; namespace: string }[];
  readonly expired: number;
  readonly live: number;
  readonly path: string;
}

export function stats(): CacheStats {
  const handle = connect();
  const timestamp = now();

  const counts = handle
    .prepare(
      `SELECT namespace, COUNT(*) AS entries
         FROM entries WHERE expires_at > ?
        GROUP BY namespace ORDER BY namespace`
    )
    .all(timestamp) as { entries: number; namespace: string }[];

  const live = handle
    .prepare('SELECT COUNT(*) AS n FROM entries WHERE expires_at > ?')
    .get(timestamp) as { n: number };
  const expired = handle
    .prepare('SELECT COUNT(*) AS n FROM entries WHERE expires_at <= ?')
    .get(timestamp) as { n: number };

  return {
    byNamespace: counts,
    expired: expired.n,
    live: live.n,
    path: process.env.CIGAR_BUTT_CACHE ?? defaultPath()
  };
}

/** Drops entries. Without a namespace, drops everything. */
export function purge(namespace?: string): number {
  const handle = connect();
  const result = namespace
    ? handle.prepare('DELETE FROM entries WHERE namespace = ?').run(namespace)
    : handle.prepare('DELETE FROM entries').run();
  return Number(result.changes);
}

/** Removes expired rows. Cheap, and keeps the file from growing without bound. */
export function vacuumExpired(): number {
  const result = connect()
    .prepare('DELETE FROM entries WHERE expires_at <= ?')
    .run(now());
  return Number(result.changes);
}

export function closeCache(): void {
  db?.close();
  db = undefined;
}

/** Test seam: rebinds the module to a fresh database. */
export function openCacheForTest(path: string): void {
  closeCache();
  connect({ path });
}
