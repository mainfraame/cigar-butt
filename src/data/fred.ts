import { cached } from '../cache/store.ts';
import { providerById } from '../config/providers.ts';
import { getCredential, requireCredential } from '../config/store.ts';
import { fetchJson } from '../http/client.ts';
import { dec, div } from '../math/decimal.ts';

import type { Decimal } from '../math/decimal.ts';

/**
 * FRED, for the two macro figures this method actually uses.
 *
 * Graham's earnings-yield test is not an absolute number: he required an
 * earnings yield of at least twice the Aaa corporate bond yield, so the hurdle
 * a candidate must clear moves with the bond market. Quoting a fixed P/E
 * ceiling from a 1973 edition applies a 1973 bond yield to a 2026 balance
 * sheet. And a five-year holding period on a deep-value book is a nominal
 * return until CPI is subtracted from it.
 *
 * Every observation carries the date it is for, and CPI carries the month it
 * covers rather than the day it was published.
 */

/**
 * Twelve hours. CPI is monthly and the yield series are daily and revised in
 * place, so anything shorter spends the quota re-reading a number that has not
 * moved; anything longer can serve yesterday's yield during a rate move.
 */
const TTL_MACRO = 12 * 60 * 60;

/** The series this server reads, and what each one is for. */
const SERIES = {
  aaa: {
    id: 'AAA',
    label: "Moody's Seasoned Aaa Corporate Bond Yield",
    units: 'percent per annum'
  },
  cpi: {
    id: 'CPIAUCSL',
    label: 'CPI for All Urban Consumers, all items, seasonally adjusted',
    units: 'index 1982-84 = 100'
  },
  tenYear: {
    id: 'DGS10',
    label: '10-Year Treasury constant maturity',
    units: 'percent per annum'
  }
} as const;

type SeriesKey = keyof typeof SERIES;

interface Observation {
  /** Date the figure is *for*, not the date it was published. */
  readonly asOf: string;
  readonly value: number;
}

export interface MacroSnapshot {
  /** Aaa yield as a fraction, e.g. 0.052. */
  readonly aaaYield?: Observation;
  readonly cpi?: Observation;
  /** Trailing twelve-month CPI change, as a fraction. */
  readonly cpiYearOverYear?: Observation;
  /**
   * Graham's rule: earnings yield must be at least twice the Aaa yield. Stated
   * here as the P/E that yield implies, because that is the form a screen uses.
   */
  readonly grahamMaxPe?: number;
  readonly tenYearYield?: Observation;
}

interface FredObservationsResponse {
  readonly observations?: { readonly date?: string; readonly value?: string }[];
}

/** True when a FRED key is present. The macro tool is optional by design. */
export function fredConfigured(): boolean {
  const spec = providerById('fred');
  return spec ? getCredential(spec.envVar) !== undefined : false;
}

/**
 * Most recent observations for one series, newest first. FRED writes a lone
 * `.` for a missing value — a market holiday on a daily series — and those
 * rows are dropped rather than coerced to zero.
 */
async function observations(
  key: SeriesKey,
  limit = 14
): Promise<Observation[]> {
  const spec = providerById('fred');
  if (!spec) throw new Error('FRED is not registered as a provider.');
  const apiKey = requireCredential(spec);
  const series = SERIES[key].id;

  return cached('fred', `${series}/${limit}`, TTL_MACRO, async () => {
    const data = await fetchJson<FredObservationsResponse>(
      'https://api.stlouisfed.org/fred/series/observations',
      {
        rateKey: 'api.stlouisfed.org',
        requestsPerSecond: 2,
        // FRED accepts the key only as a query parameter; redactUrl in the HTTP
        // client scrubs it from any error that names the URL.
        searchParams: {
          api_key: apiKey,
          file_type: 'json',
          limit: String(limit),
          series_id: series,
          sort_order: 'desc'
        }
      }
    );

    const rows: Observation[] = [];
    for (const row of data.observations ?? []) {
      const value = dec(row.value);
      if (!row.date || value === undefined) continue;
      rows.push({ asOf: row.date, value: value.toNumber() });
    }
    if (rows.length === 0) {
      throw new Error(`FRED returned no usable observations for ${series}.`);
    }
    return rows;
  });
}

/** Percent-per-annum quotes come back as 5.2, not 0.052. */
function asFraction(value: Decimal | undefined): Decimal | undefined {
  return value?.div(100);
}

/** Latest reading of a series, or undefined when the fetch fails. */
async function latest(key: SeriesKey): Promise<Observation | undefined> {
  try {
    const rows = await observations(key, 2);
    return rows[0];
  } catch {
    // A missing optional series degrades the snapshot; it does not fail it.
    return undefined;
  }
}

/**
 * The macro backdrop a valuation is being judged against. Every field is
 * optional: FRED is an optional credential, and a partial snapshot with dates
 * on what it does have beats an error.
 */
export async function macroSnapshot(): Promise<MacroSnapshot> {
  const [aaa, tenYear] = [await latest('aaa'), await latest('tenYear')];

  let cpi: Observation | undefined;
  let cpiYearOverYear: Observation | undefined;
  try {
    // Thirteen months so the same month a year earlier is in the window.
    const rows = await observations('cpi', 14);
    cpi = rows[0];
    const yearAgo = rows.find(row => {
      const current = cpi?.asOf.slice(0, 4);
      return (
        current !== undefined &&
        row.asOf.slice(5, 7) === cpi?.asOf.slice(5, 7) &&
        row.asOf.slice(0, 4) === String(Number(current) - 1)
      );
    });
    const change = div(
      dec(cpi?.value)?.minus(dec(yearAgo?.value) ?? 0),
      dec(yearAgo?.value)
    );
    if (cpi && change) {
      cpiYearOverYear = { asOf: cpi.asOf, value: change.toNumber() };
    }
  } catch {
    // Same reasoning as `latest`.
  }

  const aaaFraction = asFraction(dec(aaa?.value));
  const grahamMaxPe = div(dec(1), aaaFraction?.times(2));

  return {
    aaaYield: aaa && { asOf: aaa.asOf, value: aaaFraction?.toNumber() ?? 0 },
    cpi,
    cpiYearOverYear,
    grahamMaxPe: grahamMaxPe?.toDecimalPlaces(2).toNumber(),
    tenYearYield: tenYear && {
      asOf: tenYear.asOf,
      value: asFraction(dec(tenYear.value))?.toNumber() ?? 0
    }
  };
}
