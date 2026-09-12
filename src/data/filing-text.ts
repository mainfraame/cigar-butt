import { cached, TTL } from '../cache/store.ts';
import { fetchText } from '../http/client.ts';

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
  const start = new RegExp(`Item\\s+${escaped}\\b`, 'i').exec(text);
  if (!start) return undefined;

  const rest = text.slice(start.index);
  // Skip the heading itself before looking for the next one.
  const next = /Item\s+\d+\.\d+/gi;
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
export async function filingText(
  cik: string,
  event: FilingEvent
): Promise<string | undefined> {
  if (!event.primaryDocument) return undefined;

  const bare = event.accessionNumber.replaceAll('-', '');
  const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${bare}/${event.primaryDocument}`;

  try {
    const body = await cached(
      'sec-filing-text',
      event.accessionNumber,
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
