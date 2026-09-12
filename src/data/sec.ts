import { cached, TTL } from '../cache/store.ts';
import { providerById } from '../config/providers.ts';
import { requireCredential } from '../config/store.ts';
import { fetchJson } from '../http/client.ts';

/**
 * SEC EDGAR. This is the authoritative source for everything on the balance
 * sheet: exact line items, each carrying the filing it came from and the date
 * it was filed. Vendor-normalised figures are a cross-check, never the input.
 *
 * EDGAR requires a descriptive User-Agent with a real contact email and asks
 * for no more than 10 requests/second.
 */

const SEC_RATE = { rateKey: 'data.sec.gov', requestsPerSecond: 8 } as const;

/**
 * The share count on a filing's cover page.
 *
 * Every 10-K and 10-Q carries this in the `dei` taxonomy, and it is the one
 * place a share count is reliably tagged: Haverty, among others, stopped
 * tagging `us-gaap:CommonStockSharesOutstanding` years ago while still filing
 * quarterly, which left P/TBV — the primary Schloss test — reading `n/a` on a
 * company whose share count was in plain sight.
 */
export const COVER_SHARES = 'EntityCommonStockSharesOutstanding';

/** us-gaap concepts this server reads. */
export const CONCEPTS = {
  assetsCurrent: 'AssetsCurrent',
  cash: 'CashAndCashEquivalentsAtCarryingValue',
  goodwill: 'Goodwill',
  intangibles: 'IntangibleAssetsNetExcludingGoodwill',
  inventory: 'InventoryNet',
  liabilities: 'Liabilities',
  liabilitiesCurrent: 'LiabilitiesCurrent',
  longTermDebt: 'LongTermDebtNoncurrent',
  preferredStock: 'PreferredStockValue',
  receivables: 'AccountsReceivableNetCurrent',
  sharesOutstanding: 'CommonStockSharesOutstanding',
  shortTermInvestments: 'ShortTermInvestments',
  stockholdersEquity: 'StockholdersEquity'
} as const;

/**
 * Concepts filers tag under more than one name, tried in order.
 *
 * Money parked in Treasuries is the case that matters. A company holding
 * $167M of liquidity may report only a fraction of it as
 * `CashAndCashEquivalents` and the rest as short-term investments, under any
 * of several tags. Reading the first tag alone understates net cash — which
 * is one of the five checks — and made Medifast look like it held $72M when
 * its own activist put the figure at $167M.
 */
export const CONCEPT_ALTERNATES: Readonly<Record<string, readonly string[]>> = {
  shortTermInvestments: [
    'ShortTermInvestments',
    'MarketableSecuritiesCurrent',
    'AvailableForSaleSecuritiesDebtSecuritiesCurrent',
    'OtherShortTermInvestments'
  ]
};

export interface CompanyFact {
  /** Accession number of the filing this figure came from. */
  readonly accn: string;
  /** Period end date, ISO. */
  readonly end: string;
  readonly filed: string;
  readonly form: string;
  readonly fp?: string;
  readonly fy?: number;
  readonly start?: string;
  readonly val: number;
}

export interface FilingEvent {
  readonly accessionNumber: string;
  readonly filingDate: string;
  readonly form: string;
  /** 8-K item codes, split from the comma-separated `items` field. */
  readonly items: readonly string[];
  readonly primaryDocDescription?: string;
  /** File name of the filing's main document, for fetching its text. */
  readonly primaryDocument?: string;
  readonly reportDate?: string;
}

export interface SubmissionsSummary {
  readonly cik: string;
  readonly events: readonly FilingEvent[];
  readonly exchanges: readonly string[];
  readonly name: string;
  readonly sic?: string;
  readonly sicDescription?: string;
  readonly tickers: readonly string[];
}

interface CompanyConceptResponse {
  readonly cik: number;
  readonly entityName: string;
  /**
   * Keyed by unit, and the value is only usually an array of facts. Typed
   * `unknown` deliberately: asserting the shape is what let one filer's odd
   * payload crash an analysis.
   */
  readonly units: Record<string, unknown>;
}

interface SubmissionsResponse {
  readonly cik: string;
  readonly exchanges?: string[];
  readonly filings?: {
    recent?: {
      accessionNumber?: string[];
      filingDate?: string[];
      form?: string[];
      items?: string[];
      primaryDocDescription?: string[];
      primaryDocument?: string[];
      reportDate?: string[];
    };
  };
  readonly name: string;
  readonly sic?: string;
  readonly sicDescription?: string;
  readonly tickers?: string[];
}

interface TickerEntry {
  readonly cik_str: number;
  readonly ticker: string;
  readonly title: string;
}

function headers(): Record<string, string> {
  const spec = providerById('sec');
  /* c8 ignore next -- the registry always contains 'sec'; this is a type guard. */
  if (!spec) throw new Error('SEC provider spec missing from the registry.');
  return {
    'accept-encoding': 'gzip, deflate',
    'user-agent': requireCredential(spec)
  };
}

/** Zero-pads a CIK to the 10 digits every data.sec.gov path expects. */
function padCik(cik: number | string): string {
  return String(cik).replace(/\D/g, '').padStart(10, '0');
}

let tickerMap: Map<string, TickerEntry> | undefined;

/** Ticker → CIK. One ~1MB fetch, cached for the life of the process. */
/**
 * Every filer that has a ticker, keyed by CIK.
 *
 * The screen works in CIKs because XBRL frames do, and a price works in
 * tickers. Without this join a market-wide screen can report a company's
 * balance sheet and never what it costs.
 */
export async function tickersByCik(): Promise<Map<number, TickerEntry>> {
  await resolveTickerIndex();
  const byCik = new Map<number, TickerEntry>();
  for (const entry of tickerMap?.values() ?? []) {
    // The index lists several tickers for a dual-class filer. First wins,
    // which is the ordinary share often enough, and the screen says the
    // figure is a vendor join rather than a filing.
    if (!byCik.has(entry.cik_str)) byCik.set(entry.cik_str, entry);
  }
  return byCik;
}

async function resolveTickerIndex(): Promise<void> {
  if (tickerMap) return;
  const data = await cached('sec-tickers', 'all', TTL.tickerIndex, () =>
    fetchJson<Record<string, TickerEntry>>(
      'https://www.sec.gov/files/company_tickers.json',
      { ...SEC_RATE, headers: headers() }
    )
  );
  tickerMap = new Map(
    Object.values(data).map(entry => [entry.ticker.toUpperCase(), entry])
  );
}

export async function resolveTicker(ticker: string): Promise<TickerEntry> {
  await resolveTickerIndex();

  const entry = tickerMap?.get(ticker.trim().toUpperCase());
  if (!entry) {
    throw new Error(
      `${ticker} is not in SEC's ticker index. It may be a non-US listing, a ` +
        'ticker that has changed, or a company that has stopped filing — all ' +
        'three are findings, not errors.'
    );
  }
  return entry;
}

/**
 * One concept, full history, small payload. Preferred over `companyfacts`,
 * which returns every concept the filer has ever tagged.
 *
 * Returns an empty array rather than throwing on 404: a company that never
 * tagged `Goodwill` is a company with no goodwill, which is a valid reading.
 */
/**
 * The fact array out of an EDGAR `units` map.
 *
 * Prefers the units this server understands and otherwise takes the first
 * array it finds, because a concept reported in an unexpected unit is still
 * the concept. Anything that is not an array is skipped rather than assumed.
 */
function pickFacts(units: Record<string, unknown> | undefined): CompanyFact[] {
  if (!units) return [];

  for (const key of ['USD', 'shares', 'USD/shares', 'pure']) {
    const value = units[key];
    if (Array.isArray(value)) return value as CompanyFact[];
  }

  for (const value of Object.values(units)) {
    if (Array.isArray(value)) return value as CompanyFact[];
  }

  return [];
}

export async function companyConcept(
  cik: string,
  concept: string,
  taxonomy: 'dei' | 'us-gaap' = 'us-gaap'
): Promise<CompanyFact[]> {
  try {
    const data = await cached(
      'sec-concept',
      `${padCik(cik)}/${taxonomy}/${concept}`,
      TTL.fundamentals,
      () =>
        fetchJson<CompanyConceptResponse>(
          `https://data.sec.gov/api/xbrl/companyconcept/CIK${padCik(cik)}/${taxonomy}/${concept}.json`,
          { ...SEC_RATE, headers: headers() }
        )
    );
    // EDGAR keys facts by unit, and the key is not always one of the two we
    // expect: a filer may report in `USD/shares`, `pure`, or a unit this
    // server has never seen. Taking `units.USD` on faith crashed the whole
    // analysis of Tiptree on a single concept — one odd payload must not
    // take down a company.
    const facts = pickFacts(data.units);
    return facts.toSorted((a, b) => a.end.localeCompare(b.end));
  } catch (error) {
    if (error instanceof Error && error.message.includes('HTTP 404')) return [];
    throw error;
  }
}

/**
 * The most recently *filed* fact for a concept, preferring periodic reports.
 *
 * Sorting by `filed` rather than `end` matters: a restated prior period can be
 * filed after a later one, and the restatement is the number that is currently
 * true.
 */
export function latestFact(
  facts: readonly CompanyFact[]
): CompanyFact | undefined {
  const periodic = facts.filter(f => /^10-[KQ]/.test(f.form));
  const pool = periodic.length > 0 ? periodic : facts;
  return pool.reduce<CompanyFact | undefined>((best, fact) => {
    if (!best) return fact;
    if (fact.end !== best.end) return fact.end > best.end ? fact : best;
    return fact.filed > best.filed ? fact : best;
  }, undefined);
}

/**
 * The filing index as structured events. `filings.recent` is a set of parallel
 * arrays; zipping them turns the disqualifier checks from reading news into a
 * lookup.
 */
export async function submissions(cik: string): Promise<SubmissionsSummary> {
  const data = await cached(
    'sec-submissions',
    padCik(cik),
    TTL.submissions,
    () =>
      fetchJson<SubmissionsResponse>(
        `https://data.sec.gov/submissions/CIK${padCik(cik)}.json`,
        { ...SEC_RATE, headers: headers() }
      )
  );

  const recent = data.filings?.recent ?? {};
  const forms = recent.form ?? [];
  const events: FilingEvent[] = forms.map((form, index) => ({
    accessionNumber: recent.accessionNumber?.[index] ?? '',
    filingDate: recent.filingDate?.[index] ?? '',
    form,
    items: (recent.items?.[index] ?? '')
      .split(',')
      .map(item => item.trim())
      .filter(item => item.length > 0),
    primaryDocDescription: recent.primaryDocDescription?.[index],
    primaryDocument: recent.primaryDocument?.[index],
    reportDate: recent.reportDate?.[index]
  }));

  return {
    cik: padCik(data.cik),
    events,
    exchanges: data.exchanges ?? [],
    name: data.name,
    sic: data.sic,
    sicDescription: data.sicDescription,
    tickers: data.tickers ?? []
  };
}

export interface FrameEntry {
  readonly cik: number;
  readonly end: string;
  readonly entityName: string;
  readonly val: number;
}

/**
 * One concept across every filer that reported it in a period. This is the
 * screen: pull the balance-sheet concepts for the same quarter, join on CIK,
 * and you have tangible book and NCAV for the whole market from primary filing
 * data — no commercial screener, no cache variance.
 *
 * Payloads run to several thousand entities, so callers should join and filter
 * rather than surfacing raw frames.
 *
 * @param period e.g. `CY2026Q1I` — the trailing `I` marks an instantaneous
 *   (point-in-time) frame, which is what balance-sheet concepts use.
 */
export async function frame(
  concept: string,
  period: string,
  unit = 'USD'
): Promise<FrameEntry[]> {
  const data = await cached(
    'sec-frames',
    `${concept}/${unit}/${period}`,
    TTL.frames,
    () =>
      fetchJson<{ data?: FrameEntry[] }>(
        `https://data.sec.gov/api/xbrl/frames/us-gaap/${concept}/${unit}/${period}.json`,
        { ...SEC_RATE, headers: headers() }
      )
  );
  return data.data ?? [];
}
