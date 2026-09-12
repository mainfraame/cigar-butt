import { sortBy } from 'lodash-es';

import { cached } from '../cache/store.ts';
import { providerById } from '../config/providers.ts';
import { requireCredential } from '../config/store.ts';
import { fetchJson } from '../http/client.ts';

/**
 * UK Companies House — the statutory register for every company incorporated
 * in the United Kingdom.
 *
 * What it is good for here is **disqualifier checks**, not valuation. The
 * register is definitive on the facts that void a thesis outright: whether the
 * company still exists, whether it is in liquidation or administration,
 * whether there is a proposal to strike it off, whether its accounts are
 * overdue, and whether its assets are pledged as security. Those are the same
 * questions `check_disqualifiers` asks of an SEC filer, answered by an
 * authority rather than inferred from news.
 *
 * What it is NOT good for is the balance sheet. UK accounts are filed as iXBRL
 * or PDF documents rather than structured data, small companies may file
 * abridged accounts carrying almost nothing, and a listed company's real
 * annual report goes to the FCA's National Storage Mechanism rather than here.
 * So this module reads the register and says plainly that the numbers are
 * elsewhere.
 */

const API = 'https://api.company-information.service.gov.uk';

/** Documented limit is 600 requests per five minutes, which is 2/second. */
const CH_RATE = {
  rateKey: 'api.company-information.service.gov.uk',
  requestsPerSecond: 2
};

/** The register changes on filing events, not continuously. */
const TTL_PROFILE = 6 * 60 * 60;
const TTL_SEARCH = 24 * 60 * 60;

type Severity = 'disqualify' | 'investigate' | 'note';

export interface RegisterFlag {
  readonly detail: string;
  readonly label: string;
  readonly severity: Severity;
}

export interface CompanyProfile {
  readonly accountsNextDue: string | undefined;
  readonly accountsOverdue: boolean;
  readonly companyName: string;
  readonly companyNumber: string;
  readonly confirmationOverdue: boolean;
  readonly hasBeenLiquidated: boolean;
  readonly hasCharges: boolean;
  readonly hasInsolvencyHistory: boolean;
  readonly incorporatedOn: string | undefined;
  readonly jurisdiction: string | undefined;
  readonly officeInDispute: boolean;
  readonly previousNames: readonly string[];
  readonly sicCodes: readonly string[];
  readonly status: string;
  readonly statusDetail: string | undefined;
  readonly type: string | undefined;
  readonly undeliverableOffice: boolean;
}

interface RawProfile {
  accounts?: { next_due?: string; overdue?: boolean };
  company_name?: string;
  company_number?: string;
  company_status?: string;
  company_status_detail?: string;
  confirmation_statement?: { overdue?: boolean };
  date_of_creation?: string;
  has_been_liquidated?: boolean;
  has_charges?: boolean;
  has_insolvency_history?: boolean;
  jurisdiction?: string;
  previous_company_names?: { name?: string }[];
  registered_office_is_in_dispute?: boolean;
  sic_codes?: string[];
  type?: string;
  undeliverable_registered_office_address?: boolean;
}

function authHeader(): Record<string, string> {
  const spec = providerById('companies-house');
  /* c8 ignore next -- the registry always contains 'companies-house'. */
  if (!spec) throw new Error('Companies House spec missing from the registry.');
  // HTTP Basic with the key as username and an empty password. Sent as a
  // header, so the key never reaches a URL or a log line.
  const encoded = Buffer.from(`${requireCredential(spec)}:`).toString('base64');
  return { authorization: `Basic ${encoded}` };
}

export interface CompanyHit {
  readonly companyNumber: string;
  readonly description: string;
  readonly title: string;
}

/** Free-text company search. Numbers are zero-padded to eight digits. */
export async function searchCompanies(
  query: string,
  limit = 20
): Promise<CompanyHit[]> {
  const data = await cached(
    'ch-search',
    `${query.toLowerCase()}/${limit}`,
    TTL_SEARCH,
    () =>
      fetchJson<{
        items?: {
          company_number?: string;
          description?: string;
          title?: string;
        }[];
      }>(`${API}/search/companies`, {
        ...CH_RATE,
        headers: authHeader(),
        searchParams: { items_per_page: String(limit), q: query }
      })
  );

  return (data.items ?? []).map(item => ({
    companyNumber: item.company_number ?? '',
    description: item.description?.trim() ?? '',
    title: item.title?.trim() ?? ''
  }));
}

/** Company numbers are eight characters, zero-padded, and may carry a prefix. */
export function normaliseCompanyNumber(input: string): string {
  const trimmed = input.trim().toUpperCase();
  // Prefixed numbers (SC, NI, OC…) are already the right length.
  return /^\d+$/.test(trimmed) ? trimmed.padStart(8, '0') : trimmed;
}

export async function companyProfile(
  companyNumber: string
): Promise<CompanyProfile> {
  const number = normaliseCompanyNumber(companyNumber);

  const raw = await cached('ch-profile', number, TTL_PROFILE, () =>
    fetchJson<RawProfile>(`${API}/company/${encodeURIComponent(number)}`, {
      ...CH_RATE,
      headers: authHeader()
    })
  );

  return {
    accountsNextDue: raw.accounts?.next_due,
    accountsOverdue: raw.accounts?.overdue === true,
    companyName: raw.company_name?.trim() ?? '',
    companyNumber: raw.company_number ?? number,
    confirmationOverdue: raw.confirmation_statement?.overdue === true,
    hasBeenLiquidated: raw.has_been_liquidated === true,
    hasCharges: raw.has_charges === true,
    hasInsolvencyHistory: raw.has_insolvency_history === true,
    incorporatedOn: raw.date_of_creation,
    jurisdiction: raw.jurisdiction,
    officeInDispute: raw.registered_office_is_in_dispute === true,
    previousNames: (raw.previous_company_names ?? [])
      .map(entry => entry.name?.trim() ?? '')
      .filter(Boolean),
    sicCodes: raw.sic_codes ?? [],
    status: raw.company_status ?? 'unknown',
    statusDetail: raw.company_status_detail,
    type: raw.type,
    undeliverableOffice: raw.undeliverable_registered_office_address === true
  };
}

/**
 * Statuses that end the analysis. A company in liquidation or administration
 * is being wound up or restructured, and a balance sheet filed before that
 * describes a company that no longer exists in the same form — the same reason
 * a Form 25 disqualifies a US name.
 */
const FATAL_STATUS = new Set([
  'administration',
  'closed',
  'converted-closed',
  'dissolved',
  'insolvency-proceedings',
  'liquidation',
  'receivership',
  'removed',
  'voluntary-arrangement'
]);

/** Derives the register's adverse findings. Pure, so it is directly testable. */
export function registerFlags(profile: CompanyProfile): RegisterFlag[] {
  const flags: RegisterFlag[] = [];

  if (FATAL_STATUS.has(profile.status)) {
    flags.push({
      detail:
        `Companies House records this company as "${profile.status}". Whatever ` +
        'the last accounts said, they describe a company that is being wound ' +
        'up, restructured or has ceased to exist.',
      label: `Status: ${profile.status}`,
      severity: 'disqualify'
    });
  }

  if (profile.statusDetail === 'active-proposal-to-strike-off') {
    flags.push({
      detail:
        'The registrar has proposed striking the company off the register. ' +
        'Absent an objection this ends in dissolution, and assets pass to the ' +
        'Crown as bona vacantia.',
      label: 'Proposal to strike off',
      severity: 'disqualify'
    });
  }

  if (profile.accountsOverdue) {
    flags.push({
      detail:
        `Statutory accounts are overdue (were due ${profile.accountsNextDue ?? 'unknown'}). ` +
        'The direct UK analogue of an NT 10-K: the figures a thesis rests on ' +
        'are late, and lateness correlates with the reason being bad.',
      label: 'Accounts overdue',
      severity: 'investigate'
    });
  }

  if (profile.confirmationOverdue) {
    flags.push({
      detail:
        'The annual confirmation statement is overdue. On its own it is ' +
        'administrative, but it is the first step toward a strike-off.',
      label: 'Confirmation statement overdue',
      severity: 'investigate'
    });
  }

  if (profile.hasInsolvencyHistory || profile.hasBeenLiquidated) {
    flags.push({
      detail:
        'The register carries insolvency history. Read what happened before ' +
        'trusting the current balance sheet.',
      label: 'Insolvency history',
      severity: 'investigate'
    });
  }

  if (profile.hasCharges) {
    flags.push({
      detail:
        'Registered charges mean assets are pledged as security. Schloss ' +
        'wanted no real debt, and a charge is debt with a claim on specific ' +
        'assets ahead of shareholders — check the charges register for whether ' +
        'any remain outstanding.',
      label: 'Registered charges',
      severity: 'note'
    });
  }

  if (profile.officeInDispute || profile.undeliverableOffice) {
    flags.push({
      detail:
        'The registered office is in dispute or mail to it is undeliverable. ' +
        'Not adverse by itself, but a company the registrar cannot reach is ' +
        'not being run carefully.',
      label: 'Registered office problem',
      severity: 'note'
    });
  }

  if (profile.previousNames.length > 0) {
    flags.push({
      detail:
        `Previously known as: ${profile.previousNames.join('; ')}. Renaming is ` +
        'routine after a restructuring and also a way to shed a reputation; ' +
        'either way, search the old names before concluding the history is clean.',
      label: 'Previous names',
      severity: 'note'
    });
  }

  return sortBy(flags, flag =>
    ['disqualify', 'investigate', 'note'].indexOf(flag.severity)
  );
}
