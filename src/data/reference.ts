import { cached } from '../cache/store.ts';
import { providerById } from '../config/providers.ts';
import { requireCredential } from '../config/store.ts';
import { fetchJson } from '../http/client.ts';
import { dec, div, type Decimal } from '../math/decimal.ts';

/**
 * Polygon reference data: listing status and corporate actions.
 *
 * Two failures this catches, both of which produce a number that looks fine.
 *
 * A split between the balance-sheet date and today silently corrupts every
 * per-share figure derived from a filing: the share count is pre-split and the
 * price is post-split, so a 1-for-10 reverse split makes a name look ten times
 * cheaper than it is. EDGAR reports the share count as filed and has no reason
 * to mention the split.
 *
 * And a ticker that has been delisted or reassigned still resolves to a company
 * in the EDGAR index long after it stopped trading. `active: false` with a
 * delisting date is the fact that stops a dead name entering a screen.
 *
 * Prices come from `prices.ts`; this module deliberately fetches none.
 */

const POLYGON_RATE = {
  rateKey: 'api.polygon.io',
  requestsPerSecond: 0.08
} as const;

/**
 * A day. Listing status and completed splits are settled facts; the only thing
 * that moves inside a day is an action announced today, and one that
 * imminent belongs in the filing index, not here.
 */
const TTL_REFERENCE = 24 * 60 * 60;

export interface Dividend {
  readonly cashAmount?: number;
  readonly declarationDate?: string;
  readonly exDate: string;
  readonly frequency?: number;
  readonly payDate?: string;
}

export interface Split {
  /** The date the split took effect, ISO. */
  readonly executionDate: string;
  /** 1-for-10 reverse split has ratio 0.1; a 2-for-1 has 2. */
  readonly ratio?: number;
  readonly splitFrom?: number;
  readonly splitTo?: number;
}

export interface TickerReference {
  readonly active: boolean;
  readonly cik?: string;
  /** Date the listing ended, when it has. */
  readonly delistedOn?: string;
  readonly exchange?: string;
  /** Date Polygon last refreshed this record. */
  readonly lastUpdated?: string;
  readonly listedOn?: string;
  readonly name?: string;
  readonly sharesOutstanding?: number;
  readonly ticker: string;
  readonly type?: string;
}

interface PolygonDividendsResponse {
  readonly results?: {
    readonly cash_amount?: number;
    readonly declaration_date?: string;
    readonly ex_dividend_date?: string;
    readonly frequency?: number;
    readonly pay_date?: string;
  }[];
}

interface PolygonSplitsResponse {
  readonly results?: {
    readonly execution_date?: string;
    readonly split_from?: number;
    readonly split_to?: number;
  }[];
}

interface PolygonTickerResponse {
  readonly results?: {
    readonly active?: boolean;
    readonly cik?: string;
    readonly delisted_utc?: string;
    readonly last_updated_utc?: string;
    readonly list_date?: string;
    readonly name?: string;
    readonly primary_exchange?: string;
    readonly share_class_shares_outstanding?: number;
    readonly ticker?: string;
    readonly type?: string;
    readonly weighted_shares_outstanding?: number;
  };
}

function polygonKey(): string {
  const spec = providerById('polygon');
  if (!spec) throw new Error('Polygon is not registered as a provider.');
  return requireCredential(spec);
}

/** Header auth, so the key stays out of proxy logs and error messages. */
function authorization(key: string): { readonly authorization: string } {
  return { authorization: `Bearer ${key}` };
}

const day = (value: string | undefined): string | undefined =>
  value?.slice(0, 10);

/** Listing status and share count for one ticker. */
export async function tickerReference(
  ticker: string
): Promise<TickerReference> {
  const key = polygonKey();
  const symbol = ticker.toUpperCase();

  return cached('polygon-ticker', symbol, TTL_REFERENCE, async () => {
    const data = await fetchJson<PolygonTickerResponse>(
      `https://api.polygon.io/v3/reference/tickers/${encodeURIComponent(symbol)}`,
      { ...POLYGON_RATE, headers: authorization(key) }
    );

    const result = data.results;
    if (!result) {
      throw new Error(`Polygon has no reference record for ${symbol}.`);
    }

    return {
      // Polygon omits `active` on some records; a present delisting date is the
      // stronger signal and settles it either way.
      active: result.active ?? result.delisted_utc === undefined,
      cik: result.cik,
      delistedOn: day(result.delisted_utc),
      exchange: result.primary_exchange,
      lastUpdated: day(result.last_updated_utc),
      listedOn: result.list_date,
      name: result.name,
      sharesOutstanding:
        result.share_class_shares_outstanding ??
        result.weighted_shares_outstanding,
      ticker: symbol,
      type: result.type
    };
  });
}

/** Splits for one ticker, newest first. */
export async function splits(ticker: string, limit = 10): Promise<Split[]> {
  const key = polygonKey();
  const symbol = ticker.toUpperCase();

  return cached(
    'polygon-splits',
    `${symbol}/${limit}`,
    TTL_REFERENCE,
    async () => {
      const data = await fetchJson<PolygonSplitsResponse>(
        'https://api.polygon.io/v3/reference/splits',
        {
          ...POLYGON_RATE,
          headers: authorization(key),
          searchParams: {
            limit: String(limit),
            order: 'desc',
            sort: 'execution_date',
            ticker: symbol
          }
        }
      );

      const rows: Split[] = [];
      for (const result of data.results ?? []) {
        if (!result.execution_date) continue;
        rows.push({
          executionDate: result.execution_date,
          ratio: div(dec(result.split_to), dec(result.split_from))
            ?.toDecimalPlaces(6)
            .toNumber(),
          splitFrom: result.split_from,
          splitTo: result.split_to
        });
      }
      return rows;
    }
  );
}

/** Cash dividends for one ticker, newest ex-date first. */
export async function dividends(
  ticker: string,
  limit = 8
): Promise<Dividend[]> {
  const key = polygonKey();
  const symbol = ticker.toUpperCase();

  return cached(
    'polygon-dividends',
    `${symbol}/${limit}`,
    TTL_REFERENCE,
    async () => {
      const data = await fetchJson<PolygonDividendsResponse>(
        'https://api.polygon.io/v3/reference/dividends',
        {
          ...POLYGON_RATE,
          headers: authorization(key),
          searchParams: {
            limit: String(limit),
            order: 'desc',
            sort: 'ex_dividend_date',
            ticker: symbol
          }
        }
      );

      const rows: Dividend[] = [];
      for (const result of data.results ?? []) {
        if (!result.ex_dividend_date) continue;
        rows.push({
          cashAmount: result.cash_amount,
          declarationDate: result.declaration_date,
          exDate: result.ex_dividend_date,
          frequency: result.frequency,
          payDate: result.pay_date
        });
      }
      return rows;
    }
  );
}

/** A whole-market close, keyed by ticker. */
export interface MarketCloses {
  readonly asOf: string;
  readonly closes: ReadonlyMap<string, Decimal>;
}

interface GroupedResponse {
  queryCount?: number;
  results?: { c?: number; T?: string }[];
  resultsCount?: number;
  status?: string;
}

/**
 * Every US equity's close for one session, in a single request.
 *
 * This is what makes a market-wide *price* screen affordable. Quoting five
 * thousand filers one at a time is impossible on any free tier — Tiingo
 * allows fifty symbols an hour — so without this the screen can only rank
 * balance-sheet shape, which structurally surfaces companies whose balance
 * sheet is nothing but cash and buries the profitable business trading below
 * its tangible book. That is the opposite of what Schloss bought.
 *
 * The date is the session the data belongs to, returned alongside, because a
 * close is meaningless without knowing which day's it is. Polygon serves the
 * previous session on a free plan and returns an empty set on a weekend or
 * holiday rather than the last trading day, so the caller walks back.
 */
export async function marketCloses(date: string): Promise<MarketCloses> {
  const key = polygonKey();

  const data = await cached('polygon-grouped', date, TTL_REFERENCE, () =>
    fetchJson<GroupedResponse>(
      `https://api.polygon.io/v2/aggs/grouped/locale/us/market/stocks/${date}`,
      {
        ...POLYGON_RATE,
        headers: authorization(key),
        searchParams: { adjusted: 'true' }
      }
    )
  );

  const closes = new Map<string, Decimal>();
  for (const row of data.results ?? []) {
    const close = dec(row.c);
    if (!row.T || !close) continue;
    closes.set(row.T.toUpperCase(), close);
  }

  return { asOf: date, closes };
}

/**
 * The most recent session with data, walking back from `from`.
 *
 * Weekends, holidays and the lag on a free plan all return an empty set, and
 * an empty set is indistinguishable from "the market was shut" — so it walks
 * rather than guessing a calendar.
 */
export async function latestMarketCloses(
  from: Date = new Date(),
  maxDaysBack = 6
): Promise<MarketCloses | undefined> {
  for (let back = 1; back <= maxDaysBack; back += 1) {
    const date = new Date(from.getTime() - back * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const result = await marketCloses(date);
    if (result.closes.size > 0) return result;
  }
  return undefined;
}
