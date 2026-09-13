import { keyBy } from 'lodash-es';

import {
  fetchBalances,
  fetchPositions,
  fidelityCookie,
  listAccountRefs,
  type FidelityAccountRef
} from '../data/fidelity.ts';
import { ZERO } from '../math/decimal.ts';
import { netPositions, type BrokerAdapter } from './contract.ts';
import { fidelityTaxTreatment } from './tax.ts';

/**
 * Fidelity, expressed in the broker-neutral contract. Read-only.
 *
 * Three things differ from the other adapters, each deliberately:
 *
 * - **No environment.** Fidelity has no sandbox or paper book, so this is
 *   always `live`, and switching is a no-op rather than a pretence.
 * - **No `authorize` and no `trading`.** The session is a browser cookie the
 *   user supplies, and no order endpoint answering in JSON was found, so the
 *   capability is absent rather than half-built. `order_preview` already
 *   handles a broker without it.
 * - **Transactions are not implemented.** The capture that established these
 *   endpoints had an empty transaction list, so there is no row shape to parse
 *   against, and guessing field names would produce an adapter that runs and
 *   reports the wrong history.
 */

async function refFor(accountId: string): Promise<FidelityAccountRef> {
  const ref = (await listAccountRefs()).find(
    account => account.acctNum === accountId
  );
  if (!ref) {
    throw new Error(
      `No Fidelity Brokerage account ${accountId} on this login. Workplace ` +
        'plans such as a 401(k) are not read by this adapter.'
    );
  }
  return ref;
}

export const fidelityAdapter: BrokerAdapter = {
  accounts: async () => {
    const refs = await listAccountRefs();
    // Names and registration come from the balances service: it carries both
    // the display name and the legal construct code in one payload.
    const balances = keyBy(await fetchBalances(refs), 'acctNum');

    return refs.map(ref => {
      const balance = balances[ref.acctNum];
      return {
        active: true,
        description: balance?.acctName ?? ref.acctSubType,
        id: ref.acctNum,
        number: ref.acctNum,
        status: 'ACTIVE',
        taxTreatment: fidelityTaxTreatment(
          balance?.legalConstructCode,
          balance?.isIra
        ),
        type: balance?.legalConstructCode ?? ref.acctType
      };
    });
  },

  balances: async accountId => {
    const [balance] = await fetchBalances([await refFor(accountId)]);
    if (!balance?.cashAvailable || !balance.asOf) {
      // Zero cash would be a claim about the account, and an undated figure is
      // the failure this codebase exists to prevent.
      throw new Error(
        `Fidelity returned no dated cash figure for ${accountId}. Nothing is ` +
          'reported rather than a zero. The session may have expired.'
      );
    }
    return {
      asOf: balance.asOf,
      cashAvailable: balance.cashAvailable,
      cashTotal: balance.cashSettled,
      // The service reports only a boolean for margin calls, and retirement
      // accounts carry no margin — undefined, not zero.
      openCalls: undefined,
      totalValue: balance.totalValue
    };
  },

  environment: () => 'live',

  environmentLabel: () => 'live',

  // $0 online US equity trades. This adapter places no orders, so the figure
  // feeds estimates only.
  feeSchedule: () => ({ commission: ZERO, otcSurcharge: ZERO }),

  hasCredentialsFor: env => env === 'live' && fidelityCookie() !== undefined,

  isConfigured: () => fidelityCookie() !== undefined,

  // The cookie is the session. It may already have expired server-side, which
  // only a read can reveal, and the data layer turns that into a clear message.
  isConnected: () => fidelityCookie() !== undefined,

  label: () => 'Fidelity',

  positions: async accountId => {
    const ref = await refFor(accountId);
    const rows = await fetchPositions(ref);
    const [balance] = await fetchBalances([ref]);

    // The positions grid carries no timestamp. The balances snapshot for the
    // same account does, and it is the date the marks belong to — substituting
    // today would be inventing provenance.
    const asOf = balance?.asOf;
    if (!asOf) {
      throw new Error(
        `Fidelity returned positions for ${accountId} with no dated snapshot ` +
          'to attribute the prices to, so none are reported.'
      );
    }

    return netPositions(
      rows.map(row => ({
        asOf,
        costBasis: row.costBasis,
        price: row.price,
        shares: row.quantity,
        ticker: row.ticker,
        unrealisedGain: row.unrealisedGain
      }))
    );
  },

  setEnvironment: () => ({}),

  transactions: () =>
    Promise.reject(
      new Error(
        'Fidelity transaction history is not implemented yet: the capture ' +
          'that established these endpoints returned no transactions, so there ' +
          'is no row shape to parse. Capture a history request with activity ' +
          'in the window and it can be added.'
      )
    )
};
