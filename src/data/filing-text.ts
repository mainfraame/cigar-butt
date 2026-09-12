import { cached, TTL } from '../cache/store.ts';
import { fetchJson, fetchText } from '../http/client.ts';
import { dec, div, ZERO, type Decimal } from '../math/decimal.ts';

import type { FilingEvent } from './sec.ts';

/**
 * The words inside a filing.
 *
 * Every other reader here takes structured data — XBRL facts, the filing
 * index, an ownership table. This one exists because the disqualifier scan
 * ends by telling you to go and read something, and until now there was no
 * way to. `check_disqualifiers` reporting "8-K item 3.01: read the filing"
 * and offering no means of reading it left the most important step of the
 * method outside the server.
 *
 * An item 3.01 is the case in point. It covers both "we are failing a listing
 * rule" and "we have regained compliance", which are opposite facts under one
 * code. The index cannot tell them apart. The first sentence of the filing
 * can.
 */

const SEC_RATE = { rateKey: 'www.sec.gov', requestsPerSecond: 6 } as const;

/** Strips markup and collapses whitespace, leaving readable prose. */
export function plainText(markup: string): string {
  return (
    markup
      // Script and style bodies are not prose and are frequently enormous.
      .replaceAll(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
      // A block boundary is a word boundary; without this, table cells merge.
      .replaceAll(/<\/(p|div|tr|td|th|li|h[1-6]|table)>/gi, ' ')
      .replaceAll(/<br\s*\/?>/gi, ' ')
      .replaceAll(/<[^>]+>/g, '')
      .replaceAll('&nbsp;', ' ')
      .replaceAll('&amp;', '&')
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&quot;', '"')
      .replaceAll('&#39;', "'")
      .replaceAll(/&[#a-z0-9]+;/gi, ' ')
      .replaceAll(/\s+/g, ' ')
      .trim()
  );
}

/**
 * Narrows the text to one numbered Item.
 *
 * An 8-K carrying items 3.01, 7.01 and 9.01 is three unrelated disclosures in
 * one document, and returning all of it to answer a question about one of them
 * buries the answer. The section runs to the next Item heading — matched on a
 * *different* number, because the heading itself repeats.
 */
export function extractItem(text: string, item: string): string | undefined {
  const escaped = item.replaceAll('.', '\\.');
  // A bare number must not be satisfied by a decimal heading — "Item 4"
  // appears inside "Item 4.01", which is a different item in a different
  // form. The dot itself is fine, since a 13D writes "Item 4."; it is a dot
  // *followed by a digit* that means this is really 4.01.
  const boundary = item.includes('.') ? '\\b' : '(?!\\.?\\d)';
  const start = new RegExp(`Item\\s+${escaped}${boundary}`, 'i').exec(text);
  if (!start) return undefined;

  const rest = text.slice(start.index);
  // The decimal is optional: an 8-K numbers its items 3.01 and a 13D numbers
  // them 4, so a terminator demanding a decimal runs a 13D section to the end
  // of the document — which is how Item 4, the one that says what an activist
  // wants, came back buried in fourteen thousand characters.
  const next = /Item\s+\d+(\.\d+)?/gi;
  next.lastIndex = start[0].length;
  const match = next.exec(rest);

  return (match ? rest.slice(0, match.index) : rest).trim();
}

/**
 * Fetches a filing's primary document as text.
 *
 * The document name comes from the submissions index rather than from listing
 * the directory, which would be a second request and would have to guess which
 * of several files is the filing.
 */
/** One file inside a filing. */
export interface FilingDocument {
  readonly name: string;
  readonly size: number | undefined;
}

interface DirectoryResponse {
  directory?: { item?: { name?: string; size?: string }[] };
}

/**
 * Every file in a filing, not just the main one.
 *
 * A 13D puts its transaction detail in an exhibit — Sarissa's Amendment 16
 * reports sixty days of trading in Exhibit 17 and says nothing about it in
 * the body — so a reader limited to the primary document can see that
 * something was traded and never what.
 */
export async function filingDocuments(
  cik: string,
  accessionNumber: string
): Promise<FilingDocument[]> {
  const bare = accessionNumber.replaceAll('-', '');
  const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${bare}/index.json`;

  const data = await cached(
    'sec-filing-index',
    accessionNumber,
    TTL.frames,
    () => fetchJson<DirectoryResponse>(url, SEC_RATE)
  );

  return (data.directory?.item ?? [])
    .map(item => ({
      name: item.name ?? '',
      size: item.size === undefined ? undefined : Number(item.size)
    }))
    .filter(
      item =>
        item.name.length > 0 &&
        // The index pages describe the filing rather than being part of it.
        !item.name.includes('-index')
    );
}

export async function filingText(
  cik: string,
  event: FilingEvent,
  document?: string
): Promise<string | undefined> {
  const name = document ?? event.primaryDocument;
  if (!name) return undefined;

  const bare = event.accessionNumber.replaceAll('-', '');
  const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${bare}/${name}`;

  try {
    const body = await cached(
      'sec-filing-text',
      `${event.accessionNumber}/${name}`,
      // A filed document never changes, so this is cacheable for as long as
      // anything here is.
      TTL.frames,
      () => fetchText(url, SEC_RATE)
    );
    return plainText(body);
  } catch {
    return undefined;
  }
}

/** One row of a filer's broker fills report. */
export interface Fill {
  readonly amount: Decimal;
  readonly buy: boolean;
  readonly price: Decimal;
  readonly tradeDate: string;
}

export interface FillSummary {
  readonly bought: Decimal;
  readonly fills: number;
  readonly from: string;
  readonly highPrice: Decimal;
  readonly lowPrice: Decimal;
  readonly sold: Decimal;
  readonly to: string;
  /** Value-weighted average across every fill, buys and sells alike. */
  readonly vwap: Decimal | undefined;
}

/**
 * Parses the transaction schedule a 13D or 13G filer attaches.
 *
 * Rule 13d-2 makes a filer disclose sixty days of trading, and the usual form
 * is a raw broker fills report: hundreds of rows of side, price, amount and
 * date, with no total anywhere. Sarissa's Amarin exhibit runs to 19,000
 * characters and says only "Sell" over and over — the direction is legible at
 * a glance and the size is not, which is the wrong way round for a reader
 * deciding whether a holder is trimming or leaving.
 *
 * Deliberately tolerant and deliberately silent on failure: there is no
 * prescribed format, so a layout this does not recognise returns nothing
 * rather than a number assembled from whatever matched.
 */
export function parseFills(text: string): FillSummary | undefined {
  const rows = [
    ...text.matchAll(
      /\b(Buy|Sell|Purchase|Sale)\b[\s|]+([\d,]+\.?\d*)[\s|]+([\d,]+\.?\d*)[\s|]+(\d{4}-\d{2}-\d{2})/gi
    )
  ];
  if (rows.length === 0) return undefined;

  const fills: Fill[] = [];
  for (const row of rows) {
    const price = dec(row[2]?.replaceAll(',', ''));
    const amount = dec(row[3]?.replaceAll(',', ''));
    if (!price || !amount || !row[4]) continue;
    fills.push({
      amount,
      buy: /^(buy|purchase)$/i.test(row[1] ?? ''),
      price,
      tradeDate: row[4]
    });
  }
  if (fills.length === 0) return undefined;

  const dates = fills.map(fill => fill.tradeDate).toSorted();
  const prices = fills.map(fill => fill.price);
  const gross = fills.reduce(
    (total, fill) => total.plus(fill.price.times(fill.amount)),
    ZERO
  );
  const shares = fills.reduce((total, fill) => total.plus(fill.amount), ZERO);

  return {
    bought: fills
      .filter(fill => fill.buy)
      .reduce((total, fill) => total.plus(fill.amount), ZERO),
    fills: fills.length,
    from: dates[0]!,
    highPrice: prices.reduce((high, price) => (price.gt(high) ? price : high)),
    lowPrice: prices.reduce((low, price) => (price.lt(low) ? price : low)),
    sold: fills
      .filter(fill => !fill.buy)
      .reduce((total, fill) => total.plus(fill.amount), ZERO),
    to: dates.at(-1)!,
    vwap: div(gross, shares)
  };
}
