import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeIndex,
  indexState,
  isStale,
  openIndexForTest,
  searchTrades,
  storeReportForTest,
  topTickers
} from './congress-index.ts';

import type { DisclosedTrade, SenateReportRef } from './congress.ts';

const ref = (url: string, member: string, filed: string): SenateReportRef => ({
  filedDate: filed,
  member,
  url
});

const trade = (over: Partial<DisclosedTrade> = {}): DisclosedTrade => ({
  amount: '$1,001 - $15,000',
  assetName: 'Test Corp Common Stock',
  assetType: 'Stock',
  chamber: 'senate',
  filedDate: '2026-09-01',
  member: 'Jane Doe',
  owner: 'Self',
  reportUrl: 'https://example.test/ptr/1/',
  ticker: 'TEST',
  transactionDate: '2026-08-01',
  type: 'Purchase',
  ...over
});

beforeEach(() => {
  openIndexForTest(
    join(mkdtempSync(join(tmpdir(), 'cb-idx-')), 'congress.sqlite')
  );
});

afterEach(() => {
  closeIndex();
  delete process.env.CIGAR_BUTT_CONGRESS_DB;
});

describe('congress index', () => {
  it('starts empty and stale', () => {
    const state = indexState();

    expect(state.reports).toBe(0);
    expect(state.trades).toBe(0);
    // Never built is not the same as fresh; a search must not trust it.
    expect(isStale(86_400)).toBe(true);
  });

  it('stores a report and finds its trades by ticker', () => {
    storeReportForTest(ref('u1', 'Jane Doe', '2026-09-01'), [trade()]);

    const hits = searchTrades({ ticker: 'TEST' });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.member).toBe('Jane Doe');
  });

  it('matches a ticker case-insensitively', () => {
    storeReportForTest(ref('u1', 'Jane Doe', '2026-09-01'), [trade()]);

    expect(searchTrades({ ticker: 'test' })).toHaveLength(1);
    expect(searchTrades({ ticker: ' TeSt ' })).toHaveLength(1);
  });

  it('matches a member by substring, since filings carry middle initials', () => {
    storeReportForTest(ref('u1', 'Cory A Booker', '2026-09-01'), [
      trade({ member: 'Cory A Booker' })
    ]);

    expect(searchTrades({ member: 'Booker' })).toHaveLength(1);
    expect(searchTrades({ member: 'booker' })).toHaveLength(1);
    expect(searchTrades({ member: 'Barrasso' })).toHaveLength(0);
  });

  it('filters by transaction date, not filing date', () => {
    // The two differ by weeks, and a caller asking "traded since X" means the
    // trade, not the paperwork.
    storeReportForTest(ref('u1', 'Jane Doe', '2026-09-01'), [
      trade({ filedDate: '2026-09-01', transactionDate: '2026-01-15' })
    ]);

    expect(searchTrades({ since: '2026-08-01' })).toHaveLength(0);
    expect(searchTrades({ since: '2026-01-01' })).toHaveLength(1);
  });

  it('returns newest transactions first', () => {
    storeReportForTest(ref('u1', 'Jane Doe', '2026-09-01'), [
      trade({ transactionDate: '2026-01-01' }),
      trade({ transactionDate: '2026-08-01' })
    ]);

    expect(searchTrades({}).map(hit => hit.transactionDate)).toEqual([
      '2026-08-01',
      '2026-01-01'
    ]);
  });

  it('keeps a holding with no ticker searchable by member but not by ticker', () => {
    // Bonds and private holdings routinely have no ticker; dropping them would
    // understate a member's activity.
    storeReportForTest(ref('u1', 'Jane Doe', '2026-09-01'), [
      trade({ assetType: 'Corporate Bond', ticker: undefined })
    ]);

    expect(searchTrades({ member: 'Jane' })).toHaveLength(1);
    expect(searchTrades({ member: 'Jane' })[0]?.ticker).toBeUndefined();
    expect(indexState().tickers).toBe(0);
  });

  it('re-storing a report replaces its rows rather than duplicating them', () => {
    const report = ref('u1', 'Jane Doe', '2026-09-01');
    storeReportForTest(report, [trade(), trade({ ticker: 'OTHER' })]);
    storeReportForTest(report, [trade()]);

    expect(indexState().reports).toBe(1);
    expect(searchTrades({ ticker: 'TEST' })).toHaveLength(1);
  });

  it('ranks tickers by trade count and distinct members', () => {
    storeReportForTest(ref('u1', 'Jane Doe', '2026-09-01'), [
      trade({ member: 'Jane Doe', ticker: 'AAA' }),
      trade({ member: 'Jane Doe', ticker: 'AAA' })
    ]);
    storeReportForTest(ref('u2', 'John Roe', '2026-09-02'), [
      trade({ member: 'John Roe', ticker: 'AAA' }),
      trade({ member: 'John Roe', ticker: 'BBB' })
    ]);

    const [top] = topTickers(5);
    expect(top).toEqual({ members: 2, ticker: 'AAA', trades: 3 });
  });

  it('reports the filing range it covers', () => {
    storeReportForTest(ref('u1', 'Jane Doe', '2026-05-01'), [trade()]);
    storeReportForTest(ref('u2', 'John Roe', '2026-09-01'), [trade()]);

    const state = indexState();
    expect(state.oldestFiled).toBe('2026-05-01');
    expect(state.newestFiled).toBe('2026-09-01');
  });
});
