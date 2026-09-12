import { cached } from '../cache/store.ts';
import { fetchJson } from '../http/client.ts';
import { type Decimal, dec } from '../math/decimal.ts';

/**
 * Exchange rates, from Frankfurter — European Central Bank reference rates,
 * free, no credential, no cap.
 *
 * Needed the moment a screen looks outside the US, which this method pushes it
 * to: net-nets have been far scarcer in the US than in Japan and Korea for a
 * decade. A tangible book value in yen against a price in yen is fine, but the
 * comparison against a dollar cash balance is not, and a rate applied without
 * its date is the same error as an undated price.
 *
 * ECB rates are published once each business day around 16:00 CET, so a rate is
 * a daily reference figure and not a dealable one. Every result carries the
 * date the rate is for.
 */

const FRANKFURTER = 'https://api.frankfurter.dev/v1';
const FX_RATE = {
  rateKey: 'api.frankfurter.dev',
  requestsPerSecond: 2
} as const;

/** Rates change once a business day, so a day is the natural TTL. */
const TTL_FX = 12 * 60 * 60;

export interface FxRate {
  /** ISO date the rate is for; may predate the request over a weekend. */
  readonly asOf: string;
  readonly base: string;
  readonly quote: string;
  readonly rate: Decimal;
}

interface FrankfurterLatest {
  base?: string;
  date?: string;
  rates?: Record<string, number>;
}

/** One rate, `base` into `quote`. */
export async function fxRate(
  base: string,
  quote: string,
  on?: string
): Promise<FxRate> {
  const from = base.trim().toUpperCase();
  const to = quote.trim().toUpperCase();

  if (from === to) {
    throw new Error(`${from} and ${to} are the same currency.`);
  }

  // A date path returns that day's rate, or the most recent one before it when
  // the market was shut — which is why the response's own date is reported
  // rather than the one that was asked for.
  const path = on ? `${FRANKFURTER}/${on}` : `${FRANKFURTER}/latest`;

  const data = await cached(
    'fx',
    `${from}/${to}/${on ?? 'latest'}`,
    TTL_FX,
    () =>
      fetchJson<FrankfurterLatest>(path, {
        ...FX_RATE,
        searchParams: { base: from, symbols: to }
      })
  );

  const rate = dec(data.rates?.[to]);
  if (!rate || !data.date) {
    throw new Error(
      `No ${from}/${to} rate available${on ? ` for ${on}` : ''}. Frankfurter ` +
        'covers the ECB reference currencies only, so an exotic pair may simply ' +
        'not be published.'
    );
  }

  return { asOf: data.date, base: from, quote: to, rate };
}

/** Currencies Frankfurter publishes, for telling "unsupported" from "typo". */
export async function fxCurrencies(): Promise<Record<string, string>> {
  return cached('fx', 'currencies', TTL_FX, () =>
    fetchJson<Record<string, string>>(`${FRANKFURTER}/currencies`, FX_RATE)
  );
}
