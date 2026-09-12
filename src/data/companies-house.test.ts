import { describe, expect, it } from 'vitest';

import {
  normaliseCompanyNumber,
  registerFlags,
  type CompanyProfile
} from './companies-house.ts';

const clean: CompanyProfile = {
  accountsNextDue: '2027-03-31',
  accountsOverdue: false,
  companyName: 'TEST PLC',
  companyNumber: '00000001',
  confirmationOverdue: false,
  hasBeenLiquidated: false,
  hasCharges: false,
  hasInsolvencyHistory: false,
  incorporatedOn: '1990-01-01',
  jurisdiction: 'england-wales',
  officeInDispute: false,
  previousNames: [],
  sicCodes: ['47110'],
  status: 'active',
  statusDetail: undefined,
  type: 'plc',
  undeliverableOffice: false
};

const severities = (profile: CompanyProfile): string[] =>
  registerFlags(profile).map(flag => flag.severity);

describe('normaliseCompanyNumber', () => {
  it('zero-pads a short numeric company number to eight digits', () => {
    // Companies House stores Tesco as 00445790; querying 445790 returns a 404.
    expect(normaliseCompanyNumber('445790')).toBe('00445790');
  });

  it('leaves a prefixed number alone', () => {
    // Scottish and Northern Irish numbers are already the right length.
    expect(normaliseCompanyNumber('SC090312')).toBe('SC090312');
    expect(normaliseCompanyNumber('ni123456')).toBe('NI123456');
  });

  it('trims surrounding whitespace', () => {
    expect(normaliseCompanyNumber('  00445790 ')).toBe('00445790');
  });
});

describe('registerFlags', () => {
  it('finds nothing on a clean register entry', () => {
    expect(registerFlags(clean)).toEqual([]);
  });

  it.each([
    'administration',
    'dissolved',
    'insolvency-proceedings',
    'liquidation',
    'receivership',
    'voluntary-arrangement'
  ])('disqualifies on status %s', status => {
    expect(severities({ ...clean, status })).toContain('disqualify');
  });

  it('disqualifies on a proposal to strike off', () => {
    // Absent an objection this ends in dissolution and the assets pass to the
    // Crown, so the balance sheet stops being the shareholders' concern.
    const flags = registerFlags({
      ...clean,
      statusDetail: 'active-proposal-to-strike-off'
    });

    expect(flags[0]?.severity).toBe('disqualify');
    expect(flags[0]?.label).toBe('Proposal to strike off');
  });

  it('treats overdue accounts as investigate, not fatal', () => {
    // The UK analogue of an NT 10-K: late figures, not absent ones.
    const flags = registerFlags({ ...clean, accountsOverdue: true });

    expect(flags).toHaveLength(1);
    expect(flags[0]?.severity).toBe('investigate');
  });

  it('notes registered charges without disqualifying', () => {
    // Schloss wanted no real debt, and a charge is debt with a claim on
    // specific assets ahead of shareholders — but it is a fact to weigh, not
    // a thesis-killer.
    const flags = registerFlags({ ...clean, hasCharges: true });

    expect(flags[0]?.severity).toBe('note');
  });

  it('orders disqualifiers ahead of investigations and notes', () => {
    const flags = registerFlags({
      ...clean,
      accountsOverdue: true,
      hasCharges: true,
      status: 'liquidation'
    });

    expect(flags.map(flag => flag.severity)).toEqual([
      'disqualify',
      'investigate',
      'note'
    ]);
  });

  it('surfaces previous names so the old history can be searched', () => {
    const flags = registerFlags({
      ...clean,
      previousNames: ['OLD CO LIMITED']
    });

    expect(flags[0]?.detail).toContain('OLD CO LIMITED');
  });

  it('does not disqualify a company that is merely active with history', () => {
    const flags = registerFlags({ ...clean, hasInsolvencyHistory: true });

    expect(flags.map(flag => flag.severity)).not.toContain('disqualify');
  });
});
