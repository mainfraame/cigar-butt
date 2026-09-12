import { cached } from '../cache/store.ts';
import { fetchJson } from '../http/client.ts';
import { dec, div } from '../math/decimal.ts';

import type { Decimal } from '../math/decimal.ts';

/**
 * FDIC BankFind, which is the call report rather than a vendor's reading of it.
 *
 * This server refuses to compute enterprise value or net cash for SIC
 * 6000-6799, and rightly: deposits are not spare cash and the securities book
 * is not working capital. But refusing leaves a bank with no asset-based test
 * at all, and banks are exactly where a Schloss screen keeps landing, because
 * they trade below book more often than anything else.
 *
 * The call report supplies the test that does work on a bank: tangible common
 * equity, noncurrent loans against the allowance held against them, and the
 * leverage the equity is carrying. Every figure is a quarterly filing with a
 * report date attached, so nothing here is undated.
 *
 * No credential. FDIC asks for nothing but politeness.
 */

const FDIC_RATE = { rateKey: 'api.fdic.gov', requestsPerSecond: 4 } as const;

/**
 * Call reports land quarterly and are then revised for weeks afterwards. A day
 * is short enough to pick up a revision and long enough that a screen touching
 * forty banks does not refetch each one.
 */
const TTL_CALL_REPORT = 24 * 60 * 60;

/** The institution index changes on charter events only. */
const TTL_INSTITUTION = 7 * 24 * 60 * 60;

/** Call-report dollar fields are reported in thousands. */
const THOUSANDS = 1000;

export interface BankFinancials {
  /** Loss allowance as a multiple of noncurrent loans. Under 1.0 is thin. */
  readonly allowanceCoverage?: number;
  /** Total assets, dollars. */
  readonly assets?: number;
  readonly cert: number;
  readonly deposits?: number;
  /** Total equity capital, dollars. */
  readonly equity?: number;
  /** Goodwill and other intangibles, dollars. Stripped from tangible equity. */
  readonly intangibles?: number;
  readonly netIncome?: number;
  /** Noncurrent loans as a fraction of net loans and leases. */
  readonly noncurrentLoanRatio?: number;
  /** Noncurrent loans and leases, dollars. */
  readonly noncurrentLoans?: number;
  /** Report date, ISO. The date every figure in this record is as of. */
  readonly reportDate: string;
  /** Return on assets, percent, as the call report states it. */
  readonly returnOnAssets?: number;
  readonly returnOnEquity?: number;
  /** Equity less perpetual preferred less intangibles, dollars. */
  readonly tangibleCommonEquity?: number;
  /** Tangible common equity over tangible assets. The leverage that matters. */
  readonly tangibleEquityRatio?: number;
}

export interface Institution {
  readonly active: boolean;
  readonly cert: number;
  readonly city?: string;
  /** Name of the holding company, which is usually the SEC filer. */
  readonly holdingCompany?: string;
  readonly name: string;
  readonly state?: string;
}

interface FdicEnvelope<T> {
  readonly data?: { readonly data?: T; readonly score?: number }[];
}

interface FdicFinancialRow {
  readonly ASSET?: number | string;
  readonly CERT?: number | string;
  readonly DEP?: number | string;
  readonly EQ?: number | string;
  readonly EQPP?: number | string;
  readonly INTAN?: number | string;
  readonly LNATRES?: number | string;
  readonly LNLSNET?: number | string;
  readonly NCLNLS?: number | string;
  readonly NETINC?: number | string;
  readonly REPDTE?: number | string;
  readonly ROA?: number | string;
  readonly ROE?: number | string;
}

interface FdicInstitutionRow {
  readonly ACTIVE?: number | string;
  readonly CERT?: number | string;
  readonly CITY?: string;
  readonly NAME?: string;
  readonly NAMEHCR?: string;
  readonly STALP?: string;
}

const FINANCIAL_FIELDS = [
  'CERT',
  'REPDTE',
  'ASSET',
  'DEP',
  'EQ',
  'EQPP',
  'INTAN',
  'LNATRES',
  'LNLSNET',
  'NCLNLS',
  'NETINC',
  'ROA',
  'ROE'
].join(',');

const INSTITUTION_FIELDS = 'NAME,CERT,ACTIVE,CITY,STALP,NAMEHCR';

/** Both endpoints date things differently: `20260630` here, `06/30/2026` there. */
function isoDate(value: number | string | undefined): string | undefined {
  const raw = String(value ?? '').trim();
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  const slashed = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  return slashed ? `${slashed[3]}-${slashed[1]}-${slashed[2]}` : undefined;
}

/** Thousands of dollars to dollars, as a Decimal. */
function dollars(value: number | string | undefined): Decimal | undefined {
  return dec(value)?.times(THOUSANDS);
}

function toInstitution(row: FdicInstitutionRow): Institution | undefined {
  const cert = dec(row.CERT);
  if (!row.NAME || cert === undefined) return undefined;
  return {
    active: String(row.ACTIVE ?? '') === '1',
    cert: cert.toNumber(),
    city: row.CITY,
    holdingCompany: row.NAMEHCR === '' ? undefined : row.NAMEHCR,
    name: row.NAME,
    state: row.STALP
  };
}

async function searchField(
  field: 'NAME' | 'NAMEHCR',
  term: string,
  limit: number
): Promise<Institution[]> {
  const data = await fetchJson<FdicEnvelope<FdicInstitutionRow>>(
    'https://api.fdic.gov/banks/institutions',
    {
      ...FDIC_RATE,
      searchParams: {
        fields: INSTITUTION_FIELDS,
        format: 'json',
        limit: String(limit),
        search: `${field}:"${term}"`
      }
    }
  );

  const found: Institution[] = [];
  for (const row of data.data ?? []) {
    const institution = row.data && toInstitution(row.data);
    if (institution) found.push(institution);
  }
  return found;
}

/**
 * Finds insured institutions by name. Searches the bank's own name and its
 * holding company's separately, because the SEC filer is nearly always the
 * holding company ("FIRST KEYSTONE CORP") while the insured entity carries a
 * different one ("First Keystone Community Bank"), and FDIC's search ANDs the
 * two fields into zero hits if both are given at once.
 */
export async function findInstitutions(
  term: string,
  limit = 5
): Promise<Institution[]> {
  return cached(
    'fdic-institution',
    `${term}/${limit}`,
    TTL_INSTITUTION,
    async () => {
      const byName = await searchField('NAME', term, limit);
      const byHolding = await searchField('NAMEHCR', term, limit);

      const merged = new Map<number, Institution>();
      for (const institution of [...byName, ...byHolding]) {
        merged.set(institution.cert, institution);
      }
      return [...merged.values()].slice(0, limit);
    }
  );
}

/**
 * The most recent call report for one certificate. Requests several quarters
 * and picks the latest report date rather than trusting the sort, since a
 * quarter served out of order would silently date every figure wrongly.
 */
export async function latestCallReport(
  cert: number
): Promise<BankFinancials | undefined> {
  return cached('fdic-financials', String(cert), TTL_CALL_REPORT, async () => {
    const data = await fetchJson<FdicEnvelope<FdicFinancialRow>>(
      'https://api.fdic.gov/banks/financials',
      {
        ...FDIC_RATE,
        searchParams: {
          fields: FINANCIAL_FIELDS,
          filters: `CERT:${cert}`,
          format: 'json',
          limit: '4',
          sort_by: 'REPDTE',
          sort_order: 'DESC'
        }
      }
    );

    const rows = (data.data ?? [])
      .map(entry => entry.data)
      .filter((row): row is FdicFinancialRow => row !== undefined)
      .map(row => ({ reportDate: isoDate(row.REPDTE), row }))
      .filter(
        (entry): entry is { reportDate: string; row: FdicFinancialRow } =>
          entry.reportDate !== undefined
      );

    if (rows.length === 0) return undefined;

    const newest = rows.reduce((best, entry) =>
      entry.reportDate > best.reportDate ? entry : best
    );
    const { reportDate, row } = newest;

    const assets = dollars(row.ASSET);
    const equity = dollars(row.EQ);
    const intangibles = dollars(row.INTAN);
    const preferred = dollars(row.EQPP);
    const noncurrentLoans = dollars(row.NCLNLS);
    const allowance = dollars(row.LNATRES);

    const tangibleCommonEquity = equity
      ?.minus(preferred ?? 0)
      .minus(intangibles ?? 0);
    const tangibleAssets = assets?.minus(intangibles ?? 0);

    return {
      allowanceCoverage: div(allowance, noncurrentLoans)
        ?.toDecimalPlaces(2)
        .toNumber(),
      assets: assets?.toNumber(),
      cert,
      deposits: dollars(row.DEP)?.toNumber(),
      equity: equity?.toNumber(),
      intangibles: intangibles?.toNumber(),
      netIncome: dollars(row.NETINC)?.toNumber(),
      noncurrentLoanRatio: div(noncurrentLoans, dollars(row.LNLSNET))
        ?.toDecimalPlaces(6)
        .toNumber(),
      noncurrentLoans: noncurrentLoans?.toNumber(),
      reportDate,
      returnOnAssets: dec(row.ROA)?.toDecimalPlaces(2).toNumber(),
      returnOnEquity: dec(row.ROE)?.toDecimalPlaces(2).toNumber(),
      tangibleCommonEquity: tangibleCommonEquity?.toNumber(),
      tangibleEquityRatio: div(tangibleCommonEquity, tangibleAssets)
        ?.toDecimalPlaces(6)
        .toNumber()
    };
  });
}
