import type { BalanceSheet } from '../analysis/metrics.ts';

/**
 * The jurisdiction-neutral filings contract.
 *
 * Three registries answer the same two questions in different languages: is
 * this company still alive and filing, and what does its balance sheet say.
 * SEC EDGAR answers both for the US, EDINET both for Japan, and Companies House
 * only the first for the UK. Without a shared shape every tool has to branch on
 * jurisdiction, and adding a fourth registry means editing every tool.
 *
 * Two things are deliberately *not* abstracted:
 *
 * - **Capability is optional methods, not boolean flags.** Companies House
 *   genuinely cannot produce a balance sheet — UK accounts are filed as iXBRL
 *   or PDF documents — so `balanceSheet` is absent rather than present and
 *   returning nothing. An absent method is a claim the type system enforces;
 *   a flag is one a caller can forget to read.
 * - **Search shapes differ irreducibly.** EDINET has no search-by-company
 *   endpoint at all: it is indexed by date, so finding a filer means walking
 *   days. That cost is real and the contract surfaces it rather than hiding it
 *   behind an interface that implies a cheap lookup.
 */

/** How badly a finding bears on the thesis. Shared across every registry. */
export type FilingSeverity = 'disqualify' | 'investigate' | 'note';

/**
 * One adverse finding from a registry.
 *
 * Unified across jurisdictions because the *judgement* is the same everywhere,
 * even though the evidence is not: a US Form 25 and a UK strike-off proposal
 * both mean the company is leaving the register, and a caller should not need
 * to know which country produced the flag to know it is fatal.
 */
export interface FilingFlag {
  /** ISO date of the event, or undefined when the registry states a status without one. */
  readonly date: string | undefined;
  /** What the finding means and why it matters. */
  readonly detail: string;
  /** Short label, e.g. "8-K item 4.02" or "Status: liquidation". */
  readonly label: string;
  readonly severity: FilingSeverity;
  /** Accession number, document id, or whatever makes the finding checkable. */
  readonly source: string | undefined;
}

export interface CompanyRef {
  /** The registry's own identifier — a CIK, an EDINET code, a company number. */
  readonly id: string;
  readonly jurisdiction: Jurisdiction;
  readonly name: string;
  /** Industry classification as the registry states it, if any. */
  readonly sic: string | undefined;
  readonly ticker: string | undefined;
}

export interface DisqualifierReport {
  /** True when nothing at `disqualify` severity was found. */
  readonly clear: boolean;
  readonly company: CompanyRef;
  readonly flags: readonly FilingFlag[];
  /** One line a caller can surface without reading the table. */
  readonly summary: string;
}

export type Jurisdiction = 'JP' | 'UK' | 'US';

export interface FilingsAdapter {
  /**
   * Balance-sheet line items, absent when the registry cannot produce them.
   * `periodEnd` is the instant every item belongs to; anything that does not
   * reach it is reported in `stale` rather than silently mixed in.
   */
  readonly balanceSheet?: (id: string) => Promise<{
    periodEnd: string | undefined;
    sheet: BalanceSheet;
    stale: readonly { asOf: string; key: string }[];
  }>;
  /** Registry findings that bear on whether the filings can be trusted. */
  readonly disqualifiers: (id: string) => Promise<DisqualifierReport>;
  /** Whether the credentials this registry needs are present. */
  readonly isConfigured: () => boolean;
  readonly jurisdiction: Jurisdiction;
  readonly label: string;
  /** Resolves a ticker, name or registry id to a company. */
  readonly resolve: (query: string) => Promise<CompanyRef>;
}

/** Orders findings so the fatal ones are impossible to miss. */
export function bySeverity(flags: readonly FilingFlag[]): FilingFlag[] {
  const rank: Record<FilingSeverity, number> = {
    disqualify: 0,
    investigate: 1,
    note: 2
  };
  return flags.toSorted(
    (left, right) => rank[left.severity] - rank[right.severity]
  );
}

/**
 * The one-line verdict.
 *
 * Shared so every jurisdiction phrases a disqualification the same way — a
 * caller reading "DISQUALIFIED" should not have to wonder whether a different
 * registry would have said something softer for the same severity.
 */
export function summarise(flags: readonly FilingFlag[]): string {
  const fatal = flags.filter(flag => flag.severity === 'disqualify');
  if (fatal.length > 0) {
    return (
      `DISQUALIFIED: ${fatal.map(flag => flag.label).join('; ')}. Stop here — ` +
      'do not compute valuations for this name.'
    );
  }
  return flags.length > 0
    ? `No hard disqualifier. ${flags.length} item(s) to read before trusting the filings.`
    : 'Registry is clean over the window checked.';
}
