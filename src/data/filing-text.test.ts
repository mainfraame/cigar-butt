import { describe, expect, it } from 'vitest';

import {
  extractItem,
  isHeadingOnly,
  parseFills,
  plainText
} from './filing-text.ts';

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

describe('extractItem on whole-number headings', () => {
  const schedule =
    'Item 3. Source of Funds. Acquired for $7,382,683. ' +
    'Item 4. Purpose of Transaction. The Reporting Persons intend to engage ' +
    'with the board regarding capital allocation. ' +
    'Item 5. Interest in Securities. 6.0% of the class.';

  it('scopes a 13D item, which is numbered without a decimal', () => {
    // A terminator demanding a decimal ran the section to the end of the
    // document, burying the one item that says what an activist wants.
    const section = extractItem(schedule, '4');

    expect(section).toContain('capital allocation');
    expect(section).not.toContain('Interest in Securities');
  });

  it('does not answer a bare number with a decimal heading', () => {
    // "Item 4" must not match inside "Item 4.01", which is a different item
    // in a different form.
    expect(extractItem('Item 4.01 Change of accountant.', '4')).toBeUndefined();
  });

  it('still terminates an 8-K section at the next decimal heading', () => {
    const eightK = 'Item 3.01 Compliance regained. Item 7.01 A press release.';

    expect(extractItem(eightK, '3.01')).toBe('Item 3.01 Compliance regained.');
  });
});

describe('isHeadingOnly', () => {
  it('detects an item an amendment did not restate', () => {
    // A 13D/A amending only the holdings still carries every heading, so
    // Item 4 comes back as the bare words — which reads as if the activist
    // stated no purpose.
    expect(isHeadingOnly('Item 4. Purpose of Transaction', '4')).toBe(true);
  });

  it('does not flag an item that actually says something', () => {
    expect(
      isHeadingOnly(
        'Item 4. Purpose of Transaction The Reporting Persons intend to ' +
          'engage with the board regarding capital allocation and costs.',
        '4'
      )
    ).toBe(false);
  });

  it('handles an 8-K decimal heading with no body', () => {
    expect(isHeadingOnly('Item 3.01', '3.01')).toBe(true);
  });
});
