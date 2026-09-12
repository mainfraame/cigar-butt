import { describe, expect, it } from 'vitest';

import { extractItem, parseFills, plainText } from './filing-text.ts';

describe('plainText', () => {
  it('drops script and style bodies rather than reading them as prose', () => {
    expect(
      plainText('<style>.a{color:red}</style><p>Item 3.01 happened</p>')
    ).toBe('Item 3.01 happened');
  });

  it('keeps a word boundary at a block edge', () => {
    // Without this, adjacent table cells merge into one nonsense word.
    expect(plainText('<td>regained</td><td>compliance</td>')).toBe(
      'regained compliance'
    );
  });

  it('decodes the entities filings actually use', () => {
    expect(plainText('<p>ADSs&nbsp;&amp; ordinary shares&#39; ratio</p>')).toBe(
      "ADSs & ordinary shares' ratio"
    );
  });
});

describe('extractItem', () => {
  const body =
    'Item 3.01 Notice of Delisting. The Company regained compliance with the ' +
    'minimum bid price requirement. Item 7.01 Regulation FD Disclosure. A ' +
    'press release is furnished. Item 9.01 Exhibits.';

  it('returns only the requested section', () => {
    const section = extractItem(body, '3.01');

    expect(section).toContain('regained compliance');
    expect(section).not.toContain('Regulation FD');
  });

  it('does not stop at the heading it started from', () => {
    // The heading matches the same pattern as the terminator, so a naive
    // search returns an empty section.
    expect(extractItem(body, '3.01')?.length).toBeGreaterThan(40);
  });

  it('runs to the end when the item is last', () => {
    expect(extractItem(body, '9.01')).toBe('Item 9.01 Exhibits.');
  });

  it('returns undefined when the heading is absent, rather than guessing', () => {
    // Some filers omit the heading even though the index lists the item, and
    // handing back an arbitrary slice would be worse than saying so.
    expect(extractItem(body, '4.02')).toBeUndefined();
  });

  it('treats the dot as a literal, not a wildcard', () => {
    expect(extractItem('Item 3901 something', '3.01')).toBeUndefined();
  });
});

describe('parseFills', () => {
  const report =
    'Schedule of Transactions in ADSs Side Price Amount Trade Date ' +
    'Sell 14.01000 336 2026-08-24 ' +
    'Sell 14.06000 100 2026-08-24 ' +
    'Buy 13.50000 1000 2026-08-25 ';

  it('totals a schedule that reports fills and no total', () => {
    const summary = parseFills(report)!;

    expect(summary.fills).toBe(3);
    expect(summary.sold.toString()).toBe('436');
    expect(summary.bought.toString()).toBe('1000');
  });

  it('reports the price range and a volume-weighted average', () => {
    const summary = parseFills(report)!;

    expect(summary.lowPrice.toString()).toBe('13.5');
    expect(summary.highPrice.toString()).toBe('14.06');
    // (14.01*336 + 14.06*100 + 13.50*1000) / 1436 = 19,613.36 / 1,436
    expect(Number(summary.vwap?.toFixed(4))).toBeCloseTo(13.6583, 3);
  });

  it('spans the dates it actually saw', () => {
    const summary = parseFills(report)!;

    expect(summary.from).toBe('2026-08-24');
    expect(summary.to).toBe('2026-08-25');
  });

  it('handles thousands separators in the amounts', () => {
    const summary = parseFills('Sell 14.00000 4,600 2026-08-24')!;

    expect(summary.sold.toString()).toBe('4600');
  });

  it('returns nothing for a document that is not a fills schedule', () => {
    // No prescribed format exists, so an unrecognised layout must yield
    // nothing rather than a total assembled from whatever matched.
    expect(
      parseFills('Item 3.01 The Company regained compliance.')
    ).toBeUndefined();
  });
});
