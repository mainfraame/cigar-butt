import { describe, expect, it } from 'vitest';

import { dec, type Decimal } from '../math/decimal.ts';
import {
  bookTaxTreatment,
  combinePositions,
  type AccountRef,
  type PositionLeg
} from './aggregate.ts';

import type { TaxTreatment } from './contract.ts';

const d = (value: string): Decimal => dec(value)!;

function account(
  brokerId: string,
  taxTreatment: TaxTreatment = 'unknown'
): AccountRef {
  return {
    account: {
      active: true,
      description: `${brokerId} account`,
      id: `${brokerId}-1`,
      number: `${brokerId}-0001`,
      status: 'ACTIVE',
      taxTreatment,
      type: 'BROKERAGE'
    },
    brokerId,
    brokerLabel: brokerId,
    environment: 'live',
    ref: `${brokerId}:${brokerId}-1`
  };
}

function leg(
  ref: AccountRef,
  ticker: string,
  shares: string,
  price: string,
  options: { asOf?: string; costBasis?: string; gain?: string } = {}
): PositionLeg {
  return {
    account: ref,
    position: {
      asOf: options.asOf ?? '2026-09-11',
      costBasis:
        options.costBasis === undefined ? undefined : d(options.costBasis),
      price: d(price),
      shares: d(shares),
      ticker,
      unrealisedGain: options.gain === undefined ? undefined : d(options.gain)
    }
  };
}

const etrade = account('etrade', 'taxable');
const alpaca = account('alpaca', 'roth');

describe('combinePositions', () => {
  it('sums shares of one ticker across brokers', () => {
    const [combined] = combinePositions([
      leg(etrade, 'HVT', '200', '25'),
      leg(alpaca, 'HVT', '100', '25')
    ]);

    expect(combined?.shares.toString()).toBe('300');
    expect(combined?.legs).toHaveLength(2);
  });

  it('keeps the legs, because a sale happens at a broker', () => {
    const [combined] = combinePositions([
      leg(etrade, 'HVT', '200', '25'),
      leg(alpaca, 'HVT', '100', '25')
    ]);

    expect(combined?.legs.map(entry => entry.account.brokerId)).toEqual([
      'alpaca',
      'etrade'
    ]);
  });

  it('takes the price from the newest mark, with that mark’s own date', () => {
    // A price from one row dated by another row is the exact failure this
    // codebase exists to prevent.
    const [combined] = combinePositions([
      leg(etrade, 'HVT', '200', '20', { asOf: '2026-09-04' }),
      leg(alpaca, 'HVT', '100', '25', { asOf: '2026-09-11' })
    ]);

    expect(combined?.price.toString()).toBe('25');
    expect(combined?.asOf).toBe('2026-09-11');
    expect(combined?.stalestAsOf).toBe('2026-09-04');
  });

  it('keeps market value consistent with the price and shares shown', () => {
    const [combined] = combinePositions([
      leg(etrade, 'HVT', '200', '20', { asOf: '2026-09-04' }),
      leg(alpaca, 'HVT', '100', '25', { asOf: '2026-09-11' })
    ]);

    expect(combined?.marketValue.toString()).toBe('7500');
  });

  it('reports how far apart two brokers’ marks are', () => {
    const [combined] = combinePositions([
      leg(etrade, 'HVT', '200', '20'),
      leg(alpaca, 'HVT', '100', '25')
    ]);

    expect(combined?.markSpread?.toString()).toBe('0.25');
  });

  it('reports no spread when a single broker holds the name', () => {
    const [combined] = combinePositions([leg(etrade, 'HVT', '200', '20')]);
    expect(combined?.markSpread).toBeUndefined();
  });

  it('sums cost basis when every leg reports one', () => {
    const [combined] = combinePositions([
      leg(etrade, 'HVT', '200', '25', { costBasis: '4000' }),
      leg(alpaca, 'HVT', '100', '25', { costBasis: '2200' })
    ]);

    expect(combined?.costBasis?.toString()).toBe('6200');
  });

  it('reports no cost basis when one leg is missing it', () => {
    // A total assembled from the legs that happened to report one is a
    // fragment presented as a whole, which reads as a real figure.
    const [combined] = combinePositions([
      leg(etrade, 'HVT', '200', '25', { costBasis: '4000' }),
      leg(alpaca, 'HVT', '100', '25')
    ]);

    expect(combined?.costBasis).toBeUndefined();
  });

  it('reports no cost basis across a long and a short leg', () => {
    const [combined] = combinePositions([
      leg(etrade, 'HVT', '200', '25', { costBasis: '4000' }),
      leg(alpaca, 'HVT', '-100', '25', { costBasis: '-2200' })
    ]);

    expect(combined?.shares.toString()).toBe('100');
    expect(combined?.costBasis).toBeUndefined();
  });

  it('marks a position as mixed when the accounts are taxed differently', () => {
    const [combined] = combinePositions([
      leg(etrade, 'HVT', '200', '25'),
      leg(alpaca, 'HVT', '100', '25')
    ]);

    expect(combined?.taxTreatment).toBe('mixed');
  });

  it('keeps a single treatment when every leg agrees', () => {
    const [combined] = combinePositions([
      leg(etrade, 'HVT', '200', '25'),
      leg(account('etrade2', 'taxable'), 'HVT', '100', '25')
    ]);

    expect(combined?.taxTreatment).toBe('taxable');
  });

  it('orders by ticker so output is deterministic', () => {
    const combined = combinePositions([
      leg(etrade, 'NL', '10', '5'),
      leg(alpaca, 'ASTE', '10', '5'),
      leg(etrade, 'HVT', '10', '5')
    ]);

    expect(combined.map(position => position.ticker)).toEqual([
      'ASTE',
      'HVT',
      'NL'
    ]);
  });
});

describe('bookTaxTreatment', () => {
  it('reports the shared treatment when every account agrees', () => {
    expect(bookTaxTreatment([etrade, account('etrade2', 'taxable')])).toBe(
      'taxable'
    );
  });

  it('falls back to unknown rather than picking one', () => {
    // `unknown` fabricates nothing. Either alternative — assuming taxable or
    // assuming sheltered — invents or hides a cost.
    expect(bookTaxTreatment([etrade, alpaca])).toBe('unknown');
  });

  it('reports unknown for an empty book', () => {
    expect(bookTaxTreatment([])).toBe('unknown');
  });
});
