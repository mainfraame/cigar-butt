import { providerById } from '../config/providers.ts';
import { getCredential } from '../config/store.ts';
import {
  companyProfile,
  normaliseCompanyNumber,
  registerFlags,
  searchCompanies
} from '../data/companies-house.ts';
import { bySeverity, summarise, type FilingsAdapter } from './contract.ts';

/**
 * UK Companies House.
 *
 * Note the absent `balanceSheet`: the register genuinely cannot produce one.
 * UK accounts are filed as iXBRL or PDF documents rather than structured data,
 * small companies may file abridged accounts carrying almost nothing, and a
 * listed company's real annual report goes to the FCA's National Storage
 * Mechanism instead. The method is missing rather than present-and-empty so
 * the gap is a compile-time fact rather than a runtime surprise.
 */
export const companiesHouseAdapter: FilingsAdapter = {
  disqualifiers: async id => {
    const profile = await companyProfile(id);
    const flags = registerFlags(profile).map(flag => ({
      // The register states a status rather than dating it; only the accounts
      // deadline carries a date, and it belongs to that flag alone.
      date: undefined,
      detail: flag.detail,
      label: flag.label,
      severity: flag.severity,
      source: profile.companyNumber
    }));

    return {
      clear: !flags.some(flag => flag.severity === 'disqualify'),
      company: {
        id: profile.companyNumber,
        jurisdiction: 'UK',
        name: profile.companyName,
        sic: profile.sicCodes[0],
        ticker: undefined
      },
      flags: bySeverity(flags),
      summary: summarise(flags)
    };
  },

  isConfigured: () => {
    const spec = providerById('companies-house');
    return spec ? getCredential(spec.envVar) !== undefined : false;
  },

  jurisdiction: 'UK',

  label: 'Companies House (United Kingdom)',

  resolve: async query => {
    // A company number resolves directly; anything else is a name search, and
    // the first hit is taken with the name echoed back so a wrong match is
    // visible rather than silent.
    const asNumber = normaliseCompanyNumber(query);
    if (/^[A-Z]{0,2}\d{6,8}$/.test(asNumber)) {
      const profile = await companyProfile(asNumber);
      return {
        id: profile.companyNumber,
        jurisdiction: 'UK',
        name: profile.companyName,
        sic: profile.sicCodes[0],
        ticker: undefined
      };
    }

    const [hit] = await searchCompanies(query, 1);
    if (!hit) throw new Error(`No UK company matching "${query}".`);
    return {
      id: hit.companyNumber,
      jurisdiction: 'UK',
      name: hit.title,
      sic: undefined,
      ticker: undefined
    };
  }
};
