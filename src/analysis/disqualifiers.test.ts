import { describe, expect, it } from 'vitest';

import { scanDisqualifiers } from './disqualifiers.ts';

import type { FilingEvent, SubmissionsSummary } from '../data/sec.ts';

const NOW = new Date('2026-09-12T00:00:00Z');

const event = (over: Partial<FilingEvent>): FilingEvent => ({
  accessionNumber: '0000000000-26-000001',
  filingDate: '2026-08-05',
  form: '10-Q',
  items: [],
  ...over
});

const summary = (events: FilingEvent[]): SubmissionsSummary => ({
  cik: '0000000001',
  events,
  exchanges: ['NASDAQ'],
  name: 'Test Co',
  sic: '3531',
  tickers: ['TEST']
});

describe('scanDisqualifiers', () => {
  it('is clear on a normal filing history', () => {
    const report = scanDisqualifiers(summary([event({})]), { now: NOW });

    expect(report.clear).toBe(true);
    expect(report.flags).toHaveLength(0);
    expect(report.lastPeriodicFiling?.form).toBe('10-Q');
  });

  it('disqualifies on 8-K item 4.02 non-reliance', () => {
    const report = scanDisqualifiers(
      summary([
        event({}),
        event({ form: '8-K', items: ['4.02', '9.01'], accessionNumber: 'A' })
      ]),
      { now: NOW }
    );

    expect(report.clear).toBe(false);
    expect(report.flags[0]?.severity).toBe('disqualify');
    expect(report.summary).toContain('DISQUALIFIED');
  });

  it('flags an auditor change for investigation without disqualifying', () => {
    const report = scanDisqualifiers(
      summary([
        event({}),
        event({ form: '8-K', items: ['4.01'], accessionNumber: 'B' })
      ]),
      { now: NOW }
    );

    expect(report.clear).toBe(true);
    expect(report.flags[0]?.severity).toBe('investigate');
  });

  it.each([
    ['25', 'disqualify'],
    ['25-NSE', 'disqualify'],
    ['15-12B', 'disqualify'],
    ['NT 10-Q', 'investigate'],
    ['SC 13D', 'note']
  ])('classifies form %s as %s', (form, severity) => {
    const report = scanDisqualifiers(
      summary([event({}), event({ accessionNumber: form, form })]),
      { now: NOW }
    );

    expect(report.flags.find(flag => flag.form === form)?.severity).toBe(
      severity
    );
  });

  it('deduplicates a 25-NSE indexed under both exchange and issuer', () => {
    // EDGAR indexes each 25-NSE twice; counting both would double-count delistings.
    const report = scanDisqualifiers(
      summary([
        event({}),
        event({ accessionNumber: 'DUP', form: '25-NSE' }),
        event({ accessionNumber: 'DUP', form: '25-NSE' })
      ]),
      { now: NOW }
    );

    expect(report.flags.filter(flag => flag.form === '25-NSE')).toHaveLength(1);
  });

  it('flags a filing gap where a 10-Q should be', () => {
    const report = scanDisqualifiers(
      summary([event({ filingDate: '2025-01-15' })]),
      { now: NOW }
    );

    expect(report.daysSinceLastPeriodic).toBeGreaterThan(500);
    expect(report.flags.some(flag => flag.reason.includes('delinquency'))).toBe(
      true
    );
  });

  it('flags a company with no periodic filings at all', () => {
    const report = scanDisqualifiers(summary([event({ form: '8-K' })]), {
      now: NOW
    });

    expect(report.flags.some(flag => flag.form === '10-K/10-Q')).toBe(true);
  });

  it('ignores an old restatement outside the lookback window', () => {
    const report = scanDisqualifiers(
      summary([
        event({}),
        event({
          accessionNumber: 'OLD',
          filingDate: '2015-01-01',
          form: '8-K',
          items: ['4.02']
        })
      ]),
      { lookbackDays: 730, now: NOW }
    );

    expect(report.clear).toBe(true);
  });

  it('orders disqualifiers ahead of notes', () => {
    const report = scanDisqualifiers(
      summary([
        event({}),
        event({ accessionNumber: 'N', form: 'SC 13D' }),
        event({ accessionNumber: 'D', form: '8-K', items: ['1.03'] })
      ]),
      { now: NOW }
    );

    expect(report.flags.map(flag => flag.severity)).toEqual([
      'disqualify',
      'note'
    ]);
  });
});

describe('change of control', () => {
  it('demands investigation rather than noting it in passing', () => {
    // Standard BioTools passed every asset test — 0.63x net current assets,
    // 9.1x current ratio, no debt — while a signed all-stock merger was
    // contributing those assets to Treeline for 16% of the combined company.
    const report = scanDisqualifiers(
      summary([
        event({}),
        event({
          accessionNumber: 'M',
          filingDate: '2026-06-08',
          form: '8-K',
          items: ['1.01', '5.01']
        })
      ]),
      { now: NOW }
    );

    const finding = report.flags.find(entry =>
      entry.reason.includes('control')
    );

    expect(finding?.severity).toBe('investigate');
    expect(finding?.reason).toContain('all-stock merger');
  });
});
