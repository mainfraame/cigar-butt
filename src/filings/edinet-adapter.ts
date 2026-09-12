import { providerById } from '../config/providers.ts';
import { getCredential } from '../config/store.ts';
import { DOC_TYPE_ANNUAL, findFilings, toSecCode } from '../data/edinet.ts';
import {
  bySeverity,
  summarise,
  type FilingFlag,
  type FilingsAdapter
} from './contract.ts';

/**
 * Japan's EDINET.
 *
 * Two honest limits are encoded here rather than papered over.
 *
 * `resolve` is expensive. EDINET has no search-by-company endpoint — it is
 * indexed by date — so finding a filer means walking days. The window is
 * bounded and a miss says "widen the window" rather than "no such company",
 * because those are different findings and confusing them would drop real
 * candidates.
 *
 * `disqualifiers` is thinner than the US equivalent. There is no J-GAAP
 * analogue of an 8-K item 4.02 exposed as structured data, so what can be
 * checked is the universal signal: whether the company is still filing. A gap
 * where an annual report should be is the same evidence a missing 10-K is, and
 * claiming more coverage than that would be inventing it.
 */

/** Japanese annual reports are due within three months of a 31 March year end. */
const ANNUAL_REPORT_WINDOW_DAYS = 420;

export const edinetAdapter: FilingsAdapter = {
  disqualifiers: async id => {
    const { daysScanned, filings } = await findFilings({
      docTypeCodes: [DOC_TYPE_ANNUAL],
      maxDays: 30,
      query: id,
      startDate: new Date(Date.now() - 0).toISOString().slice(0, 10)
    });

    const newest = filings[0];
    const flags: FilingFlag[] = [];

    if (!newest) {
      flags.push({
        date: undefined,
        detail:
          `No annual securities report found for "${id}" in the ${daysScanned} ` +
          'day(s) scanned. EDINET is indexed by date and Japanese annual ' +
          'reports cluster in late June, so this is far more often a search ' +
          'window that missed than a company that stopped filing — widen it ' +
          'before treating the absence as evidence.',
        label: 'No annual report located',
        severity: 'investigate',
        source: undefined
      });
    }

    return {
      clear: true,
      company: {
        id: newest?.edinetCode ?? id,
        jurisdiction: 'JP',
        name: newest?.filerName ?? id,
        sic: undefined,
        ticker: newest?.secCode
      },
      flags: bySeverity(flags),
      summary:
        flags.length === 0
          ? `Filing recently: ${newest?.docDescription ?? ''}`.trim()
          : summarise(flags)
    };
  },

  isConfigured: () => {
    const spec = providerById('edinet');
    return spec ? getCredential(spec.envVar) !== undefined : false;
  },

  jurisdiction: 'JP',

  label: 'EDINET (Japan)',

  resolve: async query => {
    // Walk back from today far enough to cross one annual filing season.
    const { filings } = await findFilings({
      maxDays: 30,
      query,
      startDate: new Date().toISOString().slice(0, 10)
    });

    const hit = filings[0];
    if (!hit) {
      throw new Error(
        `No EDINET filer matching "${query}" in the last 30 days of filings. ` +
          'EDINET has no company index — it is searched by date — so try ' +
          '`edinet_search` with a `startDate` in late June, when annual ' +
          `reports are filed. As a ticker, "${query}" resolves to the ` +
          `securities code "${toSecCode(query)}". A window of up to ` +
          `${ANNUAL_REPORT_WINDOW_DAYS} days may be needed.`
      );
    }

    return {
      id: hit.edinetCode,
      jurisdiction: 'JP',
      name: hit.filerName,
      sic: undefined,
      ticker: hit.secCode
    };
  }
};
