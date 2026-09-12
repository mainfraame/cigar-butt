import { companiesHouseAdapter } from './companies-house-adapter.ts';
import { edinetAdapter } from './edinet-adapter.ts';
import { secAdapter } from './sec-adapter.ts';

import type { FilingsAdapter, Jurisdiction } from './contract.ts';

/**
 * Every filings registry, keyed by jurisdiction.
 *
 * Adding one is: write an adapter against `FilingsAdapter`, add a line here,
 * register its credentials. No tool changes.
 */
const ADAPTERS: Readonly<Record<Jurisdiction, FilingsAdapter>> = {
  JP: edinetAdapter,
  UK: companiesHouseAdapter,
  US: secAdapter
};

export function filingsAdapter(jurisdiction: Jurisdiction): FilingsAdapter {
  return ADAPTERS[jurisdiction];
}

/**
 * Guesses the jurisdiction from the shape of an identifier.
 *
 * Deliberately conservative, and US is the fallback rather than the answer: a
 * bare four-digit number is a Tokyo ticker far more often than anything else,
 * and a two-letter-prefixed eight-digit code is a UK company number. Anything
 * ambiguous goes to the US because that is where this server's coverage is
 * deepest — but a caller who knows should pass the jurisdiction rather than
 * rely on this.
 */
export function guessJurisdiction(query: string): Jurisdiction {
  const trimmed = query.trim().toUpperCase();
  if (/^(NI|OC|SC|SO)?\d{6,8}$/.test(trimmed) && trimmed.length >= 6)
    return 'UK';
  if (/^\d{4,5}(\.T)?$/.test(trimmed)) return 'JP';
  return 'US';
}

/** Which registries are usable right now, for reporting rather than dispatch. */
export function configuredJurisdictions(): {
  configured: boolean;
  jurisdiction: Jurisdiction;
  label: string;
}[] {
  return (Object.keys(ADAPTERS) as Jurisdiction[]).map(jurisdiction => ({
    configured: ADAPTERS[jurisdiction].isConfigured(),
    jurisdiction,
    label: ADAPTERS[jurisdiction].label
  }));
}
