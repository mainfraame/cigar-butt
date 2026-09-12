import { describe, expect, it } from 'vitest';

import { combinePositions, type AccountRef } from '../broker/aggregate.ts';
import { dec, type Decimal } from '../math/decimal.ts';
import { concentration, registerBrokerTools, where } from './broker.ts';

const d = (value: string): Decimal => dec(value)!;

function account(brokerId: string, number: string): AccountRef {
  return {
    account: {
      active: true,
      description: '',
      id: `${brokerId}-${number}`,
      number,
      status: 'ACTIVE',
      taxTreatment: 'unknown',
      type: 'BROKERAGE'
    },
    brokerId,
    brokerLabel: brokerId === 'etrade' ? 'E*TRADE' : 'Alpaca',
    environment: 'live',
    ref: `${brokerId}:${number}`
  };
}

const leg = (
  ref: AccountRef,
  ticker: string,
  shares: string,
  price: string
) => ({
  account: ref,
  position: {
    asOf: '2026-09-11',
    costBasis: undefined,
    price: d(price),
    shares: d(shares),
    ticker,
    unrealisedGain: undefined
  }
});

describe('concentration', () => {
  it('weights a position against the long book only', () => {
    // A short leg carries negative market value. Counting it shrinks the
    // denominator and once reported a name at 120% of a book it was half of.
    const positions = combinePositions([
      leg(account('etrade', '1'), 'GLD', '8', '153.52'),
      leg(account('etrade', '1'), 'BR', '40', '20.70'),
      leg(account('etrade', '1'), 'MSFT', '-36', '29.15')
    ]);

    const note = concentration(positions);

    expect(note).toContain('GLD');
    expect(note).toMatch(/5[0-9](\.[0-9])?%/);
    expect(note).not.toMatch(/1[0-9][0-9](\.[0-9])?%/);
  });

  it('says nothing when the book is evenly weighted', () => {
    const positions = combinePositions([
      leg(account('etrade', '1'), 'AAA', '10', '10'),
      leg(account('etrade', '1'), 'BBB', '10', '10'),
      leg(account('etrade', '1'), 'CCC', '10', '10'),
      leg(account('etrade', '1'), 'DDD', '10', '10'),
      leg(account('etrade', '1'), 'EEE', '10', '10'),
      leg(account('etrade', '1'), 'FFF', '10', '10'),
      leg(account('etrade', '1'), 'GGG', '10', '10'),
      leg(account('etrade', '1'), 'HHH', '10', '10'),
      leg(account('etrade', '1'), 'III', '10', '10'),
      leg(account('etrade', '1'), 'JJJ', '10', '10'),
      leg(account('etrade', '1'), 'KKK', '10', '10')
    ]);

    expect(concentration(positions)).toBe('');
  });

  it('says nothing when nothing is held long', () => {
    const positions = combinePositions([
      leg(account('etrade', '1'), 'MSFT', '-36', '29.15')
    ]);

    expect(concentration(positions)).toBe('');
  });
});

describe('where', () => {
  it('names the account, not the broker, within one broker', () => {
    // Four accounts at one broker rendered as its name four times says
    // nothing, and the column exists to answer "sell from which account?".
    const [position] = combinePositions([
      leg(account('etrade', '707004180'), 'BR', '10', '20.70'),
      leg(account('etrade', '823145980'), 'BR', '10', '20.70')
    ]);

    expect(where(position!)).toBe('707004180 10 + 823145980 10');
  });

  it('qualifies by broker when a position is split across two', () => {
    const [position] = combinePositions([
      leg(account('etrade', '707004180'), 'BR', '10', '20.70'),
      leg(account('alpaca', 'PA32F0I'), 'BR', '5', '20.70')
    ]);

    expect(where(position!)).toBe('Alpaca PA32F0I 5 + E*TRADE 707004180 10');
  });

  it('reports a single holder without a share count', () => {
    const [position] = combinePositions([
      leg(account('etrade', '707004180'), 'BR', '10', '20.70')
    ]);

    expect(where(position!)).toBe('707004180');
  });
});

function handler(elicitation: boolean) {
  const handlers = new Map<string, Function>();
  registerBrokerTools({
    registerTool: (name: string, _config: unknown, run: Function) => {
      handlers.set(name, run);
    },
    server: {
      getClientCapabilities: () =>
        elicitation ? { elicitation: { form: {} } } : {}
    }
  } as never);
  return handlers.get('broker_connect')!;
}

describe('broker_connect', () => {
  it('hands back a URL rather than eliciting, even where the client can prompt', async () => {
    // The flow leaves the client entirely — browser, login, approve, read a
    // code back — which outlasts any elicitation timeout. When the prompt
    // times out it takes the request token with it, so the user returns with
    // a valid code and nothing to redeem it against.
    const result = await handler(true)({ broker: 'alpaca' }, { mcpReq: {} });

    expect(result.resultType).toBeUndefined();
    expect(result.content?.[0]?.text).toBeTypeOf('string');
  });

  it('says a static-key broker needs no authorization at all', async () => {
    const result = await handler(false)({ broker: 'alpaca' }, { mcpReq: {} });

    expect(result.content?.[0]?.text).toContain('needs no authorization');
  });
});
