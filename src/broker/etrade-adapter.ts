import {
  accountBalance,
  configuredEnvironments,
  environment,
  hasConsumerCredentials,
  listAccounts,
  listTransactions,
  portfolioPositions,
  setEnvironment
} from '../data/etrade.ts';
import {
  netPositions,
  type BrokerAdapter,
  type BrokerEnvironment
} from './contract.ts';

/** E*TRADE says sandbox and production; the contract says test and live. */
const toEtrade = (env: BrokerEnvironment): 'production' | 'sandbox' =>
  env === 'test' ? 'sandbox' : 'production';

/**
 * E*TRADE, expressed in the broker-neutral contract.
 *
 * Everything E*TRADE-specific stops here: the OAuth 1.0a signing, the two
 * environments, the `accountIdKey` that is not an account number, the fact that
 * a portfolio arrives as lots rather than positions. Consumers above see
 * `Position` and `Balances` and nothing else.
 */
export const etradeAdapter: BrokerAdapter = {
  accounts: async () =>
    (await listAccounts()).map(account => ({
      description: account.accountDesc || account.accountName,
      id: account.accountIdKey,
      number: account.accountId,
      status: account.accountStatus,
      type: account.accountType
    })),

  balances: async accountId => {
    const balance = await accountBalance(accountId);
    return {
      asOf: balance.asOf,
      cashAvailable: balance.cash,
      cashTotal: balance.cashBalance,
      openCalls: balance.openCalls,
      totalValue: balance.totalValue
    };
  },

  environment: () => (environment() === 'sandbox' ? 'test' : 'live'),

  environmentLabel: env => toEtrade(env),

  hasCredentialsFor: env =>
    configuredEnvironments().find(entry => entry.env === toEtrade(env))
      ?.hasConsumer === true,

  isConfigured: () => hasConsumerCredentials(),

  label: () => `E*TRADE (${environment()})`,

  positions: async accountId => {
    const portfolio = await portfolioPositions(accountId);
    // Netting happens here rather than in a tool: every broker reports lots,
    // and a consumer that had to remember would eventually forget.
    return netPositions(
      portfolio.positions.map(position => ({
        asOf: position.asOf,
        costBasis: position.totalCost,
        price: position.price,
        shares: position.shares,
        ticker: position.ticker,
        unrealisedGain: position.totalGain
      }))
    );
  },

  setEnvironment: env => setEnvironment(toEtrade(env)),

  transactions: async (accountId, options) => {
    const result = await listTransactions(accountId, options);
    return {
      more: result.more,
      transactions: result.transactions.map(entry => ({
        amount: entry.amount,
        description: entry.description,
        fee: entry.fee,
        price: entry.price,
        quantity: entry.quantity,
        settledDate: entry.postDate,
        symbol: entry.symbol,
        tradeDate: entry.transactionDate,
        type: entry.transactionType
      }))
    };
  }
};
