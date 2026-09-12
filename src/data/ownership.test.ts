import { describe, expect, it } from 'vitest';

import { isOpenMarket, parseFiledBy, TRANSACTION_CODES } from './ownership.ts';

describe('isOpenMarket', () => {
  it('counts a purchase and a sale', () => {
    expect(isOpenMarket('P')).toBe(true);
    expect(isOpenMarket('S')).toBe(true);
  });

  it('excludes a grant, which is compensation rather than conviction', () => {
    // Counting rows instead of codes turns a routine option award into
    // "insiders are buying", which is the standard way this signal is faked.
    expect(isOpenMarket('A')).toBe(false);
  });

  it('excludes tax withholding, which is not a decision to sell', () => {
    expect(isOpenMarket('F')).toBe(false);
  });

  it('excludes an option exercise, priced at a strike set years earlier', () => {
    expect(isOpenMarket('M')).toBe(false);
  });

  it('describes the two codes that get misread', () => {
    expect(TRANSACTION_CODES['A']).toContain('grant');
    expect(TRANSACTION_CODES['F']).toContain('tax');
  });
});

describe('parseFiledBy', () => {
  const header = `<SEC-HEADER>
ACCESSION NUMBER:		0001193125-26-328603
CONFORMED SUBMISSION TYPE:	SCHEDULE 13D/A
SUBJECT COMPANY:
	COMPANY DATA:
		COMPANY CONFORMED NAME:			TENAX THERAPEUTICS, INC.
		CENTRAL INDEX KEY:			0000034956
FILED BY:
	COMPANY DATA:
		COMPANY CONFORMED NAME:			Giordano Christopher Thomas
		CENTRAL INDEX KEY:			0001999999
</SEC-HEADER>`;

  it('takes the filer, not the subject company', () => {
    // Both appear under COMPANY CONFORMED NAME and the issuer comes first, so
    // a naive first match reports the company as its own 5% holder.
    expect(parseFiledBy(header)).toBe('Giordano Christopher Thomas');
  });

  it('returns undefined rather than guessing when there is no filer block', () => {
    expect(
      parseFiledBy('<SEC-HEADER>nothing useful</SEC-HEADER>')
    ).toBeUndefined();
  });

  it('strips markup the headers page wraps around the name', () => {
    expect(
      parseFiledBy('FILED BY:\n COMPANY CONFORMED NAME: <b>BVF Inc</b>')
    ).toBe('BVF Inc');
  });
});
