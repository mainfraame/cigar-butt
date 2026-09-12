import { describe, expect, it } from 'vitest';

import { orderTable } from './portfolio.ts';

import type { Order } from '../portfolio/rebalance.ts';

function order(over: Partial<Order> = {}): Order {
  return {
    asOf: '2026-09-11',
    currentValue: 4998,
    driftFraction: 1,
    estimatedProceeds: 4998,
    price: 7.01,
    shares: 713,
    side: 'sell',
    targetValue: 0,
    ticker: 'NL',
    ...over
  } as Order;
}

const columns = (line: string) => line.split('|').length;

describe('orderTable', () => {
  it('shows participation once an order carries one', () => {
    // The caller has to go out of its way to supply averageDailyVolume, and
    // the figure was being computed and then dropped unless it crossed 20%.
    const table = orderTable('Sell', [order({ participation: 0.006 })]);

    expect(table).toContain('Session %');
    expect(table).toContain('0.6%');
  });

  it('omits the column entirely when no order has one', () => {
    // An em-dash where an execution cost belongs reads as "no cost" to a
    // hurried eye, which is the opposite of what unknown means here.
    const table = orderTable('Sell', [order()]);

    expect(table).not.toContain('Session %');
  });

  it('shows statutory fees only where they are non-zero', () => {
    // Sell-side only: a listed equity buy carries no statutory fee at all, so
    // a fee column on a buy table would be a row of zeroes implying precision.
    expect(orderTable('Sell', [order({ estimatedFees: 0.41 })])).toContain(
      'Statutory fees'
    );
    expect(orderTable('Buy', [order({ estimatedFees: 0 })])).not.toContain(
      'Statutory fees'
    );
  });

  it('keeps the header and its separator the same width', () => {
    // A markdown table whose separator row is short renders as plain text.
    const table = orderTable('Exit', [order({ participation: 0.6 })], {
      withGain: true
    });
    const [head, rule, body] = table.trim().split('\n').slice(2);

    expect(columns(rule!)).toBe(columns(head!));
    expect(columns(body!)).toBe(columns(head!));
  });
});
