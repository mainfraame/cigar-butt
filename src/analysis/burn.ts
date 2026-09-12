import { sortBy } from 'lodash-es';

import { companyConcept, type CompanyFact } from '../data/sec.ts';
import { dec, div, gtZero, type Decimal } from '../math/decimal.ts';

/**
 * Whether the assets are still there next year.
 *
 * Graham's asset test assumes the assets survive the wait. It says nothing
 * about a company consuming them, and the screen ranked by NCAV over tangible
 * book actively selects for companies whose balance sheet is nothing but
 * cash — which is what a pre-revenue business looks like on its way to
 * spending it.
 *
 * Two names from the same screen make the point. Tenax passed every asset
 * test at 0.52x net current assets while burning $47M a year against $118M of
 * cash: the discount is the market pricing the burn. Amarin sat at 0.66x
 * tangible book generating **positive** operating cash flow: the discount is
 * a shrinking revenue line, and the assets are being added to rather than
 * consumed. The asset tests cannot tell those two apart. This can.
 */

/** Annual figures only. A quarter compared against a year is not a trend. */
const ANNUAL_FORMS = new Set(['10-K', '20-F', '40-F']);

const CASH_FLOW = 'NetCashProvidedByUsedInOperatingActivities';

const REVENUE_CONCEPTS = [
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'Revenues',
  'RevenueFromContractWithCustomerIncludingAssessedTax'
];

export interface Period {
  readonly asOf: string;
  /** ISO start of the period, so a quarter is never read as a year. */
  readonly from: string | undefined;
  readonly months: number | undefined;
  readonly value: Decimal;
}

export interface BurnProfile {
  /** Latest annual operating cash flow, and the one before it. */
  readonly annualCashFlow: readonly Period[];
  /**
   * Cash as a share of current assets.
   *
   * Decides whether a runway figure means anything. A clinical-stage company
   * is a cash box: its current assets *are* the cash, and dividing by the
   * burn gives the date it runs out. A food manufacturer holds its liquidity
   * as inventory and receivables that convert every cycle, so the same
   * arithmetic reported Bridgford — $231M of revenue, a hundred years old —
   * as having six weeks to live.
   */
  readonly cashShare: Decimal | undefined;
  /** Most recent interim cash flow, annualised, when one is available. */
  readonly currentBurn: Decimal | undefined;
  readonly revenue: readonly Period[];
  /**
   * Years of cash at the current burn. Undefined when the company funds
   * itself — that is not an infinite runway, it is a different situation, and
   * printing a number for it invites the wrong comparison.
   */
  readonly runwayYears: Decimal | undefined;
  /**
   * `true` when operations generate cash, `false` when they consume it,
   * `undefined` when no cash-flow statement could be read. Never defaulted:
   * an unknown burn is exactly the case where a runway figure would mislead.
   */
  readonly selfFunding: boolean | undefined;
}

/** Months a fact covers, from its own start and end. */
function months(fact: CompanyFact): number | undefined {
  if (!fact.start) return undefined;
  const start = Date.parse(fact.start);
  const end = Date.parse(fact.end);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return Math.round((end - start) / (30.44 * 86_400_000));
}

const toPeriod = (fact: CompanyFact): Period | undefined => {
  const value = dec(fact.val);
  return value === undefined
    ? undefined
    : { asOf: fact.end, from: fact.start, months: months(fact), value };
};

/**
 * Reads the cash-flow and revenue history.
 *
 * The burn is taken from the most recent *interim* period and annualised,
 * because a company that has just failed a trial or lost exclusivity is not
 * burning at last year's rate — and last year's 10-K is what a screener would
 * quote.
 */
export async function burnProfile(
  cik: string,
  cash: Decimal | undefined,
  currentAssets?: Decimal
): Promise<BurnProfile> {
  const flows = await companyConcept(cik, CASH_FLOW);

  let revenueFacts: CompanyFact[] = [];
  for (const concept of REVENUE_CONCEPTS) {
    if (revenueFacts.length > 0) break;
    revenueFacts = await companyConcept(cik, concept);
  }

  const annual = sortBy(
    flows.filter(
      fact => ANNUAL_FORMS.has(fact.form) && months(fact) !== undefined
    ),
    fact => fact.end
  )
    .map(toPeriod)
    .filter((period): period is Period => period !== undefined)
    .filter(period => (period.months ?? 0) >= 11)
    .slice(-2)
    .toReversed();

  // The newest period of any length, which on a quarterly filer is the
  // year-to-date figure inside the latest 10-Q.
  const latest = sortBy(
    flows.map(toPeriod).filter((p): p is Period => p !== undefined),
    period => [period.asOf, period.months ?? 0]
  ).at(-1);

  const annualised =
    latest && gtZero(dec(latest.months ?? 0))
      ? latest.value.times(12).div(latest.months!)
      : annual[0]?.value;

  const selfFunding =
    annualised === undefined ? undefined : !annualised.isNegative();

  const cashShare = gtZero(currentAssets)
    ? div(cash, currentAssets)
    : undefined;

  // Only a cash box has a runway. Below this the company funds itself out of
  // a working-capital cycle, and cash over burn is not a countdown — it is
  // two numbers that happen to divide.
  const isCashBox = cashShare !== undefined && cashShare.gte('0.5');

  return {
    annualCashFlow: annual,
    cashShare,
    currentBurn: annualised,
    revenue: sortBy(
      revenueFacts.filter(
        fact => ANNUAL_FORMS.has(fact.form) && (months(fact) ?? 0) >= 11
      ),
      fact => fact.end
    )
      .map(toPeriod)
      .filter((period): period is Period => period !== undefined)
      .slice(-2)
      .toReversed(),
    runwayYears:
      isCashBox &&
      annualised !== undefined &&
      annualised.isNegative() &&
      gtZero(cash)
        ? div(cash, annualised.abs())
        : undefined,
    selfFunding
  };
}
