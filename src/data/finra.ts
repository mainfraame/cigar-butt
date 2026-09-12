import { sortBy } from 'lodash-es';

import { cached } from '../cache/store.ts';
import { fetchJson } from '../http/client.ts';
import { type Decimal, dec, div } from '../math/decimal.ts';

/**
 * FINRA consolidated short interest. Free, no credential.
 *
 * This answers the question the method insists you answer per name — *why is
 * this cheap?* — with a fact rather than a narrative. A crowded short on a
 * sub-tangible-book name is the market stating that the discount has a reason,
 * and it belongs in that answer rather than acting as an automatic veto. One
 * name in the source research showed 33% of float short.
 *
 * Two API constraints shape this module. Per-symbol filtering is POST-only —
 * `compareFilters` sent as a GET query parameter is silently ignored, which
 * returns the whole market and looks like success. And server-side sorting is
 * refused unless every partition key is pinned with an EQUAL filter, so the
 * window is narrowed with a date-range filter and ordered here.
 */

const FINRA_URL =
  'https://api.finra.org/data/group/otcMarket/name/consolidatedShortInterest';

const FINRA_RATE = { rateKey: 'api.finra.org', requestsPerSecond: 2 } as const;

/** Settlement data is published twice a month; a day is plenty. */
const TTL_SHORT_INTEREST = 24 * 60 * 60;

/** How far back to ask for. Bi-monthly reporting means ~8 rows per year. */
const WINDOW_DAYS = 400;

interface ShortInterestRow {
  readonly averageDailyVolume?: Decimal;
  readonly changeFromPrior?: Decimal;
  /** Shares short as a multiple of average daily volume — the squeeze metric. */
  readonly daysToCover?: Decimal;
  readonly issueName?: string;
  readonly previousShares?: Decimal;
  /** ISO settlement date. Every figure here is as of this date. */
  readonly settlementDate: string;
  readonly shares?: Decimal;
}

export interface ShortInterestReport {
  readonly latest?: ShortInterestRow;
  /** Newest first. */
  readonly rows: readonly ShortInterestRow[];
  readonly ticker: string;
  /** Fraction change in shares short from the oldest to the newest reading. */
  readonly trend?: Decimal;
}

interface FinraRow {
  averageDailyVolumeQuantity?: null | number;
  changePreviousNumber?: null | number;
  currentShortPositionQuantity?: null | number;
  daysToCoverQuantity?: null | number;
  issueName?: null | string;
  previousShortPositionQuantity?: null | number;
  settlementDate?: null | string;
}

function toRow(raw: FinraRow): ShortInterestRow | undefined {
  if (!raw.settlementDate) return undefined;
  return {
    averageDailyVolume: dec(raw.averageDailyVolumeQuantity),
    changeFromPrior: dec(raw.changePreviousNumber),
    daysToCover: dec(raw.daysToCoverQuantity),
    issueName: raw.issueName ?? undefined,
    previousShares: dec(raw.previousShortPositionQuantity),
    settlementDate: raw.settlementDate.slice(0, 10),
    shares: dec(raw.currentShortPositionQuantity)
  };
}

/**
 * Short interest history for one ticker, newest first.
 *
 * @param now injected so the window arithmetic is testable.
 */
export async function shortInterest(
  ticker: string,
  { now = new Date() }: { now?: Date } = {}
): Promise<ShortInterestReport> {
  const symbol = ticker.trim().toUpperCase();
  const startDate = new Date(now.getTime() - WINDOW_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  const endDate = now.toISOString().slice(0, 10);

  const raw = await cached(
    'finra-short-interest',
    `${symbol}/${endDate}`,
    TTL_SHORT_INTEREST,
    () =>
      fetchJson<FinraRow[]>(FINRA_URL, {
        ...FINRA_RATE,
        body: {
          compareFilters: [
            {
              compareType: 'EQUAL',
              fieldName: 'symbolCode',
              fieldValue: symbol
            }
          ],
          dateRangeFilters: [
            { endDate, fieldName: 'settlementDate', startDate }
          ],
          limit: 100
        }
      })
  );

  const rows = sortBy(
    (Array.isArray(raw) ? raw : [])
      .map(toRow)
      .filter((row): row is ShortInterestRow => row !== undefined),
    row => row.settlementDate
  ).toReversed();

  const latest = rows[0];
  const oldest = rows.at(-1);

  return {
    latest,
    rows,
    ticker: symbol,
    trend:
      latest?.shares && oldest?.shares && rows.length > 1
        ? div(latest.shares.minus(oldest.shares), oldest.shares)
        : undefined
  };
}
