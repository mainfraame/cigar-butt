import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { fidelityTaxTreatment } from '../broker/tax.ts';
import {
  encodePico,
  epochDate,
  parseBalance,
  parsePositionRows
} from './fidelity.ts';

describe('encodePico', () => {
  it('round-trips as gzip then base64 of the JSON', () => {
    // Looks like opaque server state; is plain JSON the client builds.
    const value = { accounts: [{ accountId: 'X', acctType: 'Brokerage' }] };
    const decoded = gunzipSync(Buffer.from(encodePico(value), 'base64'));

    expect(JSON.parse(decoded.toString('utf8'))).toEqual(value);
  });

  it('produces the gzip prefix the web client sends', () => {
    expect(encodePico({})).toMatch(/^H4sI/);
  });
});

describe('epochDate', () => {
  it('reads seconds', () => {
    expect(epochDate(1_786_593_600)).toBe('2026-08-13');
  });

  it('reads milliseconds rather than landing in the year 58,000', () => {
    expect(epochDate(1_786_593_600_000)).toBe('2026-08-13');
  });

  it('returns undefined rather than 1970 for nothing', () => {
    expect(epochDate(undefined)).toBeUndefined();
    expect(epochDate('')).toBeUndefined();
    expect(epochDate(0)).toBeUndefined();
  });
});

describe('parsePositionRows', () => {
  const position = {
    actNum: 'A1',
    cstBasStk: { top: { disp: '$980.93', val: 980.93 } },
    curVal: { disp: '$998.35', val: 998.35 },
    lstPrStk: { top: { disp: '$376.31', val: 376.31 } },
    qty: { disp: '2.653', val: 2.653 },
    rowType: 'POSITION',
    sym: { name: 'vti' },
    totGLStk: { top: { disp: '+$17.42', val: 17.42 } }
  };

  it('reads a position row', () => {
    const [row] = parsePositionRows([position]);

    expect(row?.ticker).toBe('VTI');
    expect(row?.quantity.toString()).toBe('2.653');
    expect(row?.price.toString()).toBe('376.31');
    expect(row?.costBasis?.toString()).toBe('980.93');
    expect(row?.unrealisedGain?.toString()).toBe('17.42');
  });

  it('skips the cash sweep, headers and totals', () => {
    // Every row carries a symbol; only POSITION is a holding. Reading them all
    // would count the core money market as a stock and a footer as a security
    // called "Account total".
    const rows = parsePositionRows([
      { actNum: 'A1', rowType: 'ACCOUNT', sym: { name: 'A1' } },
      position,
      {
        actNum: 'A1',
        curVal: { val: 0.54 },
        rowType: 'POSITION_CORE',
        sym: { name: 'CORE**' }
      },
      {
        actNum: 'A1',
        curVal: { val: 998.89 },
        rowType: 'ACCOUNT_TOTAL',
        sym: { name: 'Account total' }
      }
    ]);

    expect(rows.map(row => row.ticker)).toEqual(['VTI']);
  });

  it('drops an unpriced row instead of zeroing it', () => {
    const rows = parsePositionRows([
      { ...position, lstPrStk: { top: { disp: '--', val: '' } } }
    ]);

    expect(rows).toHaveLength(0);
  });

  it('leaves cost basis undefined when the grid has none', () => {
    const [row] = parsePositionRows([{ ...position, cstBasStk: { top: {} } }]);

    expect(row?.costBasis).toBeUndefined();
  });
});

describe('parseBalance', () => {
  it('reads cash, value, date and registration', () => {
    const balance = parseBalance({
      account: {
        acctName: 'ROTH IRA',
        acctNum: 'A1',
        asOfDateTime: 1_786_593_600,
        isIra: true,
        legalConstructCode: 'ROTHIRA',
        totalAcctMktVal: 998.89
      },
      balance: {
        brokBalDetail: {
          availToTradeDetail: { cashAvailForTrade: 0.54 },
          availToWithdrawDetail: { netUnsettledBalance: 0 },
          cashDetail: { cashSettled: 0.54 }
        }
      }
    });

    expect(balance?.cashAvailable?.toString()).toBe('0.54');
    expect(balance?.totalValue?.toString()).toBe('998.89');
    expect(balance?.asOf).toBe('2026-08-13');
    expect(balance?.legalConstructCode).toBe('ROTHIRA');
  });

  it('reports missing cash as undefined, not zero', () => {
    const balance = parseBalance({ account: { acctNum: 'A1' } });

    expect(balance?.cashAvailable).toBeUndefined();
    expect(balance?.asOf).toBeUndefined();
  });

  it('ignores an entry with no account number', () => {
    expect(parseBalance({ account: {} })).toBeUndefined();
  });
});

describe('fidelityTaxTreatment', () => {
  it('reads a Roth construct as Roth', () => {
    expect(fidelityTaxTreatment('ROTHIRA', true)).toBe('roth');
  });

  it('reads any other IRA as tax-deferred', () => {
    expect(fidelityTaxTreatment('ROLLOVERIRA', true)).toBe('tax-deferred');
  });

  it('never calls a non-IRA account taxable', () => {
    // Probably a plain brokerage account — "probably" is how a tax cost gets
    // fabricated.
    expect(fidelityTaxTreatment('INDIVIDUAL', false)).toBe('unknown');
    expect(fidelityTaxTreatment(undefined, undefined)).toBe('unknown');
  });
});
