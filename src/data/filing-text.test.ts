import { describe, expect, it } from 'vitest';

import { extractItem, plainText } from './filing-text.ts';

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
