import { describe, expect, it } from 'vitest';

import { isoDate, normaliseName, sectionRows } from './congress.ts';

/** The eFD annual report is one page of headed tables, some of them empty. */
const REPORT = `
  <h3>Part 7. Liabilities</h3>
  <table><tbody>
    <tr><td></td><td>1</td><td>Bank</td><td>Mortgage</td></tr>
  </tbody></table>
  <h3>Part 8. Positions</h3>
  <p>None disclosed.</p>
  <h3>Part 9. Agreements</h3>
  <table><tbody>
    <tr><td></td><td>1</td><td>Nov 2012</td><td>Adams Media</td><td>Royalty</td><td>n/a</td></tr>
  </tbody></table>
`;

describe('sectionRows', () => {
  it('reads the table belonging to a section', () => {
    const rows = sectionRows(REPORT, 'Part 9. Agreements');

    expect(rows).toHaveLength(1);
    expect(rows[0]?.[3]).toBe('Adams Media');
  });

  it('returns nothing for a section the filer left empty', () => {
    // The regression this guards: with no table of its own, Part 8 used to walk
    // forward and adopt Part 9's, reporting royalty agreements as board seats
    // with every column shifted and nothing to flag it.
    expect(sectionRows(REPORT, 'Part 8. Positions')).toEqual([]);
  });

  it('returns nothing for a heading that is not present', () => {
    expect(sectionRows(REPORT, 'Part 42. Nonexistent')).toEqual([]);
  });

  it('strips tags and collapses whitespace inside a cell', () => {
    const rows = sectionRows(
      '<h3>Part 1. X</h3><table><tbody><tr><td>a<br>\n  <em>b</em></td></tr></tbody></table>',
      'Part 1. X'
    );

    expect(rows[0]?.[0]).toBe('a b');
  });
});

describe('isoDate', () => {
  it('converts the eFD MM/DD/YYYY format', () => {
    expect(isoDate('09/11/2026')).toBe('2026-09-11');
  });

  it('leaves an unrecognised value alone rather than inventing a date', () => {
    expect(isoDate('--')).toBe('--');
    expect(isoDate('2026-09-11')).toBe('2026-09-11');
  });
});

describe('normaliseName', () => {
  it.each([
    ['Cory A Booker', 'Cory Booker'],
    ['Boozman, John', 'John Boozman'],
    ['James Conley Justice, II', 'James Conley Justice II'],
    ['Senator Sheldon Whitehouse', 'Sheldon Whitehouse']
  ])('matches %s to %s', (left, right) => {
    // Disclosure sources and the legislator roster spell names differently;
    // the committee cross-reference is worthless if they do not join.
    expect(normaliseName(left)).toBe(normaliseName(right));
  });

  it('does not collapse two different people', () => {
    expect(normaliseName('John Boozman')).not.toBe(
      normaliseName('John Barrasso')
    );
  });
});
