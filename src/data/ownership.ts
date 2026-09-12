import { sortBy } from 'lodash-es';
import { parse } from 'node-html-parser';

import { cached, TTL } from '../cache/store.ts';
import { fetchText } from '../http/client.ts';
import { dec, type Decimal } from '../math/decimal.ts';
import { submissions, type FilingEvent } from './sec.ts';

/**
 * Who is buying and selling the shares, from the ownership filings.
 *
 * This answers a question the asset tests cannot: a balance sheet says a name
 * is cheap, and this says whether anyone with a better view of it agrees.
 * Both halves are primary-source — Forms 3, 4, 13D and 13G are filed under
 * penalty, not written by a commentator.
 *
 * The distinction the whole module turns on is **transaction code**. A Form 4
 * reports compensation and tax mechanics in the same table as real trades, so
 * counting rows produces "insiders are buying" from a routine option grant.
 * Only `P` and `S` are decisions to transact at the market price with the
 * filer's own money, and only those are summed into the net figures.
 */

const SEC_RATE = { rateKey: 'www.sec.gov', requestsPerSecond: 6 } as const;

/**
 * What each Form 4 transaction code actually is.
 *
 * The comments are the point, not decoration: `A` and `F` are the two that get
 * mistaken for conviction and capitulation respectively.
 */
export const TRANSACTION_CODES: Readonly<Record<string, string>> = {
  /** Compensation. The insider chose nothing and paid nothing. */
  A: 'grant or award',
  C: 'conversion of a derivative',
  /** Shares surrendered to cover withholding on a vest. Not a decision to sell. */
  F: 'withheld for tax',
  G: 'gift',
  /** Exercising an option, usually at a strike set years earlier. */
  M: 'option exercise',
  /** Cash out of pocket at the prevailing price. */
  P: 'open-market purchase',
  /** Sold at the prevailing price. */
  S: 'open-market sale',
  W: 'acquired or disposed by will',
  X: 'in-the-money option exercise'
};

/** Only these two are a decision to transact at the market price. */
export function isOpenMarket(code: string): boolean {
  return code === 'P' || code === 'S';
}

export interface InsiderTransaction {
  readonly accn: string;
  /** True when shares were acquired, false when disposed. */
  readonly acquired: boolean;
  /** ISO date of the transaction itself, not the filing. */
  readonly asOf: string;
  readonly code: string;
  readonly director: boolean;
  readonly filed: string;
  readonly officer: boolean;
  readonly officerTitle: string | undefined;
  readonly owner: string;
  /** Undefined for a grant, which has no price. */
  readonly price: Decimal | undefined;
  readonly security: string;
  readonly shares: Decimal;
  readonly sharesAfter: Decimal | undefined;
  readonly tenPercentOwner: boolean;
}

/** A Form 3: someone became an insider. Often a new board seat. */
export interface NewInsider {
  readonly accn: string;
  readonly director: boolean;
  readonly filed: string;
  readonly officer: boolean;
  readonly officerTitle: string | undefined;
  readonly owner: string;
  readonly tenPercentOwner: boolean;
}

/** A 13D or 13G: someone crossed 5% of the shares outstanding. */
export interface StakeFiling {
  readonly accn: string;
  /**
   * 13D means the holder reserves the right to influence control; 13G means
   * they declare themselves passive. The difference is the whole signal —
   * a 13D at a company trading below its cash is usually a demand that the
   * cash be returned.
   */
  readonly activist: boolean;
  readonly amendment: boolean;
  readonly filed: string;
  readonly filer: string | undefined;
  readonly form: string;
}

const text = (node: ReturnType<typeof parse>, selector: string) =>
  node.querySelector(selector)?.text.trim() || undefined;

/**
 * Fetches and parses one Form 3 or 4.
 *
 * Selectors are lowercase because the parser folds tag names; the XML itself
 * is camelCase.
 */
async function ownershipDocument(
  cik: string,
  event: FilingEvent
): Promise<undefined | { owners: OwnerRef[]; transactions: RawTransaction[] }> {
  const bare = event.accessionNumber.replaceAll('-', '');
  const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${bare}/primary_doc.xml`;

  let body: string;
  try {
    body = await cached(
      'sec-ownership',
      event.accessionNumber,
      TTL.frames,
      () =>
        fetchText(url, {
          ...SEC_RATE,
          headers: { accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8' }
        })
    );
  } catch {
    // A filer may use a differently named primary document. One unreadable
    // form is not a reason to fail the whole report.
    return undefined;
  }

  const root = parse(body);

  const owners = root.querySelectorAll('reportingowner').map(node => ({
    director: text(node as never, 'isdirector') === '1',
    name: text(node as never, 'rptownername') ?? 'unknown',
    officer: text(node as never, 'isofficer') === '1',
    officerTitle: text(node as never, 'officertitle'),
    tenPercentOwner: text(node as never, 'istenpercentowner') === '1'
  }));

  const transactions = root
    .querySelectorAll('nonderivativetransaction')
    .map(node => ({
      acquired:
        text(node as never, 'transactionacquireddisposedcode value') === 'A',
      code: text(node as never, 'transactioncode') ?? '',
      date: text(node as never, 'transactiondate value') ?? '',
      price: dec(text(node as never, 'transactionpricepershare value')),
      security: text(node as never, 'securitytitle value') ?? 'Common Stock',
      shares: dec(text(node as never, 'transactionshares value')),
      sharesAfter: dec(
        text(node as never, 'sharesownedfollowingtransaction value')
      )
    }));

  return { owners, transactions };
}

interface OwnerRef {
  director: boolean;
  name: string;
  officer: boolean;
  officerTitle: string | undefined;
  tenPercentOwner: boolean;
}

interface RawTransaction {
  acquired: boolean;
  code: string;
  date: string;
  price: Decimal | undefined;
  security: string;
  shares: Decimal | undefined;
  sharesAfter: Decimal | undefined;
}

export interface OwnershipActivity {
  readonly newInsiders: readonly NewInsider[];
  readonly stakes: readonly StakeFiling[];
  readonly transactions: readonly InsiderTransaction[];
  /** Forms that could not be read, so a gap is visible rather than silent. */
  readonly unreadable: number;
}

/**
 * Every ownership filing in the window.
 *
 * `maxDocuments` bounds the work: each Form 3/4 is one request, and a busy
 * issuer can file dozens in a month. Filings beyond the cap are reported as
 * unread rather than quietly dropped — a partial picture presented as a whole
 * is how "no insider buying" gets concluded from a truncated list.
 */
export async function ownershipActivity(
  cik: string,
  {
    maxDocuments = 30,
    now = new Date(),
    sinceDays = 180
  }: { maxDocuments?: number; now?: Date; sinceDays?: number } = {}
): Promise<OwnershipActivity> {
  const cutoff = new Date(now.getTime() - sinceDays * 86_400_000)
    .toISOString()
    .slice(0, 10);

  const { events } = await submissions(cik);
  const inWindow = events.filter(event => event.filingDate >= cutoff);

  const stakes: StakeFiling[] = [];
  for (const event of inWindow) {
    const form = event.form.toUpperCase();
    if (!form.includes('13D') && !form.includes('13G')) continue;
    stakes.push({
      accn: event.accessionNumber,
      activist: form.includes('13D'),
      amendment: form.endsWith('/A'),
      filed: event.filingDate,
      filer: await stakeFiler(cik, event),
      form: event.form
    });
  }

  const ownership = inWindow.filter(
    event => event.form === '3' || event.form === '4'
  );
  const readable = ownership.slice(0, maxDocuments);

  const transactions: InsiderTransaction[] = [];
  const newInsiders: NewInsider[] = [];
  let unreadable = ownership.length - readable.length;

  for (const event of readable) {
    const parsed = await ownershipDocument(cik, event);
    if (!parsed) {
      unreadable += 1;
      continue;
    }

    // A joint filing names several owners for one set of transactions. The
    // first is the one the transactions belong to; the rest are affiliates
    // reporting the same trade, and counting them again would multiply it.
    const owner = parsed.owners[0];
    if (!owner) continue;

    if (event.form === '3') {
      newInsiders.push({
        accn: event.accessionNumber,
        director: owner.director,
        filed: event.filingDate,
        officer: owner.officer,
        officerTitle: owner.officerTitle,
        owner: owner.name,
        tenPercentOwner: owner.tenPercentOwner
      });
      continue;
    }

    for (const raw of parsed.transactions) {
      if (!raw.shares || !raw.date) continue;
      transactions.push({
        accn: event.accessionNumber,
        acquired: raw.acquired,
        asOf: raw.date,
        code: raw.code,
        director: owner.director,
        filed: event.filingDate,
        officer: owner.officer,
        officerTitle: owner.officerTitle,
        owner: owner.name,
        price: raw.price,
        security: raw.security,
        shares: raw.shares,
        sharesAfter: raw.sharesAfter,
        tenPercentOwner: owner.tenPercentOwner
      });
    }
  }

  return {
    newInsiders: sortBy(newInsiders, entry => entry.filed).toReversed(),
    stakes: sortBy(stakes, entry => entry.filed).toReversed(),
    transactions: sortBy(transactions, entry => entry.asOf).toReversed(),
    unreadable
  };
}

/**
 * Who filed a 13D or 13G, from the submission's SGML header.
 *
 * The subject company's filing index says a 13G was filed but not by whom,
 * and the filer is the entire point — "someone crossed 5%" is not a finding.
 */
async function stakeFiler(
  cik: string,
  event: FilingEvent
): Promise<string | undefined> {
  const bare = event.accessionNumber.replaceAll('-', '');
  const url = `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${bare}/${event.accessionNumber}-index-headers.html`;

  try {
    const body = await cached(
      'sec-stake-header',
      event.accessionNumber,
      TTL.frames,
      () => fetchText(url, SEC_RATE)
    );
    return parseFiledBy(body);
  } catch {
    return undefined;
  }
}

/**
 * Pulls the filer name out of an EDGAR SGML header.
 *
 * The header names the subject company first and the filer second, both under
 * `COMPANY CONFORMED NAME`, so the section matters: taking the first match
 * reports the issuer as its own 5% holder.
 */
export function parseFiledBy(header: string): string | undefined {
  const filedBy = header.indexOf('FILED BY:');
  if (filedBy < 0) return undefined;
  const match = /COMPANY CONFORMED NAME:\s*(.+)/.exec(header.slice(filedBy));
  return (
    match?.[1]
      ?.trim()
      .replace(/<[^>]*>/g, '')
      .trim() || undefined
  );
}
