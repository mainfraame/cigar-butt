import { describe, expect, it } from 'vitest';

import { realisesGain } from './contract.ts';
import { alpacaTaxTreatment, etradeTaxTreatment } from './tax.ts';

describe('etradeTaxTreatment', () => {
  it.each([
    'ROTHIRA',
    'ROTH_INDIVIDUAL_K',
    'COVERDELL_ESA',
    'CONVERSION_ROTH_IRA'
  ])('%s is roth', type => {
    expect(etradeTaxTreatment(type)).toBe('roth');
  });

  it.each(['IRA', 'IRA_ROLLOVER', 'SEPIRA', 'SIMPLE_IRA', 'PROFIT_SHARING'])(
    '%s is tax-deferred',
    type => {
      expect(etradeTaxTreatment(type)).toBe('tax-deferred');
    }
  );

  it.each(['INDIVIDUAL', 'JTWROS', 'TRUST', 'CORPORATION', 'LLC_PARTNERSHIP'])(
    '%s is taxable',
    type => {
      expect(etradeTaxTreatment(type)).toBe('taxable');
    }
  );

  it.each(['CASH', 'MARGIN', 'PDT_ACCOUNT', 'OTHER', 'INVALID', 'CREDITCARD'])(
    '%s is unknown, not taxable',
    type => {
      // This is the whole point. E*TRADE's accountType mixes registration,
      // settlement mode and banking products, and the sandbox returns MARGIN
      // and CASH. Letting those fall through to taxable would be confidently
      // wrong on the only values we have actually observed.
      expect(etradeTaxTreatment(type)).toBe('unknown');
    }
  );

  it('uses accountMode when the type token is unrecognised', () => {
    // IRACD and PREFIRACD are retirement money whose flavour is not stated. We
    // know a sale realises nothing; we do not know whether it is Roth.
    expect(etradeTaxTreatment('IRACD', 'IRA')).toBe('tax-sheltered');
    expect(etradeTaxTreatment('PREFIRACD', 'IRA')).toBe('tax-sheltered');
  });

  it('lets an explicit type beat accountMode', () => {
    expect(etradeTaxTreatment('ROTHIRA', 'IRA')).toBe('roth');
  });

  it('is unknown for a missing type', () => {
    expect(etradeTaxTreatment(undefined)).toBe('unknown');
    expect(etradeTaxTreatment('')).toBe('unknown');
  });

  it('ignores case and surrounding whitespace', () => {
    expect(etradeTaxTreatment('  rothira ')).toBe('roth');
  });
});

describe('alpacaTaxTreatment', () => {
  it('splits an IRA by sub-type', () => {
    expect(alpacaTaxTreatment('ira', 'roth')).toBe('roth');
    expect(alpacaTaxTreatment('ira', 'traditional')).toBe('tax-deferred');
  });

  it('falls back to tax-sheltered for an IRA with no sub-type', () => {
    expect(alpacaTaxTreatment('ira')).toBe('tax-sheltered');
  });

  it('treats an HSA as roth, since qualified withdrawals are untaxed', () => {
    expect(alpacaTaxTreatment('hsa')).toBe('roth');
  });

  it.each(['trading', 'joint', 'custodial', 'trust'])('%s is taxable', type => {
    expect(alpacaTaxTreatment(type)).toBe('taxable');
  });

  it('is unknown for an omnibus or absent type', () => {
    expect(alpacaTaxTreatment('omnibus_non_disclosed')).toBe('unknown');
    expect(alpacaTaxTreatment(undefined)).toBe('unknown');
  });
});

describe('realisesGain', () => {
  it('is true only for a taxable account', () => {
    expect(realisesGain('taxable')).toBe(true);
  });

  it('is false for every sheltered flavour', () => {
    expect(realisesGain('roth')).toBe(false);
    expect(realisesGain('tax-deferred')).toBe(false);
    expect(realisesGain('tax-sheltered')).toBe(false);
  });

  it('is undefined for unknown, not false', () => {
    // Three-state, deliberately: "we do not know" is not "no gain", and a
    // caller collapsing it to false would understate the cost of a plan.
    expect(realisesGain('unknown')).toBeUndefined();
  });
});
