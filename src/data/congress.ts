import { sortBy } from 'lodash-es';
import { parse as parseHtml, type HTMLElement } from 'node-html-parser';

import { cached } from '../cache/store.ts';
import { fetchJson, fetchText } from '../http/client.ts';

/**
 * Congressional stock disclosures, from the two official sources.
 *
 * A caveat that belongs on every figure this module produces, and which the
 * tools repeat: these are **ranges disclosed on a lag**, not trades you could
 * have made. The STOCK Act gives members 30 days from becoming aware of a
 * transaction and 45 days from the transaction itself, amounts are reported in
 * bands ($1,001–$15,000 and up), and late filings are common and cheaply
 * penalised. So the price a member paid is unknown and the date you learn of it
 * is weeks after the fact.
 *
 * That is a different epistemology from the rest of this server, where a figure
 * comes from a filed balance sheet and is exact. Nothing here feeds the screen;
 * it is context, and the committee cross-reference is the part with real
 * information in it — a member trading in an industry their committee
 * supervises is the pattern worth looking at.
 */

/**
 * There is no bulk download and no export endpoint. Verified: the Senate Ethics
 * Committee names efdsearch.senate.gov as *the* public database, and
 * `/search/report/export/`, `/search/download/` and `/search/report/csv/` all
 * 404. The DataTables JSON endpoint the search page calls is therefore the
 * structured feed, and it reaches the full archive — 2,426 periodic transaction
 * reports on record back to 2012.
 *
 * Every third-party mirror re-scrapes this same endpoint, adds an API key, and
 * inserts itself between the filing and the reader. The free ones tested either
 * require a key (Financial Modeling Prep, Finnhub, DisclosedCapitol), bot-block
 * (CapitolTrades), or have gone stale (senate-stock-watcher's aggregate stops
 * in 2019). So this reads the primary source directly.
 */
const SENATE_HOST = 'https://efdsearch.senate.gov';
const SENATE_RATE = { rateKey: 'efdsearch.senate.gov', requestsPerSecond: 1 };
const HOUSE_RATE = {
  rateKey: 'disclosures-clerk.house.gov',
  requestsPerSecond: 1
};
const LEGISLATORS_RATE = {
  rateKey: 'unitedstates.github.io',
  requestsPerSecond: 2
};

/** A filed report never changes; the list of them gains rows continuously. */
const TTL_REPORT = 30 * 24 * 60 * 60;
const TTL_REPORT_LIST = 6 * 60 * 60;
/** Committee rosters change with the Congress, not with the week. */
const TTL_ROSTER = 7 * 24 * 60 * 60;

export interface DisclosedTrade {
  /** Reported as a band, e.g. "$1,001 - $15,000". Never an exact figure. */
  readonly amount: string;
  readonly assetName: string;
  readonly assetType: string;
  readonly chamber: 'house' | 'senate';
  /** ISO date the report was filed — weeks after `transactionDate`. */
  readonly filedDate: string;
  readonly member: string;
  /** Self, Spouse, Child, or Joint. */
  readonly owner: string;
  readonly reportUrl: string;
  readonly ticker: string | undefined;
  /** ISO date of the transaction itself. */
  readonly transactionDate: string;
  /** Purchase, Sale, Exchange, and so on. */
  readonly type: string;
}

/** A row from Part 8 of a Senate annual report: outside roles and board seats. */
interface OutsidePosition {
  readonly comments: string | undefined;
  readonly dates: string;
  /** The organisation, as filed, usually with a city and state appended. */
  readonly entity: string;
  readonly entityType: string;
  /** Director, Officer, Partner, Trustee, Employee, Other (…). */
  readonly position: string;
}

/**
 * A row from Part 2: earned and non-investment income.
 *
 * `paidTo` is the relationship, not a name — "Self", "Spouse", "Child". Members
 * are not required to name family members, so a relationship is the most this
 * source will ever give. `payer` is the employer, and for a spouse it is
 * disclosed by name even though the amount is only banded above $1,000.
 */
interface IncomeEntry {
  readonly amount: string;
  readonly comments: string | undefined;
  /** Self, Spouse, or Child. Never a personal name. */
  readonly paidTo: string;
  readonly payer: string;
  /** Salary, Director's fees, Consulting, and so on. */
  readonly type: string;
}

export interface AnnualReport {
  readonly income: readonly IncomeEntry[];
  readonly member: string;
  readonly positions: readonly OutsidePosition[];
  readonly reportUrl: string;
  readonly year: string;
}

export interface Committee {
  readonly chamber: 'house' | 'joint' | 'senate';
  readonly name: string;
  /** Chair, Ranking Member, or undefined for a rank-and-file seat. */
  readonly title: string | undefined;
}

export interface HouseFiling {
  readonly docId: string;
  readonly filingDate: string;
  /** P is a Periodic Transaction Report — the one that carries trades. */
  readonly filingType: string;
  readonly member: string;
  readonly pdfUrl: string;
  readonly stateDistrict: string;
  readonly year: number;
}

/* ------------------------------------------------------------------ Senate */

/**
 * The Senate search sits behind a one-time "prohibition agreement" checkbox
 * that sets a session cookie. Accepting it programmatically is the documented
 * way in — the page is a public search form, not an authentication wall — but
 * it means every call needs a jar, and the CSRF token rotates on the redirect.
 */
/**
 * The handshake is two requests and eFD is throttled to one a second, so
 * re-running it per report tripled the cost of building the index. The session
 * is reused for the life of the process and re-established only when it ages
 * out.
 */
let session: undefined | { jar: Map<string, string>; openedAt: number };

/** eFD sessions outlive this comfortably; the cap is a safety valve. */
const SESSION_TTL_MS = 20 * 60 * 1000;

async function senateSession(): Promise<Map<string, string>> {
  if (session && Date.now() - session.openedAt < SESSION_TTL_MS) {
    return session.jar;
  }

  const jar = new Map<string, string>();

  await fetchText(`${SENATE_HOST}/search/home/`, {
    ...SENATE_RATE,
    cookies: jar
  });

  const token = jar.get('csrftoken');
  if (!token) {
    throw new Error(
      'Senate eFD did not issue a session token, so no query can be signed. ' +
        'The site is the only public source for this data — there is no bulk ' +
        'file and no export endpoint — so if this persists the search form has ' +
        'changed and this module needs updating. Check ' +
        'https://efdsearch.senate.gov/search/ in a browser first.'
    );
  }

  await fetchJson(`${SENATE_HOST}/search/home/`, {
    ...SENATE_RATE,
    cookies: jar,
    form: { csrfmiddlewaretoken: token, prohibition_agreement: '1' },
    headers: { referer: `${SENATE_HOST}/search/home/` }
  });

  session = { jar, openedAt: Date.now() };
  return jar;
}

interface SenateSearchResponse {
  data?: string[][];
  recordsTotal?: number;
}

/** Cell text, with the whitespace the eFD templates leave behind collapsed. */
function cellText(cell: HTMLElement): string {
  return cell.text.replaceAll(/\s+/g, ' ').trim();
}

/** Every `<td>` of every `<tbody>` row in a table, as text. */
function tableRows(table: HTMLElement | null | undefined): string[][] {
  if (!table) return [];
  return table
    .querySelectorAll('tbody tr')
    .map(row => row.querySelectorAll('td').map(cell => cellText(cell)))
    .filter(cells => cells.length > 0);
}

/** MM/DD/YYYY → ISO, so dates sort and compare like every other date here. */
export function isoDate(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
  return match ? `${match[3]}-${match[1]}-${match[2]}` : value.trim();
}

/** `--` is eFD's null. A dash is not a ticker. */
function orUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed && trimmed !== '--' ? trimmed : undefined;
}

export interface SenateReportRef {
  readonly filedDate: string;
  readonly member: string;
  readonly url: string;
}

export async function senateReportList(
  since: string,
  limit: number,
  start = 0
): Promise<SenateReportRef[]> {
  return cached(
    'congress-senate-list',
    `${since}/${limit}/${start}`,
    TTL_REPORT_LIST,
    async () => {
      const jar = await senateSession();
      const token = jar.get('csrftoken') ?? '';
      const [year, month, day] = since.split('-');

      const response = await fetchJson<SenateSearchResponse>(
        `${SENATE_HOST}/search/report/data/`,
        {
          ...SENATE_RATE,
          cookies: jar,
          form: {
            csrfmiddlewaretoken: token,
            length: String(limit),
            // 11 is the Periodic Transaction Report type. Annual reports and
            // blind-trust filings carry no per-transaction detail.
            report_types: '[11]',
            start: String(start),
            submitted_start_date: `${month}/${day}/${year} 00:00:00`
          },
          headers: {
            referer: `${SENATE_HOST}/search/`,
            'x-requested-with': 'XMLHttpRequest'
          }
        }
      );

      return (response.data ?? []).flatMap(row => {
        const [first, last, , link, filed] = row;
        const href = /href="([^"]+)"/.exec(link ?? '')?.[1];
        if (!href) return [];
        return [
          {
            filedDate: isoDate(filed ?? ''),
            member: `${first ?? ''} ${last ?? ''}`
              .replaceAll(/\s+/g, ' ')
              .trim(),
            url: `${SENATE_HOST}${href}`
          }
        ];
      });
    }
  );
}

/** Parses one PTR page. Its table is plain HTML, so no PDF handling is needed. */
export async function senateReportTrades(
  ref: SenateReportRef
): Promise<DisclosedTrade[]> {
  return cached('congress-senate-ptr', ref.url, TTL_REPORT, async () => {
    const jar = await senateSession();
    const html = await fetchText(ref.url, {
      ...SENATE_RATE,
      cookies: jar,
      headers: { referer: `${SENATE_HOST}/search/` }
    });

    const rows = tableRows(parseHtml(html).querySelector('table'));

    return rows.flatMap(cells => {
      // #, date, owner, ticker, asset, asset type, transaction type, amount, comment
      if (cells.length < 8) return [];
      return [
        {
          amount: cells[7] ?? '',
          assetName: cells[4] ?? '',
          assetType: cells[5] ?? '',
          chamber: 'senate' as const,
          filedDate: ref.filedDate,
          member: ref.member,
          owner: cells[2] ?? '',
          reportUrl: ref.url,
          ticker: orUndefined(cells[3] ?? ''),
          transactionDate: isoDate(cells[1] ?? ''),
          type: cells[6] ?? ''
        }
      ];
    });
  });
}

/**
 * Rows of the table belonging to one part of an eFD report.
 *
 * The page wraps each part in its own `<section class="card">` containing the
 * heading and, if the filer disclosed anything, a table. Scoping the table
 * lookup to that section is what makes an empty part read as empty.
 *
 * The regex version this replaced searched forward from the heading for the
 * next `<table>`, which walked straight past an empty part into the following
 * one — Part 9's royalty agreements came back as Part 8's board seats, every
 * column shifted, and nothing about the output looked wrong. That is the exact
 * failure this codebase exists to avoid, so the parse is structural now.
 */
export function sectionRows(html: string, heading: string): string[][] {
  const section = parseHtml(html)
    .querySelectorAll('section.card')
    .find(card => card.querySelector('h3')?.text.trim().startsWith(heading));

  return tableRows(section?.querySelector('table'));
}

/** eFD writes "n/a" where a filer left a comment blank. */
function orNa(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed !== 'n/a' && trimmed !== '--' ? trimmed : undefined;
}

/**
 * Reads one Senate annual report: outside positions (Part 8) and earned income
 * (Part 2).
 *
 * This is the closest an official source gets to the question "who else pays
 * this household?". Part 8 carries the member's own directorships and officer
 * roles; Part 2 names the employer behind every salary paid to the member, a
 * spouse or a child. It does not name the family members themselves — the form
 * asks for a relationship, not an identity — and no official source does.
 */
export async function senateAnnualReport(
  ref: SenateReportRef
): Promise<AnnualReport> {
  return cached('congress-senate-annual', ref.url, TTL_REPORT, async () => {
    const jar = await senateSession();
    const html = await fetchText(ref.url, {
      ...SENATE_RATE,
      cookies: jar,
      headers: { referer: `${SENATE_HOST}/search/` }
    });

    // Columns: blank, #, dates, position, entity, entity type, comments.
    const positions = sectionRows(html, 'Part 8. Positions')
      .filter(cells => cells.length >= 6)
      .map(cells => ({
        comments: orNa(cells[6]),
        dates: cells[2] ?? '',
        entity: cells[4] ?? '',
        entityType: cells[5] ?? '',
        position: cells[3] ?? ''
      }));

    // Columns: blank, #, who was paid, type, who paid, amount, comments.
    const income = sectionRows(html, 'Part 2. Earned and Non-Investment Income')
      .filter(cells => cells.length >= 6)
      .map(cells => ({
        amount: cells[5] ?? '',
        comments: orNa(cells[6]),
        paidTo: cells[2] ?? '',
        payer: cells[4] ?? '',
        type: cells[3] ?? ''
      }));

    return {
      income,
      member: ref.member,
      positions,
      reportUrl: ref.url,
      year: /CY (\d{4})/.exec(html)?.[1] ?? ''
    };
  });
}

/**
 * Finds a senator's most recent annual report.
 *
 * Two constraints from the site, both learned the hard way. An unbounded query
 * is refused with a 503 — eFD will not scan its whole archive — so a filing-date
 * window is mandatory rather than an optimisation. And the search filters on
 * surname server-side, which is far cheaper than pulling hundreds of rows to
 * match locally.
 *
 * Report type 7 covers annual and candidate filings; only the annual carries a
 * full Part 8 and Part 2, so candidate reports are dropped by title.
 */
export async function findSenateAnnualReport(
  member: string
): Promise<SenateReportRef | undefined> {
  const parts = member.trim().split(/\s+/);
  const surname = parts.at(-1) ?? member.trim();
  const wanted = normaliseName(member);

  const refs = await cached(
    'congress-senate-annual-list',
    surname.toLowerCase(),
    TTL_REPORT_LIST,
    async () => {
      const jar = await senateSession();
      const token = jar.get('csrftoken') ?? '';

      // Annual reports are filed each spring, so three years of window always
      // contains at least one and usually three.
      const from = new Date(Date.now() - 3 * 365 * 86_400_000);
      const window = `${String(from.getMonth() + 1).padStart(2, '0')}/${String(
        from.getDate()
      ).padStart(2, '0')}/${from.getFullYear()} 00:00:00`;

      const response = await fetchJson<SenateSearchResponse>(
        `${SENATE_HOST}/search/report/data/`,
        {
          ...SENATE_RATE,
          cookies: jar,
          form: {
            csrfmiddlewaretoken: token,
            last_name: surname,
            length: '50',
            report_types: '[7]',
            start: '0',
            submitted_start_date: window
          },
          headers: {
            referer: `${SENATE_HOST}/search/`,
            'x-requested-with': 'XMLHttpRequest'
          }
        }
      );

      return (response.data ?? []).flatMap(row => {
        const [first, last, , link, filed] = row;
        const href = /href="([^"]+)"/.exec(link ?? '')?.[1];
        if (!href || !/Annual Report/i.test(link ?? '')) return [];
        return [
          {
            filedDate: isoDate(filed ?? ''),
            member: `${first ?? ''} ${last ?? ''}`
              .replaceAll(/\s+/g, ' ')
              .trim(),
            url: `${SENATE_HOST}${href}`
          }
        ];
      });
    }
  );

  // Prefer an exact name match; fall back to the surname hit when the filer's
  // middle initial or suffix differs from what the caller typed.
  const exact = refs.filter(ref => normaliseName(ref.member) === wanted);
  const pool = exact.length > 0 ? exact : refs;
  return sortBy(pool, ref => ref.filedDate).at(-1);
}

/* ------------------------------------------------------------------- House */

/** Pulls one tag's text out of an XML block. */
function field(block: string, tag: string): string {
  return (
    new RegExp(`<${tag}>(.*?)</${tag}>`, 's').exec(block)?.[1]?.trim() ?? ''
  );
}

/**
 * The House Clerk publishes a yearly ZIP whose XML index lists every filing.
 * The index gives the filer, the type and a document id; the transactions
 * themselves live in a PDF, and many are scanned images. So this returns the
 * filing record and a link, and says so — inventing transaction detail from a
 * document nothing here has read is exactly what this server exists not to do.
 */
export async function houseFilings({
  filingType = 'P',
  year
}: {
  filingType?: string;
  year: number;
}): Promise<HouseFiling[]> {
  return cached(
    'congress-house-index',
    String(year),
    TTL_REPORT_LIST,
    async () => {
      const xml = await fetchText(
        `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/${year}FD.xml`,
        {
          ...HOUSE_RATE,
          // Asking for XML explicitly, because this endpoint returns 406 to
          // an Accept list that does not name a type it can serve.
          headers: { accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8' }
        }
      );

      return [...xml.matchAll(/<Member>(.*?)<\/Member>/gs)].flatMap(match => {
        const block = match[1] ?? '';
        const type = field(block, 'FilingType');
        if (filingType && type !== filingType) return [];

        const docId = field(block, 'DocID');
        const name = [field(block, 'First'), field(block, 'Last')]
          .filter(Boolean)
          .join(' ');

        return [
          {
            docId,
            filingDate: isoDate(field(block, 'FilingDate')),
            filingType: type,
            member: name,
            pdfUrl: `https://disclosures-clerk.house.gov/public_disc/ptr-pdfs/${year}/${docId}.pdf`,
            stateDistrict: field(block, 'StateDst'),
            year
          }
        ];
      });
    }
  );
}

/* -------------------------------------------------------------- Committees */

interface RawCommittee {
  chamber?: string;
  name?: string;
  thomas_id?: string;
  type?: string;
}

interface RawMembership {
  bioguide?: string;
  name?: string;
  title?: string;
}

const LEGISLATORS_BASE = 'https://unitedstates.github.io/congress-legislators';

/**
 * Committee assignments, keyed by member name.
 *
 * This is the cross-reference the disclosures are worth reading against. A
 * member on the committee that writes a sector's rules, trading in that sector,
 * is a different observation from the same member trading an index fund — not
 * proof of anything, but the question worth asking.
 */
export async function committeesByMember(): Promise<Map<string, Committee[]>> {
  const [committees, membership] = await Promise.all([
    cached('congress-committees', 'current', TTL_ROSTER, () =>
      fetchJson<RawCommittee[]>(
        `${LEGISLATORS_BASE}/committees-current.json`,
        LEGISLATORS_RATE
      )
    ),
    cached('congress-membership', 'current', TTL_ROSTER, () =>
      fetchJson<Record<string, RawMembership[]>>(
        `${LEGISLATORS_BASE}/committee-membership-current.json`,
        LEGISLATORS_RATE
      )
    )
  ]);

  const byId = new Map(
    committees
      .filter(committee => committee.thomas_id)
      .map(committee => [committee.thomas_id as string, committee])
  );

  const result = new Map<string, Committee[]>();
  for (const [committeeId, members] of Object.entries(membership)) {
    // Subcommittee ids are the parent id plus a suffix; fall back to the parent
    // so a subcommittee seat still attributes to the committee that matters.
    const parent = byId.get(committeeId) ?? byId.get(committeeId.slice(0, 4));
    if (!parent?.name) continue;

    for (const member of members) {
      if (!member.name) continue;
      const key = normaliseName(member.name);
      const existing = result.get(key) ?? [];
      if (existing.some(entry => entry.name === parent.name)) continue;
      existing.push({
        chamber:
          parent.chamber === 'house'
            ? 'house'
            : parent.chamber === 'senate'
              ? 'senate'
              : 'joint',
        name: parent.name,
        title: member.title
      });
      result.set(key, existing);
    }
  }

  return result;
}

/**
 * Disclosure sources and the legislator roster spell names differently —
 * "Cory A Booker" against "Cory Booker", "Boozman, John" against "John
 * Boozman". Reducing to a sorted set of lowercase name parts, with single
 * letters dropped, matches them without a fuzzy-match library.
 */
export function normaliseName(name: string): string {
  const parts = name
    .toLowerCase()
    .replaceAll(/[.,]/g, ' ')
    .split(/\s+/)
    .filter(part => part.length > 1 && !HONORIFICS.has(part));
  return sortBy(parts).join(' ');
}

const HONORIFICS = new Set([
  'dr',
  'jr',
  'mr',
  'mrs',
  'ms',
  'representative',
  'senator',
  'sr'
]);
