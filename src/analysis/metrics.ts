import { maxBy, sortBy } from 'lodash-es';

import {
  companyConcept,
  CONCEPT_ALTERNATES,
  CONCEPTS,
  COVER_SHARES,
  type CompanyFact,
  latestFact
} from '../data/sec.ts';
import { type Decimal, dec, div, gtZero, ZERO } from '../math/decimal.ts';

/**
 * The asset tests, computed from filing line items rather than from a
 * screener's derived figures. Screeners report plain P/B, which flatters
 * goodwill-heavy companies, and their "net cash" numbers have been wrong in
 * testing.
 */

/** A figure plus the filing it came from. Nothing here is ever undated. */
export interface DatedValue {
  readonly accn: string;
  /** Period end. */
  readonly asOf: string;
  readonly filed: string;
  readonly form: string;
  /**
   * True when this line item's period end does not match the rest of the
   * sheet, because the filer stopped tagging the concept. Stale items are
   * excluded from the arithmetic — see `fetchBalanceSheet`.
   */
  readonly stale?: boolean;
  readonly value: Decimal;
}

export interface BalanceSheet {
  readonly assetsCurrent?: DatedValue;
  readonly cash?: DatedValue;
  readonly goodwill?: DatedValue;
  readonly intangibles?: DatedValue;
  readonly inventory?: DatedValue;
  readonly liabilities?: DatedValue;
  readonly liabilitiesCurrent?: DatedValue;
  readonly longTermDebt?: DatedValue;
  readonly preferredStock?: DatedValue;
  readonly receivables?: DatedValue;
  readonly sharesOutstanding?: DatedValue;
  /** Treasuries and the like. Liquidity the cash line does not carry. */
  readonly shortTermInvestments?: DatedValue;
  readonly stockholdersEquity?: DatedValue;
}

export interface ValueMetrics {
  /** Period end of the oldest line item used, so staleness is visible. */
  readonly asOf: string;
  readonly currentRatio?: Decimal;
  readonly debtToEquity?: Decimal;
  /** Line items the filer never tagged. Each one weakens a test below. */
  readonly missing: readonly string[];
  /** Current assets − total liabilities − preferred. Graham's net-net base. */
  readonly ncav?: Decimal;
  readonly ncavPerShare?: Decimal;
  /** Cash − long-term debt. Meaningless for banks; see `isFinancial`. */
  readonly netCash?: Decimal;
  /** Cash + 75% receivables + 50% inventory − total liabilities. */
  readonly nnwc?: Decimal;
  readonly nnwcPerShare?: Decimal;
  readonly tangibleBook?: Decimal;
  readonly tangibleBookPerShare?: Decimal;
}

interface ScreenCheck {
  readonly detail: string;
  readonly name: string;
  /** `undefined` means "could not be computed" — not "failed". */
  readonly pass: boolean | undefined;
}

export interface ScreenVerdict {
  readonly checks: readonly ScreenCheck[];
  readonly passesGraham: boolean;
  readonly passesSchloss: boolean;
  readonly priceToNcav?: Decimal;
  readonly priceToTangibleBook?: Decimal;
}

const RECEIVABLE_HAIRCUT = '0.75';
const INVENTORY_HAIRCUT = '0.5';
const NET_NET_DISCOUNT = 2 / 3;

function toDated(fact: CompanyFact | undefined): DatedValue | undefined {
  const value = fact ? dec(fact.val) : undefined;
  if (!fact || !value) return undefined;
  return {
    accn: fact.accn,
    asOf: fact.end,
    filed: fact.filed,
    form: fact.form,
    value
  };
}

/**
 * Concepts that anchor the reporting period. A balance sheet is a snapshot, so
 * every line item must come from the same instant; these three are the ones a
 * filer effectively always tags, which makes them the reliable way to find out
 * which instant that is.
 */
const ANCHOR_CONCEPTS = [
  'assetsCurrent',
  'liabilities',
  'stockholdersEquity'
] as const;

export interface BalanceSheetResult {
  readonly periodEnd?: string;
  readonly sheet: BalanceSheet;
  /** Line items whose period end predates the sheet; excluded from the maths. */
  readonly stale: readonly { asOf: string; key: string }[];
}

/**
 * Pulls every concept the asset tests need. One request per concept.
 *
 * Filers change which concepts they tag. Astec, for instance, stopped tagging
 * `AccountsReceivableNetCurrent` in 2019 while still filing quarterly, so
 * taking "the latest fact for each concept independently" silently builds NNWC
 * from a seven-year-old receivable. Every item is therefore pinned to the
 * sheet's own period end, and anything that does not reach it is reported as
 * stale rather than quietly averaged into a ratio.
 */
export async function fetchBalanceSheet(
  cik: string
): Promise<BalanceSheetResult> {
  const entries = Object.entries(CONCEPTS) as [keyof typeof CONCEPTS, string][];

  const facts: Partial<Record<keyof typeof CONCEPTS, CompanyFact[]>> = {};
  for (const [key, concept] of entries) {
    const alternates = CONCEPT_ALTERNATES[key] ?? [concept];
    // First tag that returns anything wins. Filers differ and a concept that
    // is absent under one name is routinely present under another.
    let found: CompanyFact[] = [];
    for (const candidate of alternates) {
      if (found.length > 0) break;
      found = await companyConcept(cik, candidate);
    }
    facts[key] = found;
  }

  const periodEnd = ANCHOR_CONCEPTS.map(
    key => latestFact(facts[key] ?? [])?.end
  )
    .filter((end): end is string => end !== undefined)
    .toSorted()
    .at(-1);

  const sheet: Record<string, DatedValue | undefined> = {};
  const stale: { asOf: string; key: string }[] = [];

  for (const [key] of entries) {
    const all = facts[key] ?? [];
    const onPeriod = periodEnd
      ? latestFact(all.filter(fact => fact.end === periodEnd))
      : undefined;

    if (onPeriod) {
      sheet[key] = toDated(onPeriod);
      continue;
    }

    // Kept on the sheet, flagged, and skipped by computeMetrics: a reader
    // needs to see that the filer stopped tagging it, not just that it vanished.
    const fallback = toDated(latestFact(all));
    if (fallback) {
      sheet[key] = { ...fallback, stale: true };
      stale.push({ asOf: fallback.asOf, key });
    }
  }

  // A filer that stopped tagging the us-gaap share count still puts one on
  // every cover page. Only the cover of *this* filing will do: matching on the
  // accession means the count is the filer's own statement alongside these
  // exact figures, rather than a number from a neighbouring quarter. Its date
  // is the cover date, which is days after the period end and is reported as
  // its own — a share count is a divisor, not a line item to be summed, and
  // the current count is the right divisor for a per-share figure.
  if (!sheet['sharesOutstanding'] || sheet['sharesOutstanding'].stale) {
    const anchor = ANCHOR_CONCEPTS.map(key => sheet[key]).find(
      item => item !== undefined && !item.stale
    );
    if (anchor) {
      const cover = latestFact(
        (await companyConcept(cik, COVER_SHARES, 'dei')).filter(
          fact => fact.accn === anchor.accn
        )
      );
      if (cover) {
        sheet['sharesOutstanding'] = toDated(cover);
        // It is no longer missing, so drop any staleness already recorded.
        const index = stale.findIndex(
          entry => entry.key === 'sharesOutstanding'
        );
        if (index >= 0) stale.splice(index, 1);
      }
    }
  }

  return { periodEnd, sheet: sheet as BalanceSheet, stale };
}

/** Stale items are treated as absent: a figure from another quarter is not this quarter's. */
const val = (item: DatedValue | undefined): Decimal | undefined =>
  item && !item.stale ? item.value : undefined;
const orZero = (item: DatedValue | undefined): Decimal => val(item) ?? ZERO;

/**
 * Derives the asset tests. Every output is optional: a filer that never tagged
 * `Liabilities` gets no NCAV, and saying so beats inventing one.
 */
export function computeMetrics(sheet: BalanceSheet): ValueMetrics {
  const equity = val(sheet.stockholdersEquity);
  const currentAssets = val(sheet.assetsCurrent);
  const currentLiabilities = val(sheet.liabilitiesCurrent);
  const totalLiabilities = val(sheet.liabilities);
  // Liquidity, not the cash line. A company parking money in Treasuries
  // reports part of it under short-term investments, and reading only
  // `CashAndCashEquivalents` understates net cash — one of the five checks.
  // Undefined plus a number is the number: a filer that tags neither has no
  // liquidity figure, and one that tags only one has that one.
  const cash =
    val(sheet.cash) === undefined &&
    val(sheet.shortTermInvestments) === undefined
      ? undefined
      : (val(sheet.cash) ?? ZERO).plus(val(sheet.shortTermInvestments) ?? ZERO);
  const shares = val(sheet.sharesOutstanding);

  const goodwill = orZero(sheet.goodwill);
  const intangibles = orZero(sheet.intangibles);
  const preferred = orZero(sheet.preferredStock);
  const receivables = orZero(sheet.receivables);
  const inventory = orZero(sheet.inventory);
  const longTermDebt = orZero(sheet.longTermDebt);

  // Driven off the concept list rather than the object's own keys: a sheet
  // built by hand (or by a future caller) may omit a key entirely, and that is
  // the same fact as tagging it stale.
  const missing = (Object.keys(CONCEPTS) as (keyof typeof CONCEPTS)[]).filter(
    key => {
      const item = sheet[key];
      return item === undefined || item.stale === true;
    }
  );

  const tangibleBook = equity?.minus(goodwill).minus(intangibles);

  const ncav =
    currentAssets && totalLiabilities
      ? currentAssets.minus(totalLiabilities).minus(preferred)
      : undefined;

  const nnwc =
    cash && totalLiabilities
      ? cash
          .plus(receivables.times(RECEIVABLE_HAIRCUT))
          .plus(inventory.times(INVENTORY_HAIRCUT))
          .minus(totalLiabilities)
      : undefined;

  const perShare = (n: Decimal | undefined): Decimal | undefined =>
    gtZero(shares) ? div(n, shares) : undefined;

  const dates = sortBy(
    Object.values(sheet)
      .filter((item): item is DatedValue => item !== undefined && !item.stale)
      .map(item => item.asOf)
  );

  return {
    // The oldest line item, not the newest: a metric is only as current as its
    // stalest input, and reporting the newest date would overstate freshness.
    asOf: dates[0] ?? 'unknown',
    currentRatio: gtZero(currentLiabilities)
      ? div(currentAssets, currentLiabilities)
      : undefined,
    debtToEquity: gtZero(equity) ? div(longTermDebt, equity) : undefined,
    missing,
    ncav,
    ncavPerShare: perShare(ncav),
    netCash: cash?.minus(longTermDebt),
    nnwc,
    nnwcPerShare: perShare(nnwc),
    tangibleBook,
    tangibleBookPerShare: perShare(tangibleBook)
  };
}

/** SIC codes 6000–6799 are finance, insurance and real estate. */
export function isFinancial(sic: string | undefined): boolean {
  const code = dec(sic);
  return code !== undefined && code.gte(6000) && code.lte(6799);
}

/**
 * Scores a name against Schloss's filters and Graham's stricter net-net test.
 *
 * `undefined` on a check means "could not be computed", which is deliberately
 * distinct from `false`. A missing line item is a gap in the evidence, not a
 * failed test, and collapsing the two is how a screen ends up confidently wrong.
 */
export function judge(
  metrics: ValueMetrics,
  price: Decimal,
  options: { readonly financial?: boolean } = {}
): ScreenVerdict {
  const priceToTangibleBook = gtZero(metrics.tangibleBookPerShare)
    ? div(price, metrics.tangibleBookPerShare)
    : undefined;

  const priceToNcav = gtZero(metrics.ncavPerShare)
    ? div(price, metrics.ncavPerShare)
    : undefined;

  const checks: ScreenCheck[] = [
    {
      detail: 'Schloss wanted 0.6–0.8; goodwill and intangibles stripped out.',
      name: 'P/TBV < 1.0',
      pass: priceToTangibleBook?.lt(1)
    },
    {
      detail: options.financial
        ? 'Financial issuer: leverage is the business model, so this check is ' +
          'reported but does not veto. Schloss owned banks anyway.'
        : 'Long-term debt against book equity.',
      name: 'Debt/Equity < 0.2',
      pass: metrics.debtToEquity?.lt('0.2')
    },
    {
      detail: "Graham's own solvency threshold.",
      name: 'Current ratio > 2',
      pass: metrics.currentRatio?.gt(2)
    },
    {
      detail: options.financial
        ? 'Not meaningful for a financial: deposits and the securities book are ' +
          'not spare cash. Go to tangible common equity instead.'
        : 'Cash less long-term debt.',
      name: 'Net cash positive',
      pass: options.financial
        ? undefined
        : metrics.netCash === undefined
          ? undefined
          : gtZero(metrics.netCash)
    },
    {
      detail:
        "Graham's net-net: buy below two-thirds of net current asset value.",
      name: 'Price < 2/3 NCAV',
      pass: priceToNcav?.lt(NET_NET_DISCOUNT)
    }
  ];

  const passed = (name: string): boolean =>
    checks.find(check => check.name === name)?.pass === true;

  return {
    checks,
    passesGraham: passed('Price < 2/3 NCAV'),
    passesSchloss:
      passed('P/TBV < 1.0') &&
      passed('Current ratio > 2') &&
      (options.financial === true || passed('Debt/Equity < 0.2')),
    priceToNcav,
    priceToTangibleBook
  };
}

/** The most recent filing date across the sheet, for staleness reporting. */
export function lastFiled(sheet: BalanceSheet): string | undefined {
  const items = Object.values(sheet).filter(
    (item): item is DatedValue => item !== undefined && !item.stale
  );
  return maxBy(items, item => item.filed)?.filed;
}
