import { describe, expect, it } from 'vitest';

import { parseFinancialRows, toSecCode } from './edinet.ts';

const HEADER = [
  '要素ID',
  '項目名',
  'コンテキストID',
  '相対年度',
  '連結・個別',
  '期間・時点',
  'ユニットID',
  '単位',
  '値'
];

const row = (
  element: string,
  context: string,
  value: string,
  label = 'ラベル'
): string[] => [element, label, context, '', '', '', 'JPY', '円', value];

describe('toSecCode', () => {
  it('pads a four-digit TSE ticker to the five-digit securities code', () => {
    // EDINET stores Toyota's 7203 as 72030; the trailing digit is a check
    // character, so a raw ticker never matches.
    expect(toSecCode('7203')).toBe('72030');
  });

  it('leaves an already-five-digit code alone', () => {
    expect(toSecCode('72030')).toBe('72030');
  });

  it('strips non-digits', () => {
    expect(toSecCode(' 7203.T ')).toBe('72030');
  });
});

describe('parseFinancialRows', () => {
  it('reads consolidated current-period instants', () => {
    const result = parseFinancialRows([
      HEADER,
      row('jppfs_cor:CurrentAssets', 'CurrentYearInstant', '1000'),
      row('jppfs_cor:Liabilities', 'CurrentYearInstant', '400'),
      row('jppfs_cor:ShareholdersEquity', 'CurrentYearInstant', '600')
    ]);

    expect(result.items['assetsCurrent']?.value.toNumber()).toBe(1000);
    expect(result.items['liabilities']?.value.toNumber()).toBe(400);
    expect(result.items['stockholdersEquity']?.value.toNumber()).toBe(600);
  });

  it('ignores prior-year and parent-only duplicates', () => {
    // EDINET emits every figure several times over. Taking the wrong context
    // silently reports last year, or the parent company alone.
    const result = parseFinancialRows([
      HEADER,
      row('jppfs_cor:CurrentAssets', 'Prior1YearInstant', '999'),
      row(
        'jppfs_cor:CurrentAssets',
        'CurrentYearInstant_NonConsolidatedMember',
        '888'
      ),
      row('jppfs_cor:CurrentAssets', 'CurrentYearInstant', '1000')
    ]);

    expect(result.items['assetsCurrent']?.value.toNumber()).toBe(1000);
  });

  it('falls back through the candidate elements in order', () => {
    // ShareholdersEquity is preferred over NetAssets: net assets includes
    // minority interests, which a common holder does not own.
    const withBoth = parseFinancialRows([
      HEADER,
      row('jppfs_cor:NetAssets', 'CurrentYearInstant', '700'),
      row('jppfs_cor:ShareholdersEquity', 'CurrentYearInstant', '600')
    ]);
    expect(withBoth.items['stockholdersEquity']?.value.toNumber()).toBe(600);

    const netAssetsOnly = parseFinancialRows([
      HEADER,
      row('jppfs_cor:NetAssets', 'CurrentYearInstant', '700')
    ]);
    expect(netAssetsOnly.items['stockholdersEquity']?.value.toNumber()).toBe(
      700
    );
  });

  it('reads IFRS elements for filers who have adopted them', () => {
    const result = parseFinancialRows([
      HEADER,
      row('ifrs-full:CurrentAssets', 'CurrentYearInstant', '1200'),
      row('ifrs-full:Liabilities', 'CurrentYearInstant', '500')
    ]);

    expect(result.items['assetsCurrent']?.value.toNumber()).toBe(1200);
    expect(result.items['liabilities']?.value.toNumber()).toBe(500);
  });

  it('reports a concept it could not find rather than defaulting it', () => {
    const result = parseFinancialRows([
      HEADER,
      row('jppfs_cor:CurrentAssets', 'CurrentYearInstant', '1000')
    ]);

    expect(result.missing).toContain('liabilities');
    expect(result.items['liabilities']).toBeUndefined();
  });

  it('skips a row whose value is not a number', () => {
    // Suppressed figures are filed as a dash rather than omitted.
    const result = parseFinancialRows([
      HEADER,
      row('jppfs_cor:Liabilities', 'CurrentYearInstant', '－'),
      row('jppfs_cor:Liabilities', 'CurrentYearInstant', '400')
    ]);

    expect(result.items['liabilities']?.value.toNumber()).toBe(400);
  });

  it('throws on an unexpected column layout instead of returning nothing', () => {
    expect(() =>
      parseFinancialRows([
        ['a', 'b'],
        ['1', '2']
      ])
    ).toThrow(/Unexpected CSV layout/);
  });
});
