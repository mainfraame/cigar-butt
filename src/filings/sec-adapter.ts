import { scanDisqualifiers } from '../analysis/disqualifiers.ts';
import { fetchBalanceSheet } from '../analysis/metrics.ts';
import { providerById } from '../config/providers.ts';
import { getCredential } from '../config/store.ts';
import { resolveTicker, submissions } from '../data/sec.ts';
import {
  bySeverity,
  summarise,
  type FilingFlag,
  type FilingsAdapter
} from './contract.ts';

/**
 * SEC EDGAR, expressed in the jurisdiction-neutral contract.
 *
 * The disqualifier scan and the asset tests already existed; this only
 * translates their shapes. The `Flag` those produce carries a `form` and a
 * `reason` where the contract wants a `label` and a `detail` — the same
 * judgement, different vocabulary.
 */
export const secAdapter: FilingsAdapter = {
  balanceSheet: async id => {
    const { periodEnd, sheet, stale } = await fetchBalanceSheet(id);
    return { periodEnd, sheet, stale };
  },

  disqualifiers: async id => {
    const summary = await submissions(id);
    const report = scanDisqualifiers(summary);

    const flags: FilingFlag[] = report.flags.map(flag => ({
      date: flag.date === 'n/a' ? undefined : flag.date,
      detail: flag.reason,
      label: flag.form,
      severity: flag.severity,
      source: flag.source === 'n/a' ? undefined : flag.source
    }));

    return {
      clear: report.clear,
      company: {
        id: summary.cik,
        jurisdiction: 'US',
        name: summary.name,
        sic: summary.sic,
        ticker: summary.tickers[0]
      },
      flags: bySeverity(flags),
      summary: summarise(flags)
    };
  },

  isConfigured: () => {
    const spec = providerById('sec');
    return spec ? getCredential(spec.envVar) !== undefined : false;
  },

  jurisdiction: 'US',

  label: 'SEC EDGAR (United States)',

  resolve: async query => {
    const entry = await resolveTicker(query);
    return {
      id: String(entry.cik_str),
      jurisdiction: 'US',
      name: entry.title,
      sic: undefined,
      ticker: entry.ticker
    };
  }
};
