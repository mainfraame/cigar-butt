import { groupBy, sortBy } from 'lodash-es';

import type { FilingEvent, SubmissionsSummary } from '../data/sec.ts';

/**
 * The disqualifier scan, run *before* any valuation work.
 *
 * The whole thesis is that the reported balance sheet is true, so anything
 * undermining the filings kills the name outright regardless of how cheap it
 * looks. Running these last wastes the valuation effort on names that were
 * already dead — which is exactly what happened in the testing that produced
 * this list.
 *
 * Every check reads the `submissions` filing index, so the entire scan costs
 * one HTTP request.
 */

type Severity =
  /** Thesis is void. Stop. */
  | 'disqualify'
  /** Read the filing before going further. */
  | 'investigate'
  /** Worth knowing; not adverse on its own. */
  | 'note';

interface Flag {
  readonly date: string;
  readonly form: string;
  readonly reason: string;
  readonly severity: Severity;
  /** EDGAR accession number, so the finding is checkable. */
  readonly source: string;
}

export interface DisqualifierReport {
  /** True when nothing at `disqualify` severity was found. */
  readonly clear: boolean;
  /** Days since the most recent 10-K or 10-Q. */
  readonly daysSinceLastPeriodic?: number;
  readonly flags: readonly Flag[];
  readonly lastPeriodicFiling?: { date: string; form: string };
  /** Order the caller should read this in. */
  readonly summary: string;
}

/** 8-K item codes that carry a signal, and how to treat each. */
const EIGHT_K_ITEMS: Record<string, { reason: string; severity: Severity }> = {
  '1.03': {
    reason: 'Bankruptcy or receivership.',
    severity: 'disqualify'
  },
  '2.06': {
    reason:
      'Material impairment — reduces the book value the whole thesis rests on.',
    severity: 'investigate'
  },
  '3.01': {
    reason:
      'Delisting notice or failure to satisfy a listing rule, including late-filing delinquency.',
    severity: 'investigate'
  },
  '4.01': {
    reason:
      'Change of certifying accountant. An auditor resigning mid-engagement is far worse than a planned rotation — read the filing.',
    severity: 'investigate'
  },
  '4.02': {
    reason:
      'Non-reliance on previously issued financial statements. The company or its auditor has said the numbers cannot be trusted.',
    severity: 'disqualify'
  },
  '5.01': {
    // Raised from a note after Standard BioTools. Every asset test passed —
    // 0.63x net current assets, 9.1x current ratio, no debt — while a signed
    // all-stock merger was contributing those assets to Treeline Biosciences
    // in exchange for 16% of the combined company. An asset thesis assumes
    // the assets stay with the shareholders valuing them, and a change of
    // control is precisely the event that ends that assumption.
    reason:
      'Change in control. Read the agreement before valuing anything: in an ' +
      'all-stock merger the balance sheet you are buying is contributed to ' +
      'another company and you keep a fraction of the result, so a discount ' +
      'to assets stops meaning what it usually means.',
    severity: 'investigate'
  }
};

/** Standalone forms that matter, keyed by exact form type. */
const FORM_FLAGS: Record<string, { reason: string; severity: Severity }> = {
  '15-12B': {
    reason: 'Deregistration. The company has exited SEC reporting entirely.',
    severity: 'disqualify'
  },
  '25': {
    reason:
      'Form 25 — issuer-filed delisting. Effective 10 days after filing, at which point the reporting duty is suspended.',
    severity: 'disqualify'
  },
  '25-NSE': {
    reason:
      'Form 25-NSE — exchange-filed involuntary delisting. The attached determination carries the reason.',
    severity: 'disqualify'
  },
  'NT 10-K': {
    reason: 'Notification of late annual report. Direct delinquency evidence.',
    severity: 'investigate'
  },
  'NT 10-Q': {
    reason:
      'Notification of late quarterly report. Direct delinquency evidence.',
    severity: 'investigate'
  },
  'SC 13D': {
    reason:
      'Activist stake above 5%. On a sub-book name this is often the catalyst that closes the discount.',
    severity: 'note'
  }
};

/** A periodic report older than this is a filing gap worth flagging. */
const STALE_PERIODIC_DAYS = 135;

const DAY_MS = 86_400_000;

function daysBetween(from: string, to: Date): number | undefined {
  const parsed = Date.parse(from);
  if (Number.isNaN(parsed)) return undefined;
  return Math.floor((to.getTime() - parsed) / DAY_MS);
}

function flagsFor(event: FilingEvent): Flag[] {
  const found: Flag[] = [];

  const formFlag = FORM_FLAGS[event.form];
  if (formFlag) {
    found.push({
      date: event.filingDate,
      form: event.form,
      reason: formFlag.reason,
      severity: formFlag.severity,
      source: event.accessionNumber
    });
  }

  if (event.form.startsWith('8-K')) {
    for (const item of event.items) {
      const itemFlag = EIGHT_K_ITEMS[item];
      if (!itemFlag) continue;
      found.push({
        date: event.filingDate,
        form: `8-K item ${item}`,
        reason: itemFlag.reason,
        severity: itemFlag.severity,
        source: event.accessionNumber
      });
    }
  }

  return found;
}

/**
 * Scans the filing index.
 *
 * @param lookbackDays only filings this recent are considered. Restatements
 *   from a decade ago are history; ones from last quarter are the thesis.
 * @param now injected so the staleness arithmetic is testable.
 */
export function scanDisqualifiers(
  summary: SubmissionsSummary,
  {
    lookbackDays = 730,
    now = new Date()
  }: { lookbackDays?: number; now?: Date } = {}
): DisqualifierReport {
  const cutoff = new Date(now.getTime() - lookbackDays * DAY_MS)
    .toISOString()
    .slice(0, 10);

  const recent = summary.events.filter(event => event.filingDate >= cutoff);

  // Each 25-NSE is indexed twice in EDGAR — once under the exchange and once
  // under the issuer — so deduplicate on accession number or delistings
  // double-count.
  const seen = new Set<string>();
  const flags: Flag[] = [];
  for (const event of recent) {
    for (const flag of flagsFor(event)) {
      const key = `${flag.source}|${flag.form}`;
      if (seen.has(key)) continue;
      seen.add(key);
      flags.push(flag);
    }
  }

  const periodic = sortBy(
    summary.events.filter(event => /^10-[KQ]$/.test(event.form)),
    event => event.filingDate
  ).at(-1);

  const daysSinceLastPeriodic = periodic
    ? daysBetween(periodic.filingDate, now)
    : undefined;

  if (!periodic) {
    flags.push({
      date: 'n/a',
      form: '10-K/10-Q',
      reason:
        'No 10-K or 10-Q in the filing index. Either the issuer is a foreign private issuer filing 20-F/40-F, or it has stopped filing — both end this analysis as written.',
      severity: 'investigate',
      source: 'n/a'
    });
  } else if (
    daysSinceLastPeriodic !== undefined &&
    daysSinceLastPeriodic > STALE_PERIODIC_DAYS
  ) {
    flags.push({
      date: periodic.filingDate,
      form: periodic.form,
      reason: `Last periodic report was ${daysSinceLastPeriodic} days ago. A gap where a 10-Q should be is a delinquency, visible directly rather than inferred.`,
      severity: 'investigate',
      source: periodic.accessionNumber
    });
  }

  const ordered = sortBy(flags, [
    flag => ['disqualify', 'investigate', 'note'].indexOf(flag.severity),
    flag => flag.date
  ]);

  const bySeverity = groupBy(ordered, flag => flag.severity);
  const disqualifying = bySeverity['disqualify'] ?? [];

  const summaryText =
    disqualifying.length > 0
      ? `DISQUALIFIED: ${disqualifying.map(f => f.form).join(', ')}. Stop here — do not compute valuations for this name.`
      : ordered.length > 0
        ? `No hard disqualifier. ${ordered.length} item(s) to read before trusting the balance sheet.`
        : 'Filing index is clean over the lookback window.';

  return {
    clear: disqualifying.length === 0,
    daysSinceLastPeriodic,
    flags: ordered,
    lastPeriodicFiling: periodic
      ? { date: periodic.filingDate, form: periodic.form }
      : undefined,
    summary: summaryText
  };
}
