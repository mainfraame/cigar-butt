import { cached, TTL } from '../cache/store.ts';
import { fetchJson } from '../http/client.ts';
import { runPool, type Provider } from './pool.ts';

/**
 * Daily OHLCV history.
 *
 * Separate from `prices.ts` because the two are not the same request. A quote is
 * one figure and can come from anywhere; a bar series is a year or more of
 * history, and the providers that serve one do not all serve the other on a free
 * key. The pool machinery is shared, and deliberately so: the provider ids match
 * the quote pool's, which means both kinds of request draw down the same
 * counters against the same accounts, which is what actually happens.
 *
 * Three properties of a series matter more than which provider served it, and
 * all three are carried on the result rather than assumed:
 *
 * **Adjustment.** Unadjusted history across a split is not merely imprecise, it
 * is wrong by the split factor — a 1-for-10 reverse split shows as a 90% crash
 * that never happened, and every drawdown, average and volatility computed over
 * it is fiction. So each provider declares what its figures are adjusted for and
 * the tool prints it.
 *
 * **Whose volume.** A liquidity estimate is only as good as the volume behind
 * it, and single-venue volume is not the market's. That is why Alpaca is absent
 * here despite being in the quote pool and having by far the most headroom: its
 * free plan carries the IEX feed, roughly 2.5% of consolidated US volume, so a
 * days-to-liquidate figure computed from it would be optimistic by a factor of
 * forty in exactly the thin names where the answer matters.
 *
 * **Depth.** A 200-day average needs 200 sessions and a 52-week range needs a
 * year. A provider whose free tier stops at two years can answer both; one that
 * stops at one year cannot answer the first reliably. The series reports its own
 * first and last bar so the caller can see what it is working with, and the
 * indicators return `undefined` rather than shortening a window to fit.
 *
 * Excluded, with reasons, so nobody re-adds them hopefully:
 *
 * - **Finnhub** — `/stock/candle` is premium. A free key gets "you don't have
 *   access to this resource"; the endpoint's appearance in the free reference
 *   docs is a documentation bug of several years' standing.
 * - **Alpha Vantage** — `TIME_SERIES_DAILY` carries no adjusted close, and the
 *   adjusted series is premium. Unadjusted history plus a 25-request day is the
 *   worst combination available.
 * - **Alpaca** — IEX-feed volume; see above.
 * - **FMP** — its free tier refuses the small caps this server screens, which is
 *   the same reason it sits last in the quote pool.
 */

/** One session, as numbers, because this shape goes through the JSON cache. */
export interface DailyBar {
  readonly close: number;
  /** ISO date. */
  readonly date: string;
  readonly high: number;
  readonly low: number;
  readonly open: number;
  /** Shares. Zero means the name did not trade that session. */
  readonly volume: number;
}

/**
 * What a provider's figures have been restated for.
 *
 * `dividends-and-splits` is a total-return series and the right one for a value
 * strategy, where the dividend is often a large share of the return.
 * `splits` is enough for the statistics here. `none` is a hazard, and is
 * reported rather than hidden.
 */
export type Adjustment = 'dividends-and-splits' | 'none' | 'splits';

export interface BarSeries {
  readonly adjustment: Adjustment;
  readonly bars: readonly DailyBar[];
  /** Which provider served it, so two disagreeing series are diagnosable. */
  readonly source: string;
  readonly ticker: string;
}

interface BarRequest {
  /** ISO date, inclusive. */
  readonly from: string;
  /** ISO date, inclusive. */
  readonly to: string;
}

/**
 * A past daily bar never changes, so the only volatile part of a series is its
 * final bar. Keying the cache on the request's end date means a rerun the same
 * day is free and the next session refetches — one request per ticker per day,
 * rather than the hour-long quote TTL applied to data that is already history.
 *
 * The seven days is how long a spent entry lingers before eviction, not how
 * stale a figure can be: a different end date is a different key.
 */
const BARS_TTL = TTL.bars;

function bad(provider: string, ticker: string, detail = ''): Error {
  return new Error(
    `${provider} returned no usable bars for ${ticker}${detail}`
  );
}

type Num = number | string | undefined;

/**
 * Coerces one upstream row, dropping it when any figure is missing.
 *
 * A dropped bar leaves a visible gap in the count; a defaulted one would leave
 * a zero high, which silently corrupts a true range and a 52-week low alike.
 */
function toBar(
  date: string | undefined,
  open: Num,
  high: Num,
  low: Num,
  close: Num,
  volume: Num
): DailyBar | undefined {
  const o = num(open);
  const h = num(high);
  const l = num(low);
  const c = num(close);
  const v = num(volume);
  if (!date || o === undefined || h === undefined) return undefined;
  if (l === undefined || c === undefined || v === undefined) return undefined;
  return {
    close: c,
    date: date.slice(0, 10),
    high: h,
    low: l,
    open: o,
    volume: v
  };
}

/** One finite number, or undefined. The boundary where JSON becomes arithmetic. */
function num(value: Num): number | undefined {
  if (value === undefined || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function series(
  adjustment: Adjustment,
  source: string,
  ticker: string,
  bars: readonly (DailyBar | undefined)[]
): BarSeries {
  const usable = bars.filter((bar): bar is DailyBar => bar !== undefined);
  if (usable.length === 0) throw bad(source, ticker);
  return { adjustment, bars: usable, source, ticker: ticker.toUpperCase() };
}

/* ------------------------------------------------------------- providers */

/**
 * The preferred source, and by a distance.
 *
 * One request returns the whole window, its adjusted fields are restated for
 * both splits and dividends, and the volume is consolidated. The same endpoint
 * the quote provider already uses, so no new credential and no new host.
 *
 * `adjVolume` matters as much as `adjClose`: after a 1-for-10 reverse split the
 * raw pre-split volume is ten times the post-split share count, and pairing it
 * with an adjusted price overstates historical dollar volume by ten.
 */
function tiingo(request: BarRequest): Provider<BarSeries> {
  return {
    budgets: [
      { limit: 50, per: 'hour' },
      { limit: 1000, per: 'day' },
      { limit: 500, per: 'month', unit: 'symbols' }
    ],
    id: 'tiingo',
    label: 'Tiingo',
    quotaCooldownSeconds: 60 * 60,
    requestsPerSecond: 2,
    run: async (ticker, key, rate) => {
      const rows = await fetchJson<
        {
          adjClose?: Num;
          adjHigh?: Num;
          adjLow?: Num;
          adjOpen?: Num;
          adjVolume?: Num;
          date?: string;
        }[]
      >(
        `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker)}/prices`,
        {
          headers: { authorization: `Token ${key}` },
          rateKey: 'api.tiingo.com',
          requestsPerSecond: rate,
          searchParams: {
            endDate: request.to,
            format: 'json',
            resampleFreq: 'daily',
            startDate: request.from
          }
        }
      );
      return series(
        'dividends-and-splits',
        'tiingo',
        ticker,
        rows.map(row =>
          toBar(
            row.date,
            row.adjOpen,
            row.adjHigh,
            row.adjLow,
            row.adjClose,
            row.adjVolume
          )
        )
      );
    }
  };
}

/**
 * Consolidated tape and split-adjusted, but two years of depth on the free plan
 * and five calls a minute — so it is a good second rather than a first.
 *
 * Not dividend-adjusted: `adjusted=true` restates splits only. For a 52-week
 * drawdown on a name yielding 6% that is a visible difference, which is why the
 * adjustment basis is printed rather than assumed.
 */
function polygon(request: BarRequest): Provider<BarSeries> {
  return {
    budgets: [{ limit: 5, per: 'minute' }],
    id: 'polygon',
    label: 'Polygon.io',
    quotaCooldownSeconds: 60,
    requestsPerSecond: 0.08,
    run: async (ticker, key, rate) => {
      const data = await fetchJson<{
        results?: {
          c?: number;
          h?: number;
          l?: number;
          o?: number;
          t?: number;
          v?: number;
        }[];
      }>(
        `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}` +
          `/range/1/day/${request.from}/${request.to}`,
        {
          headers: { authorization: `Bearer ${key}` },
          rateKey: 'api.polygon.io',
          requestsPerSecond: rate,
          searchParams: { adjusted: 'true', limit: '50000', sort: 'asc' }
        }
      );
      return series(
        'splits',
        'polygon',
        ticker,
        (data.results ?? []).map(row =>
          toBar(
            typeof row.t === 'number'
              ? new Date(row.t).toISOString()
              : undefined,
            row.o,
            row.h,
            row.l,
            row.c,
            row.v
          )
        )
      );
    }
  };
}

/**
 * 800 credits a day and one credit per call whatever the output size, which
 * makes a full history as cheap as a single quote — the most generous free tier
 * here that will serve bars at all.
 *
 * The catch is the adjustment: `time_series` returns the exchange's printed
 * prices, with no split or dividend restatement on the free plan. That is fine
 * for a name with no corporate action in the window and silently wrong for one
 * with a split in it, so it sits behind both adjusted sources and the tool tells
 * the caller to run `check_corporate_actions` when it is what answered.
 */
function twelvedata(request: BarRequest): Provider<BarSeries> {
  return {
    budgets: [
      { limit: 8, per: 'minute' },
      { limit: 800, per: 'day' }
    ],
    id: 'twelvedata',
    isQuotaError: error =>
      /run out of api credits|\bcode.{0,4}429/i.test(String(error)),
    label: 'Twelve Data',
    quotaCooldownSeconds: 60 * 60,
    requestsPerSecond: 0.13,
    run: async (ticker, key, rate) => {
      const data = await fetchJson<{
        message?: string;
        status?: string;
        values?: {
          close?: Num;
          datetime?: string;
          high?: Num;
          low?: Num;
          open?: Num;
          volume?: Num;
        }[];
      }>('https://api.twelvedata.com/time_series', {
        rateKey: 'api.twelvedata.com',
        requestsPerSecond: rate,
        searchParams: {
          apikey: key,
          end_date: request.to,
          interval: '1day',
          outputsize: '5000',
          start_date: request.from,
          symbol: ticker
        }
      });
      if (data.status === 'error') {
        throw bad('twelvedata', ticker, `: ${data.message}`);
      }
      return series(
        'none',
        'twelvedata',
        ticker,
        (data.values ?? []).map(row =>
          toBar(
            row.datetime,
            row.open,
            row.high,
            row.low,
            row.close,
            row.volume
          )
        )
      );
    }
  };
}

/**
 * Last, and for one reason: it is the only source here that covers non-US
 * listings, which is where the net-nets actually are. Twenty calls a day and
 * roughly a year of history on the free tier, so a 200-day average is at the
 * edge of what it can support and a 52-week range may be all of it.
 *
 * Its OHLC are split-adjusted and `adjusted_close` additionally carries
 * dividends. Mixing the two would put a dividend-adjusted close inside a
 * split-only range, so the plain `close` is used and the series is declared
 * split-adjusted.
 */
function eodhd(request: BarRequest): Provider<BarSeries> {
  return {
    budgets: [{ limit: 20, per: 'day' }],
    id: 'eodhd',
    label: 'EOD Historical Data',
    quotaCooldownSeconds: 6 * 60 * 60,
    requestsPerSecond: 1,
    run: async (ticker, key, rate) => {
      const symbol = ticker.includes('.') ? ticker : `${ticker}.US`;
      const rows = await fetchJson<
        {
          close?: Num;
          date?: string;
          high?: Num;
          low?: Num;
          open?: Num;
          volume?: Num;
        }[]
      >(`https://eodhd.com/api/eod/${encodeURIComponent(symbol)}`, {
        rateKey: 'eodhd.com',
        requestsPerSecond: rate,
        searchParams: {
          api_token: key,
          fmt: 'json',
          from: request.from,
          order: 'a',
          period: 'd',
          to: request.to
        }
      });
      return series(
        'splits',
        'eodhd',
        ticker,
        rows.map(row =>
          toBar(row.date, row.open, row.high, row.low, row.close, row.volume)
        )
      );
    }
  };
}

/** Declared order is the fallback order. `CIGAR_BUTT_PROVIDER_ORDER` overrides it. */
function barProviders(request: BarRequest): readonly Provider<BarSeries>[] {
  return [
    tiingo(request),
    polygon(request),
    twelvedata(request),
    eodhd(request)
  ];
}

/* ----------------------------------------------------------------- public */

const DAY_MS = 86_400_000;

/** ISO date `days` before `at`. */
function isoDaysBefore(days: number, at = new Date()): string {
  return new Date(at.getTime() - days * DAY_MS).toISOString().slice(0, 10);
}

export interface BarQuery {
  /**
   * Calendar days of history to request. Sessions are fewer — roughly 252 a
   * year — so a 200-session average needs about 300 calendar days at minimum.
   */
  readonly calendarDays: number;
  readonly ticker: string;
}

/**
 * Daily bars for one ticker, from whichever provider answers first.
 *
 * The request window ends today rather than at the last session, because the
 * caller does not know when the last session was and a provider that has not
 * printed today's bar simply returns one fewer row.
 */
export async function dailyBars(query: BarQuery): Promise<BarSeries> {
  const ticker = query.ticker.trim().toUpperCase();
  const to = new Date().toISOString().slice(0, 10);
  const from = isoDaysBefore(query.calendarDays);

  return cached(
    'bars',
    `${ticker}:${query.calendarDays}:${to}`,
    BARS_TTL,
    async () => {
      const outcome = await runPool(barProviders({ from, to }), ticker);
      return outcome.value;
    }
  );
}
