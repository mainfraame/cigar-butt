import { cached, TTL } from '../cache/store.ts';
import { getCredential } from '../config/store.ts';
import { fetchJson } from '../http/client.ts';
import {
  poolStatus,
  runPool,
  sweepUsage,
  type Provider,
  type ProviderStatus
} from './pool.ts';

/**
 * Quotes, from whichever provider can currently answer.
 *
 * The providers below are interchangeable for this purpose, so they are a pool
 * rather than a hardcoded chain: one that has no key is skipped, one that
 * reports a cap is put on a cooldown, and the next is tried. That is what makes
 * a screen of any size survivable on free tiers, where Alpha Vantage allows ~25
 * requests a day and Polygon 5 a minute.
 *
 * Every quote carries the date its figure is *as of* and the provider that
 * served it. Undated prices are the single largest source of wrong answers in
 * this domain — the same ticker has come back 60% apart from two caches minutes
 * apart — and naming the provider is what makes two disagreeing figures
 * diagnosable rather than merely confusing.
 */

export interface Quote {
  /** ISO date the close is for. Never omitted. */
  readonly asOf: string;
  readonly price: number;
  /** Which provider served it. Not a fixed union: the pool is extensible. */
  readonly source: string;
  readonly ticker: string;
}

type Num = number | string | undefined;

/** Alpha Vantage answers HTTP 200 with prose when the daily cap is spent. */
const PROSE_CAP = /rate limit|higher api call|premium|thank you for using/i;

function bad(provider: string, ticker: string, detail = ''): Error {
  return new Error(
    `${provider} returned no usable quote for ${ticker}${detail}`
  );
}

function toQuote(
  source: string,
  ticker: string,
  price: Num,
  asOf: string | undefined
): Quote {
  const value = Number(price);
  if (!asOf || !Number.isFinite(value) || value <= 0) {
    throw bad(source, ticker);
  }
  return {
    asOf: asOf.slice(0, 10),
    price: value,
    source,
    ticker: ticker.toUpperCase()
  };
}

/* ------------------------------------------------------------- providers */

const tiingo: Provider<Quote> = {
  // Verified on tiingo.com/about/pricing: 50 requests/hour, 1,000/day, and
  // 500 unique symbols/month. The symbol cap is the one that bites — a single
  // 200-name screen spends 40% of a month while the request counters look fine.
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
      { adjClose?: Num; close?: Num; date?: string }[]
    >(
      `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker)}/prices`,
      {
        headers: { authorization: `Token ${key}` },
        rateKey: 'api.tiingo.com',
        requestsPerSecond: rate
      }
    );
    const row = rows.at(-1);
    // adjClose is split- AND dividend-adjusted; for a value screen the
    // dividend is often a large share of the return, so prefer it.
    return toQuote('tiingo', ticker, row?.adjClose ?? row?.close, row?.date);
  }
};

const polygon: Provider<Quote> = {
  // 5/minute on the free Basic plan; every paid tier is unlimited. Someone on
  // a paid plan should set CIGAR_BUTT_BUDGET_POLYGON_MINUTE=0.
  budgets: [{ limit: 5, per: 'minute' }],
  id: 'polygon',
  label: 'Polygon.io',
  quotaCooldownSeconds: 60,
  // 5/minute on the free Basic plan. Paid plans are far higher — override with
  // CIGAR_BUTT_RATE_POLYGON rather than editing this.
  requestsPerSecond: 0.08,
  run: async (ticker, key, rate) => {
    const data = await fetchJson<{ results?: { c?: number; t?: number }[] }>(
      `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/prev`,
      {
        // Header rather than the apiKey query parameter, so the key stays out
        // of shell history, proxy logs, and any error that echoes the URL.
        headers: { authorization: `Bearer ${key}` },
        rateKey: 'api.polygon.io',
        requestsPerSecond: rate
      }
    );
    const result = data.results?.[0];
    return toQuote(
      'polygon',
      ticker,
      result?.c,
      typeof result?.t === 'number'
        ? new Date(result.t).toISOString()
        : undefined
    );
  }
};

const alphavantage: Provider<Quote> = {
  // 25 requests/day, and 5/minute alongside it.
  budgets: [
    { limit: 5, per: 'minute' },
    { limit: 25, per: 'day' }
  ],
  id: 'alphavantage',
  isQuotaError: error => PROSE_CAP.test(String(error)),
  label: 'Alpha Vantage',
  // ~25 requests/day, so a cap costs the rest of the day rather than a minute.
  quotaCooldownSeconds: 6 * 60 * 60,
  requestsPerSecond: 0.08,
  run: async (ticker, key, rate) => {
    const data = await fetchJson<{
      'Global Quote'?: {
        '05. price'?: string;
        '07. latest trading day'?: string;
      };
      Information?: string;
      Note?: string;
    }>('https://www.alphavantage.co/query', {
      rateKey: 'www.alphavantage.co',
      requestsPerSecond: rate,
      // No header alternative exists here, so the key rides in the query
      // string; redactUrl in the HTTP client scrubs it from any error.
      searchParams: { apikey: key, function: 'GLOBAL_QUOTE', symbol: ticker }
    });

    // The free tier answers 200 with a prose body once the cap is spent, so a
    // missing quote is not necessarily a bad ticker.
    const message = data.Note ?? data.Information;
    if (message) throw bad('alphavantage', ticker, `: ${message}`);
    return toQuote(
      'alphavantage',
      ticker,
      data['Global Quote']?.['05. price'],
      data['Global Quote']?.['07. latest trading day']
    );
  }
};

const fmp: Provider<Quote> = {
  budgets: [{ limit: 250, per: 'day' }],
  id: 'fmp',
  isQuotaError: error => PROSE_CAP.test(String(error)),
  label: 'Financial Modeling Prep',
  quotaCooldownSeconds: 6 * 60 * 60,
  requestsPerSecond: 1,
  run: async (ticker, key, rate) => {
    const rows = await fetchJson<{ price?: Num; symbol?: string }[]>(
      'https://financialmodelingprep.com/stable/quote',
      {
        rateKey: 'financialmodelingprep.com',
        requestsPerSecond: rate,
        searchParams: { apikey: key, symbol: ticker }
      }
    );
    // FMP's quote carries no trade date, only a timestamp on some plans. The
    // honest as-of is today: claiming a date the payload does not contain is
    // exactly the failure this server exists to prevent.
    return toQuote(
      'fmp',
      ticker,
      rows[0]?.price,
      new Date().toISOString().slice(0, 10)
    );
  }
};

const twelvedata: Provider<Quote> = {
  // 800 credits/day and 8/minute; a quote costs one credit.
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
      close?: Num;
      datetime?: string;
      message?: string;
      status?: string;
    }>('https://api.twelvedata.com/quote', {
      rateKey: 'api.twelvedata.com',
      requestsPerSecond: rate,
      searchParams: { apikey: key, symbol: ticker }
    });
    if (data.status === 'error')
      throw bad('twelvedata', ticker, `: ${data.message}`);
    return toQuote('twelvedata', ticker, data.close, data.datetime);
  }
};

const finnhub: Provider<Quote> = {
  // The most generous free tier here: 60/minute with no daily cap.
  budgets: [{ limit: 60, per: 'minute' }],
  id: 'finnhub',
  label: 'Finnhub',
  quotaCooldownSeconds: 60,
  requestsPerSecond: 1,
  run: async (ticker, key, rate) => {
    const data = await fetchJson<{ c?: number; t?: number }>(
      'https://finnhub.io/api/v1/quote',
      {
        headers: { 'x-finnhub-token': key },
        rateKey: 'finnhub.io',
        requestsPerSecond: rate,
        searchParams: { symbol: ticker }
      }
    );
    // Finnhub answers 200 with c=0 for a symbol it does not cover.
    return toQuote(
      'finnhub',
      ticker,
      data.c,
      typeof data.t === 'number' && data.t > 0
        ? new Date(data.t * 1000).toISOString()
        : undefined
    );
  }
};

const alpaca: Provider<Quote> = {
  // 200 requests/minute on the free Basic plan — by a distance the most
  // headroom of anything here, which makes it a strong primary for a wide
  // screen. Paid plans reach 10,000/min.
  budgets: [{ limit: 200, per: 'minute' }],
  id: 'alpaca',
  label: 'Alpaca',
  quotaCooldownSeconds: 60,
  requestsPerSecond: 3,
  run: async (ticker, key, rate) => {
    // Alpaca is the one provider here needing two credentials. The pool joins
    // on the key id, so the secret is read directly.
    const secret = getCredential('ALPACA_API_SECRET_KEY');
    if (!secret) {
      throw new Error(
        'ALPACA_API_KEY_ID is set but ALPACA_API_SECRET_KEY is not; Alpaca needs both.'
      );
    }

    const data = await fetchJson<{ bar?: { c?: number; t?: string } }>(
      `https://data.alpaca.markets/v2/stocks/${encodeURIComponent(ticker)}/bars/latest`,
      {
        headers: { 'APCA-API-KEY-ID': key, 'APCA-API-SECRET-KEY': secret },
        rateKey: 'data.alpaca.markets',
        requestsPerSecond: rate,
        // The free plan carries the IEX feed only; asking for SIP without a
        // subscription is rejected rather than downgraded.
        searchParams: { feed: 'iex' }
      }
    );
    return toQuote('alpaca', ticker, data.bar?.c, data.bar?.t);
  }
};

const eodhd: Provider<Quote> = {
  // 20 calls/day is the tightest budget in the pool, so it sits last and acts
  // as a genuine last resort. It earns its place by covering non-US listings,
  // which nothing else here does.
  budgets: [{ limit: 20, per: 'day' }],
  id: 'eodhd',
  label: 'EOD Historical Data',
  quotaCooldownSeconds: 6 * 60 * 60,
  requestsPerSecond: 1,
  run: async (ticker, key, rate) => {
    // An unsuffixed ticker is assumed US; a caller wanting Tokyo passes
    // "7203.TSE" and it is forwarded untouched.
    const symbol = ticker.includes('.') ? ticker : `${ticker}.US`;
    const rows = await fetchJson<
      { adjusted_close?: Num; close?: Num; date?: string }[]
    >(`https://eodhd.com/api/eod/${encodeURIComponent(symbol)}`, {
      rateKey: 'eodhd.com',
      requestsPerSecond: rate,
      searchParams: {
        api_token: key,
        fmt: 'json',
        order: 'd',
        period: 'd'
      }
    });
    const row = rows[0];
    return toQuote(
      'eodhd',
      ticker,
      row?.adjusted_close ?? row?.close,
      row?.date
    );
  }
};

/**
 * Declared order is the fallback order, best-trusted first. A user can put the
 * service they pay for at the front with CIGAR_BUTT_PROVIDER_ORDER.
 */
const QUOTE_PROVIDERS: readonly Provider<Quote>[] = [
  tiingo,
  alpaca,
  polygon,
  finnhub,
  twelvedata,
  fmp,
  alphavantage,
  eodhd
];

/** Test seam: lets the budget declarations be asserted without exporting the pool. */
export const QUOTE_PROVIDERS_FOR_TEST = QUOTE_PROVIDERS;

/* ----------------------------------------------------------------- public */

export function quoteProviderStatus(): ProviderStatus[] {
  // Cheap, and keeps the usage tables from accumulating rolled-over windows.
  sweepUsage();
  return poolStatus(QUOTE_PROVIDERS);
}

/** One quote, from whichever provider answers first. */
async function quote(ticker: string): Promise<Quote> {
  const symbol = ticker.trim().toUpperCase();
  // Cached per provider-agnostic symbol: whichever source served it, the cache
  // entry records which one, so a later reader can still see the provenance.
  return cached('quote', symbol, TTL.prices, async () => {
    const outcome = await runPool(QUOTE_PROVIDERS, symbol);
    return outcome.value;
  });
}

/** Quotes for many tickers. Partial success is normal; report both halves. */
export async function quotes(
  tickers: readonly string[]
): Promise<{ failed: { reason: string; ticker: string }[]; quotes: Quote[] }> {
  const found: Quote[] = [];
  const failed: { reason: string; ticker: string }[] = [];

  for (const ticker of tickers) {
    try {
      found.push(await quote(ticker));
    } catch (error) {
      failed.push({
        reason: error instanceof Error ? error.message : String(error),
        ticker
      });
    }
  }

  return { failed, quotes: found };
}
