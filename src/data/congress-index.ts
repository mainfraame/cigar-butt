import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  senateReportList,
  senateReportTrades,
  type DisclosedTrade,
  type SenateReportRef
} from './congress.ts';

/**
 * A local, searchable index of Senate disclosures.
 *
 * eFD cannot be searched by ticker. Its form takes a filer name, a state, a
 * report type and a filing-date window — nothing else — so the only way to
 * answer "who traded this company?" is to hold the transactions locally and
 * query them here.
 *
 * Two facts make that cheap. Reports are **immutable once filed**, so a report
 * already indexed is never fetched again; after the first build, keeping
 * current costs roughly the number of new filings, which is a handful a week.
 * And the report list covers *every* senator in a date window in one request,
 * so the index is built report-by-report rather than senator-by-senator — the
 * latter would multiply requests by the number of members for identical data.
 *
 * This is a separate database from the response cache. That store is a TTL
 * key-value cache whose entries are meant to expire; this is an accumulating
 * index that should not.
 */

let db: DatabaseSync | undefined;

function defaultPath(): string {
  const override = process.env.CIGAR_BUTT_CONGRESS_DB;
  if (override) return override;
  const xdg = process.env.XDG_CACHE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.cache');
  return join(base, 'cigar-butt', 'congress.sqlite');
}

function connect(): DatabaseSync {
  if (db) return db;

  const path = defaultPath();
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });

  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS reports (
      url        TEXT PRIMARY KEY,
      member     TEXT NOT NULL,
      filed_date TEXT NOT NULL,
      trade_rows INTEGER NOT NULL,
      indexed_at INTEGER NOT NULL
    ) STRICT;

    CREATE TABLE IF NOT EXISTS trades (
      report_url       TEXT NOT NULL,
      row_index        INTEGER NOT NULL,
      member           TEXT NOT NULL,
      ticker           TEXT,
      asset_name       TEXT NOT NULL,
      asset_type       TEXT NOT NULL,
      transaction_type TEXT NOT NULL,
      owner            TEXT NOT NULL,
      amount           TEXT NOT NULL,
      transaction_date TEXT NOT NULL,
      filed_date       TEXT NOT NULL,
      PRIMARY KEY (report_url, row_index)
    ) STRICT;

    CREATE INDEX IF NOT EXISTS trades_ticker ON trades (ticker);
    CREATE INDEX IF NOT EXISTS trades_member ON trades (member);
    CREATE INDEX IF NOT EXISTS trades_txn_date ON trades (transaction_date);

    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
  `);
  return db;
}

const now = (): number => Math.floor(Date.now() / 1000);

function meta(key: string): string | undefined {
  const row = connect()
    .prepare('SELECT value FROM meta WHERE key = ?')
    .get(key) as undefined | { value?: string };
  return row?.value;
}

function setMeta(key: string, value: string): void {
  connect()
    .prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    )
    .run(key, value);
}

export interface IndexState {
  /** Epoch seconds of the last completed refresh, if any. */
  readonly lastRefresh: number | undefined;
  readonly newestFiled: string | undefined;
  readonly oldestFiled: string | undefined;
  readonly path: string;
  readonly reports: number;
  /** Distinct tickers held, a rough measure of how useful a search will be. */
  readonly tickers: number;
  readonly trades: number;
}

export function indexState(): IndexState {
  const handle = connect();
  const counts = handle
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM reports) AS reports,
         (SELECT COUNT(*) FROM trades) AS trades,
         (SELECT COUNT(DISTINCT ticker) FROM trades WHERE ticker IS NOT NULL) AS tickers,
         (SELECT MIN(filed_date) FROM reports) AS oldest,
         (SELECT MAX(filed_date) FROM reports) AS newest`
    )
    .get() as {
    newest?: string;
    oldest?: string;
    reports: number;
    tickers: number;
    trades: number;
  };

  const stamp = meta('last_refresh');
  return {
    lastRefresh: stamp ? Number(stamp) : undefined,
    newestFiled: counts.newest ?? undefined,
    oldestFiled: counts.oldest ?? undefined,
    path: defaultPath(),
    reports: counts.reports,
    tickers: counts.tickers,
    trades: counts.trades
  };
}

/** True when the index has never been built, or is older than `maxAgeSeconds`. */
export function isStale(maxAgeSeconds: number): boolean {
  const { lastRefresh } = indexState();
  return lastRefresh === undefined || now() - lastRefresh > maxAgeSeconds;
}

function isIndexed(url: string): boolean {
  return (
    connect().prepare('SELECT 1 FROM reports WHERE url = ?').get(url) !==
    undefined
  );
}

function storeReport(ref: SenateReportRef, trades: DisclosedTrade[]): void {
  const handle = connect();

  // One transaction per report: a half-written report that then gets marked
  // indexed would be a permanent silent gap, since it is never refetched.
  handle.exec('BEGIN');
  try {
    const insert = handle.prepare(
      `INSERT OR REPLACE INTO trades (
         report_url, row_index, member, ticker, asset_name, asset_type,
         transaction_type, owner, amount, transaction_date, filed_date
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const [index, trade] of trades.entries()) {
      insert.run(
        ref.url,
        index,
        trade.member,
        trade.ticker ?? null,
        trade.assetName,
        trade.assetType,
        trade.type,
        trade.owner,
        trade.amount,
        trade.transactionDate,
        trade.filedDate
      );
    }

    handle
      .prepare(
        `INSERT INTO reports (url, member, filed_date, trade_rows, indexed_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           trade_rows = excluded.trade_rows,
           indexed_at = excluded.indexed_at`
      )
      .run(ref.url, ref.member, ref.filedDate, trades.length, now());

    handle.exec('COMMIT');
  } catch (error) {
    handle.exec('ROLLBACK');
    throw error;
  }
}

/** Test seam: inserts a report and its trades without touching the network. */
export function storeReportForTest(
  ref: SenateReportRef,
  trades: readonly DisclosedTrade[]
): void {
  storeReport(ref, [...trades]);
}

export interface RefreshResult {
  /** Reports that failed to parse, by URL and reason. */
  readonly failures: readonly { reason: string; url: string }[];
  /** Reports in the window that are still unindexed after this pass. */
  readonly remaining: number;
  readonly reportsIndexed: number;
  readonly tradesAdded: number;
}

/**
 * Brings the index up to date over a filing-date window.
 *
 * `maxReports` bounds the work per call, because each report is a separate
 * request against a rate-limited government site and a full backfill of the
 * archive runs to tens of minutes. When `remaining` comes back non-zero the
 * caller should say so and invite another pass — the work resumes exactly
 * where it stopped, since indexed reports are skipped.
 */
export async function refreshIndex({
  maxReports = 40,
  since
}: {
  maxReports?: number;
  since: string;
}): Promise<RefreshResult> {
  const pageSize = 100;
  const refs: SenateReportRef[] = [];

  // Page the list until it stops growing. The window is bounded by `since`, so
  // this terminates well short of the full archive in normal use.
  for (let start = 0; start < 2000; start += pageSize) {
    const page = await senateReportList(since, pageSize, start);
    refs.push(...page);
    if (page.length < pageSize) break;
  }

  const pending = refs.filter(ref => !isIndexed(ref.url));
  const batch = pending.slice(0, maxReports);

  let tradesAdded = 0;
  const failures: { reason: string; url: string }[] = [];

  for (const ref of batch) {
    try {
      const trades = await senateReportTrades(ref);
      storeReport(ref, trades);
      tradesAdded += trades.length;
    } catch (error) {
      // One unreadable report must not abandon the rest of the batch; it is
      // recorded so a persistent parse failure is visible rather than silent.
      failures.push({
        reason: error instanceof Error ? error.message : String(error),
        url: ref.url
      });
    }
  }

  setMeta('last_refresh', String(now()));

  return {
    failures,
    remaining: pending.length - batch.length,
    reportsIndexed: batch.length,
    tradesAdded
  };
}

export interface TradeQuery {
  readonly limit?: number;
  readonly member?: string;
  /** Earliest transaction date, ISO. */
  readonly since?: string;
  readonly ticker?: string;
}

export interface IndexedTrade {
  readonly amount: string;
  readonly assetName: string;
  readonly assetType: string;
  readonly filedDate: string;
  readonly member: string;
  readonly owner: string;
  readonly reportUrl: string;
  readonly ticker: string | undefined;
  readonly transactionDate: string;
  readonly type: string;
}

/** Queries the index. Newest transaction first. */
export function searchTrades(query: TradeQuery): IndexedTrade[] {
  const where: string[] = [];
  const params: (number | string)[] = [];

  if (query.ticker) {
    where.push('UPPER(ticker) = ?');
    params.push(query.ticker.trim().toUpperCase());
  }
  if (query.member) {
    // Substring rather than exact: disclosure names carry middle initials and
    // suffixes a caller will not type.
    where.push('LOWER(member) LIKE ?');
    params.push(`%${query.member.trim().toLowerCase()}%`);
  }
  if (query.since) {
    where.push('transaction_date >= ?');
    params.push(query.since);
  }

  const rows = connect()
    .prepare(
      `SELECT member, ticker, asset_name, asset_type, transaction_type, owner,
              amount, transaction_date, filed_date, report_url
         FROM trades
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY transaction_date DESC, member
        LIMIT ?`
    )
    .all(...params, query.limit ?? 100) as Record<string, null | string>[];

  return rows.map(row => ({
    amount: row['amount'] ?? '',
    assetName: row['asset_name'] ?? '',
    assetType: row['asset_type'] ?? '',
    filedDate: row['filed_date'] ?? '',
    member: row['member'] ?? '',
    owner: row['owner'] ?? '',
    reportUrl: row['report_url'] ?? '',
    ticker: row['ticker'] ?? undefined,
    transactionDate: row['transaction_date'] ?? '',
    type: row['transaction_type'] ?? ''
  }));
}

/** The most-traded tickers in the index, for orienting a search. */
export function topTickers(
  limit = 20
): { members: number; ticker: string; trades: number }[] {
  return connect()
    .prepare(
      `SELECT ticker, COUNT(*) AS trades, COUNT(DISTINCT member) AS members
         FROM trades WHERE ticker IS NOT NULL
        GROUP BY ticker ORDER BY trades DESC LIMIT ?`
    )
    .all(limit) as { members: number; ticker: string; trades: number }[];
}

export function closeIndex(): void {
  db?.close();
  db = undefined;
}

/** Test seam: rebinds the module to a fresh database. */
export function openIndexForTest(path: string): void {
  closeIndex();
  process.env.CIGAR_BUTT_CONGRESS_DB = path;
  connect();
}
