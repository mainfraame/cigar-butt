import { unzipSync } from 'fflate';
import { sortBy } from 'lodash-es';

import { cached } from '../cache/store.ts';
import { providerById } from '../config/providers.ts';
import { requireCredential } from '../config/store.ts';
import { fetchJson } from '../http/client.ts';
import { type Decimal, dec } from '../math/decimal.ts';

/**
 * EDINET — Japan's mandatory corporate disclosure system, run by the Financial
 * Services Agency. The direct analogue of SEC EDGAR, and the reason this server
 * can look outside the US at all.
 *
 * That matters for this method specifically. Net-nets have been far scarcer in
 * the US than in Japan for a decade: cross-shareholding unwinds and a long
 * history of cash-heavy balance sheets leave more companies trading below net
 * current assets there than anywhere else. A Graham screen that cannot read
 * Japanese filings is looking in the wrong place.
 *
 * Three things make this harder than EDGAR, all of them handled here:
 *
 * 1. There is no search-by-company endpoint. EDINET is indexed **by date** —
 *    you ask what was filed on a day. Finding one company's filings means
 *    walking days, so day lists are cached hard (a past day never changes).
 * 2. Financial data arrives as a **ZIP of UTF-16LE tab-separated CSV**, not
 *    JSON. Read it as UTF-8 and every character is mojibake.
 * 3. Element ids are J-GAAP (`jppfs_cor:`), or IFRS (`ifrs-full:`) for the
 *    minority of filers who have adopted it. Both are mapped below.
 */

const API = 'https://api.edinet-fsa.go.jp/api/v2';
const EDINET_RATE = { rateKey: 'api.edinet-fsa.go.jp', requestsPerSecond: 2 };

/** A past day's filing list is immutable; today's is not. */
const TTL_DAY_LIST = 30 * 24 * 60 * 60;
const TTL_TODAY = 60 * 60;
/** A filed document never changes. */
const TTL_DOCUMENT = 90 * 24 * 60 * 60;

/** 有価証券報告書 — the annual securities report, which carries the full accounts. */
export const DOC_TYPE_ANNUAL = '120';
/** 四半期報告書 / 半期報告書 — quarterly and semiannual reports. */
export const DOC_TYPE_QUARTERLY = '140';
export const DOC_TYPE_SEMIANNUAL = '160';

interface EdinetFiling {
  readonly docDescription: string;
  readonly docId: string;
  /** EDINET's own document type code; 120 is the annual report. */
  readonly docTypeCode: string;
  readonly edinetCode: string;
  readonly filerName: string;
  /** Period covered, ISO, when the filing declares one. */
  readonly periodEnd: string | undefined;
  /**
   * Five-digit securities code. The first four are the TSE ticker, so Toyota's
   * 7203 appears here as "72030" — the trailing digit is a check character, not
   * part of the ticker.
   */
  readonly secCode: string | undefined;
  readonly submittedDate: string;
}

interface RawResult {
  docDescription?: string;
  docID?: string;
  docTypeCode?: string;
  edinetCode?: string;
  filerName?: string;
  periodEnd?: string;
  secCode?: string;
  submitDateTime?: string;
  withdrawalStatus?: string;
}

interface DocumentsResponse {
  metadata?: { resultset?: { count?: number }; status?: string };
  results?: RawResult[];
}

function key(): string {
  const spec = providerById('edinet');
  /* c8 ignore next -- the registry always contains 'edinet'. */
  if (!spec) throw new Error('EDINET provider spec missing from the registry.');
  return requireCredential(spec);
}

/** Normalises a TSE ticker to EDINET's five-digit securities code. */
export function toSecCode(ticker: string): string {
  const digits = ticker.trim().replace(/\D/g, '');
  return digits.length === 4 ? `${digits}0` : digits;
}

/** Everything filed on one day. EDINET indexes by date and nothing else. */
async function documentsOn(date: string): Promise<EdinetFiling[]> {
  const isToday = date === new Date().toISOString().slice(0, 10);

  return cached(
    'edinet-day',
    date,
    isToday ? TTL_TODAY : TTL_DAY_LIST,
    async () => {
      const data = await fetchJson<DocumentsResponse>(`${API}/documents.json`, {
        ...EDINET_RATE,
        // The key goes in a query parameter; EDINET accepts no header form.
        // redactUrl in the HTTP client scrubs it from any error message.
        searchParams: {
          date,
          'Subscription-Key': key(),
          // type=2 returns metadata AND the document list; type=1 is metadata only.
          type: '2'
        }
      });

      return (data.results ?? [])
        .filter(row => row.docID && row.withdrawalStatus !== '1')
        .map(row => ({
          docDescription: row.docDescription?.trim() ?? '',
          docId: row.docID as string,
          docTypeCode: row.docTypeCode ?? '',
          edinetCode: row.edinetCode ?? '',
          filerName: row.filerName?.trim() ?? '',
          periodEnd: row.periodEnd ?? undefined,
          secCode: row.secCode?.trim() || undefined,
          submittedDate: (row.submitDateTime ?? date).slice(0, 10)
        }));
    }
  );
}

export interface FilingSearch {
  /** Days scanned; each is one request against a rate-limited government API. */
  readonly daysScanned: number;
  readonly filings: readonly EdinetFiling[];
}

/**
 * Walks back day by day looking for one filer.
 *
 * `maxDays` bounds the work, because there is no query interface to push the
 * filter into — the only way to know whether a company filed is to read the
 * day. Annual reports cluster heavily in late June, since most Japanese
 * companies close their books on 31 March and file within three months.
 */
export async function findFilings({
  docTypeCodes,
  maxDays = 10,
  query,
  startDate
}: {
  docTypeCodes?: readonly string[];
  maxDays?: number;
  query: string;
  startDate?: string;
}): Promise<FilingSearch> {
  const wanted = query.trim().toLowerCase();
  const wantedSec = toSecCode(query);
  const from = startDate ? new Date(startDate) : new Date();

  const filings: EdinetFiling[] = [];
  let daysScanned = 0;

  for (let offset = 0; offset < maxDays; offset += 1) {
    const day = new Date(from.getTime() - offset * 86_400_000)
      .toISOString()
      .slice(0, 10);

    daysScanned += 1;
    const all = await documentsOn(day);

    for (const filing of all) {
      if (docTypeCodes && !docTypeCodes.includes(filing.docTypeCode)) continue;
      const matches =
        (wantedSec.length >= 4 && filing.secCode === wantedSec) ||
        filing.edinetCode.toLowerCase() === wanted ||
        filing.filerName.toLowerCase().includes(wanted);
      if (matches) filings.push(filing);
    }
  }

  return {
    daysScanned,
    filings: sortBy(filings, filing => filing.submittedDate).toReversed()
  };
}

/* ------------------------------------------------------------ financials */

/**
 * J-GAAP and IFRS element ids for the line items the asset tests need.
 *
 * Several concepts have more than one plausible tag and filers differ, so each
 * entry is an ordered list of candidates: the first one present wins. This is
 * the part most likely to need extending as new filers are encountered, and a
 * missing element is reported rather than defaulted — the same rule the EDGAR
 * path follows.
 */
const ELEMENTS: Record<string, readonly string[]> = {
  assetsCurrent: ['jppfs_cor:CurrentAssets', 'ifrs-full:CurrentAssets'],
  cash: [
    'jppfs_cor:CashAndDeposits',
    'jppfs_cor:CashAndCashEquivalents',
    'ifrs-full:CashAndCashEquivalents'
  ],
  goodwill: ['jppfs_cor:Goodwill', 'ifrs-full:Goodwill'],
  intangibles: [
    'jppfs_cor:IntangibleAssets',
    'ifrs-full:IntangibleAssetsOtherThanGoodwill'
  ],
  inventory: [
    'jppfs_cor:MerchandiseAndFinishedGoods',
    'jppfs_cor:Inventories',
    'ifrs-full:Inventories'
  ],
  liabilities: ['jppfs_cor:Liabilities', 'ifrs-full:Liabilities'],
  liabilitiesCurrent: [
    'jppfs_cor:CurrentLiabilities',
    'ifrs-full:CurrentLiabilities'
  ],
  longTermDebt: [
    'jppfs_cor:LongTermLoansPayable',
    'jppfs_cor:BondsPayable',
    'ifrs-full:NoncurrentPortionOfNoncurrentBorrowings'
  ],
  receivables: [
    'jppfs_cor:NotesAndAccountsReceivableTrade',
    'jppfs_cor:TradeAndOtherReceivables',
    'ifrs-full:TradeAndOtherCurrentReceivables'
  ],
  // Shareholders' equity excludes minority interests; net assets does not, and
  // conflating them overstates what a common holder owns.
  stockholdersEquity: [
    'jppfs_cor:ShareholdersEquity',
    'jppfs_cor:NetAssets',
    'ifrs-full:EquityAttributableToOwnersOfParent'
  ]
};

interface EdinetLineItem {
  readonly context: string;
  readonly element: string;
  readonly label: string;
  readonly unit: string;
  readonly value: Decimal;
}

export interface EdinetFinancials {
  readonly currency: string;
  readonly docId: string;
  /** Line items keyed by the same names the EDGAR path uses. */
  readonly items: Readonly<Record<string, EdinetLineItem>>;
  /** Concepts no candidate element matched. */
  readonly missing: readonly string[];
}

/**
 * A consolidated, current-period, instant context.
 *
 * EDINET emits every figure several times over — consolidated and parent-only,
 * this period and two priors. `CurrentYearInstant` with no suffix is the
 * consolidated closing balance, which is the one a screen wants; the
 * `_NonConsolidatedMember` suffix marks the parent-only duplicate.
 */
function isWantedContext(context: string): boolean {
  return (
    (context === 'CurrentYearInstant' ||
      context === 'CurrentQuarterInstant' ||
      context === 'CurrentPeriodInstant') &&
    !context.includes('NonConsolidated')
  );
}

/** Downloads the XBRL-to-CSV package and pulls the balance sheet out of it. */
export async function financials(docId: string): Promise<EdinetFinancials> {
  return parseFinancialRows(await downloadCsv(docId), docId);
}

/** The network half, split out so the parsing above stays pure. */
async function downloadCsv(docId: string): Promise<string[][]> {
  return cached('edinet-csv', docId, TTL_DOCUMENT, async () => {
    const url = new URL(`${API}/documents/${encodeURIComponent(docId)}`);
    url.searchParams.set('Subscription-Key', key());
    // type=5 is the XBRL-to-CSV package. The alternative is raw XBRL, which
    // would mean an XML parser for no gain: EDINET has already flattened it.
    url.searchParams.set('type', '5');

    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(
        `EDINET returned HTTP ${response.status} for document ${docId}. ` +
          'A 404 usually means the document has no XBRL — older filings and ' +
          'some amendments are PDF only.'
      );
    }

    const archive = unzipSync(new Uint8Array(await response.arrayBuffer()));

    // The package holds several CSVs; jpcrp_* is the corporate report, which
    // carries the financial statements. jpaud_* is the audit report.
    const name = Object.keys(archive).find(
      entry => entry.includes('jpcrp') && entry.endsWith('.csv')
    );
    if (!name) {
      throw new Error(
        `Document ${docId} contains no jpcrp CSV. Files: ${Object.keys(archive).join(', ')}`
      );
    }

    // UTF-16LE, tab-separated. Decoding as UTF-8 yields mojibake, silently.
    const text = new TextDecoder('utf-16le').decode(archive[name]);
    return text.split(/\r?\n/).map(line => line.split('\t'));
  });
}

/**
 * Turns the decoded CSV grid into line items. Pure, so the context selection
 * and element mapping — the two places a wrong number would be silent — are
 * testable without a network call or a key.
 */
export function parseFinancialRows(
  rows: readonly (readonly string[])[],
  docId = 'unknown'
): EdinetFinancials {
  const header = rows[0] ?? [];
  const column = (name: string): number => header.indexOf(name);
  const idx = {
    context: column('コンテキストID'),
    element: column('要素ID'),
    label: column('項目名'),
    unit: column('単位'),
    value: column('値')
  };

  if (idx.element < 0 || idx.value < 0) {
    throw new Error(
      `Unexpected CSV layout for ${docId}; columns were: ${header.join(', ')}`
    );
  }

  // Index every wanted element that appears in a consolidated current context.
  const found = new Map<string, EdinetLineItem>();
  for (const row of rows.slice(1)) {
    const element = row[idx.element]?.trim();
    const context = row[idx.context]?.trim() ?? '';
    if (!element || !isWantedContext(context)) continue;

    const value = dec(row[idx.value]?.trim());
    if (!value) continue;

    if (!found.has(element)) {
      found.set(element, {
        context,
        element,
        label: row[idx.label]?.trim() ?? '',
        unit: row[idx.unit]?.trim() ?? 'JPY',
        value
      });
    }
  }

  const items: Record<string, EdinetLineItem> = {};
  const missing: string[] = [];
  for (const [concept, candidates] of Object.entries(ELEMENTS)) {
    const hit = candidates.map(candidate => found.get(candidate)).find(Boolean);
    if (hit) items[concept] = hit;
    else missing.push(concept);
  }

  return { currency: 'JPY', docId, items, missing };
}
