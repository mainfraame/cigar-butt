import { cached, TTL } from '../cache/store.ts';
import { providerById } from '../config/providers.ts';
import { getCredential } from '../config/store.ts';
import { fetchJson } from '../http/client.ts';

/**
 * Prices. Three providers, tried in order of how much they can be trusted and
 * how much of them the free tier gives you:
 *
 *   Tiingo       — split- and dividend-adjusted closes. First choice.
 *   Polygon      — previous close; also the only source here for whole-market
 *                  bars and delisting reference data.
 *   Alpha Vantage— last resort. 25 requests/day makes it a spot-check.
 *
 * Every quote carries the date its figure is *as of*. Undated prices are the
 * single largest source of wrong answers in this domain: the same ticker can
 * come back 60% apart from two caches minutes apart, and the number without its
 * date is arbitrary.
 */

export interface Quote {
  /** ISO date the close is for. Never omitted. */
  readonly asOf: string;
  readonly price: number;
  readonly source: 'alphavantage' | 'polygon' | 'tiingo';
  readonly ticker: string;
}

interface AlphaVantageQuote {
  'Global Quote'?: { '05. price'?: string; '07. latest trading day'?: string };
  Information?: string;
  Note?: string;
}

interface PolygonPrevClose {
  results?: { c?: number; T?: string; t?: number }[];
  status?: string;
}

interface TiingoPriceRow {
  adjClose?: number;
  close?: number;
  date?: string;
}

async function tiingoQuote(ticker: string, key: string): Promise<Quote> {
  const rows = await fetchJson<TiingoPriceRow[]>(
    `https://api.tiingo.com/tiingo/daily/${encodeURIComponent(ticker)}/prices`,
    {
      headers: { authorization: `Token ${key}` },
      rateKey: 'api.tiingo.com',
      requestsPerSecond: 2
    }
  );

  const row = rows.at(-1);
  const price = row?.adjClose ?? row?.close;
  if (!row?.date || typeof price !== 'number') {
    throw new Error(`Tiingo returned no usable price row for ${ticker}.`);
  }
  return {
    asOf: row.date.slice(0, 10),
    price,
    source: 'tiingo',
    ticker: ticker.toUpperCase()
  };
}

async function polygonQuote(ticker: string, key: string): Promise<Quote> {
  const data = await fetchJson<PolygonPrevClose>(
    `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(ticker)}/prev`,
    {
      // Header rather than the apiKey query parameter, so the key stays out of
      // shell history, proxy logs, and any error that echoes the URL.
      headers: { authorization: `Bearer ${key}` },
      rateKey: 'api.polygon.io',
      requestsPerSecond: 0.08
    }
  );

  const result = data.results?.[0];
  if (typeof result?.c !== 'number' || typeof result.t !== 'number') {
    throw new Error(`Polygon returned no previous close for ${ticker}.`);
  }
  return {
    asOf: new Date(result.t).toISOString().slice(0, 10),
    price: result.c,
    source: 'polygon',
    ticker: ticker.toUpperCase()
  };
}

async function alphaVantageQuote(ticker: string, key: string): Promise<Quote> {
  const data = await fetchJson<AlphaVantageQuote>(
    'https://www.alphavantage.co/query',
    {
      rateKey: 'www.alphavantage.co',
      requestsPerSecond: 0.08,
      // Alpha Vantage supports no header alternative, so the key rides in the
      // query string. redactUrl in the HTTP client scrubs it from errors.
      searchParams: { apikey: key, function: 'GLOBAL_QUOTE', symbol: ticker }
    }
  );

  // The free tier answers 200 with a prose "Note"/"Information" body when the
  // daily cap is hit, so an absent quote is not necessarily a bad ticker.
  const globalQuote = data['Global Quote'];
  const price = Number(globalQuote?.['05. price']);
  const asOf = globalQuote?.['07. latest trading day'];
  if (!asOf || !Number.isFinite(price) || price <= 0) {
    throw new Error(
      `Alpha Vantage returned no quote for ${ticker}` +
        `${(data.Note ?? data.Information) ? ': rate limit or plan message returned' : ''}.`
    );
  }
  return { asOf, price, source: 'alphavantage', ticker: ticker.toUpperCase() };
}

/**
 * Fetches one quote, falling through the provider list. Every provider's
 * failure is reported if all of them fail — a single "no price" message hides
 * which of "bad ticker", "no key", and "rate limited" actually happened.
 */
async function quote(ticker: string): Promise<Quote> {
  const attempts: {
    fn: (t: string, k: string) => Promise<Quote>;
    id: string;
  }[] = [
    { fn: tiingoQuote, id: 'tiingo' },
    { fn: polygonQuote, id: 'polygon' },
    { fn: alphaVantageQuote, id: 'alphavantage' }
  ];

  const failures: string[] = [];
  for (const attempt of attempts) {
    const spec = providerById(attempt.id);
    const key = spec ? getCredential(spec.envVar) : undefined;
    if (!key) {
      failures.push(`${attempt.id}: no API key configured`);
      continue;
    }
    try {
      // Cached under the provider, not just the ticker: two providers can
      // legitimately disagree, and blending them under one key would hide it.
      return await cached(
        'quote',
        `${attempt.id}/${ticker.toUpperCase()}`,
        TTL.prices,
        () => attempt.fn(ticker, key)
      );
    } catch (error) {
      failures.push(
        `${attempt.id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  throw new Error(
    `No price available for ${ticker}. Tried:\n${failures.map(f => `  - ${f}`).join('\n')}`
  );
}

/** Quotes for many tickers. Partial success is the normal case; report both halves. */
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
