import { keyBy, sortBy } from 'lodash-es';

import { CONCEPTS, frame, type FrameEntry } from '../data/sec.ts';
import { type Decimal, dec, div, gtZero, ZERO } from '../math/decimal.ts';

/**
 * The market-wide screen, built from SEC `frames`.
 *
 * `frames` returns one concept for every filer that reported it in a period.
 * Pull the balance-sheet concepts for the same quarter, join on CIK, and you
 * have tangible book and NCAV for the entire market from primary filing data —
 * no commercial screener, no cache variance, no per-name request loop.
 *
 * What it deliberately does not do is attach a price. Frames give you the
 * balance sheet; a price needs a separate provider, and pairing a stale quote
 * with a filing figure is the exact mistake this codebase exists to avoid. The
 * output is a candidate list to run `analyze_ticker` against, not a verdict.
 */

export interface ScreenRow {
  readonly assetsCurrent?: Decimal;
  readonly cik: number;
  readonly entityName: string;
  readonly goodwill: Decimal;
  readonly intangibles: Decimal;
  readonly liabilities?: Decimal;
  readonly ncav?: Decimal;
  /** NCAV as a fraction of tangible book — how asset-light the balance sheet is. */
  readonly ncavToTangibleBook?: Decimal;
  readonly periodEnd: string;
  readonly stockholdersEquity?: Decimal;
  readonly tangibleBook?: Decimal;
}

export interface ScreenOptions {
  /** Require NCAV to be at least this fraction of tangible book. */
  readonly minNcavRatio?: Decimal;
  /** Drop filers whose tangible book is below this, in dollars. */
  readonly minTangibleBook?: Decimal;
  /** e.g. `CY2026Q1I`. The trailing `I` marks an instantaneous frame. */
  readonly period: string;
}

const CONCEPT_ORDER = [
  CONCEPTS.stockholdersEquity,
  CONCEPTS.assetsCurrent,
  CONCEPTS.liabilities,
  CONCEPTS.goodwill,
  CONCEPTS.intangibles
] as const;

/** Frames are large; index by CIK once rather than scanning per join. */
function index(entries: readonly FrameEntry[]): Map<number, FrameEntry> {
  return new Map(
    Object.entries(keyBy(entries, e => e.cik)).map(([k, v]) => [Number(k), v])
  );
}

/**
 * Runs the screen. Five requests total, regardless of how many filers come
 * back — which is the whole reason to use frames rather than looping tickers.
 *
 * Goodwill and intangibles are treated as zero when a filer never tagged them:
 * a company with no goodwill does not tag `Goodwill`, and refusing to compute
 * tangible book for it would drop exactly the asset-light names the screen
 * wants. Equity, current assets and liabilities are not defaulted — those are
 * load-bearing and their absence is a real gap.
 */
export async function screenMarket(
  options: ScreenOptions
): Promise<{ rows: ScreenRow[]; universeSize: number }> {
  const [equity, currentAssets, liabilities, goodwill, intangibles] =
    await Promise.all(
      CONCEPT_ORDER.map(concept => frame(concept, options.period))
    );

  const byEquity = index(equity ?? []);
  const byCurrentAssets = index(currentAssets ?? []);
  const byLiabilities = index(liabilities ?? []);
  const byGoodwill = index(goodwill ?? []);
  const byIntangibles = index(intangibles ?? []);

  const rows: ScreenRow[] = [];

  for (const [cik, equityEntry] of byEquity) {
    const equityValue = dec(equityEntry.val);
    const goodwillValue = dec(byGoodwill.get(cik)?.val) ?? ZERO;
    const intangiblesValue = dec(byIntangibles.get(cik)?.val) ?? ZERO;
    const currentAssetsValue = dec(byCurrentAssets.get(cik)?.val);
    const liabilitiesValue = dec(byLiabilities.get(cik)?.val);

    const tangibleBook = equityValue
      ?.minus(goodwillValue)
      .minus(intangiblesValue);

    const ncav =
      currentAssetsValue && liabilitiesValue
        ? currentAssetsValue.minus(liabilitiesValue)
        : undefined;

    rows.push({
      assetsCurrent: currentAssetsValue,
      cik,
      entityName: equityEntry.entityName,
      goodwill: goodwillValue,
      intangibles: intangiblesValue,
      liabilities: liabilitiesValue,
      ncav,
      ncavToTangibleBook: gtZero(tangibleBook)
        ? div(ncav, tangibleBook)
        : undefined,
      periodEnd: equityEntry.end,
      stockholdersEquity: equityValue,
      tangibleBook
    });
  }

  const universeSize = rows.length;

  const filtered = rows.filter(row => {
    if (!gtZero(row.tangibleBook)) return false;
    if (
      options.minTangibleBook &&
      row.tangibleBook.lt(options.minTangibleBook)
    ) {
      return false;
    }
    if (options.minNcavRatio) {
      if (!row.ncavToTangibleBook) return false;
      if (row.ncavToTangibleBook.lt(options.minNcavRatio)) return false;
    }
    return true;
  });

  // Ranked by how much of tangible book is net current assets: the higher the
  // ratio, the closer the company is to being worth its liquid balance sheet
  // alone, which is the Graham end of the spectrum.
  return {
    rows: sortBy(filtered, row => -(row.ncavToTangibleBook?.toNumber() ?? 0)),
    universeSize
  };
}
