import {
  accountBalance,
  cancelOrder,
  completeAuthorization,
  configuredEnvironments,
  environment,
  hasAccessToken,
  hasConsumerCredentials,
  listAccounts,
  listOrders,
  listTransactions,
  placeOrder,
  portfolioPositions,
  previewOrder,
  renewIfStale,
  revokeAccessToken,
  setEnvironment,
  startAuthorization,
  type EtradeOrderRequest
} from '../data/etrade.ts';
import { dec, ZERO } from '../math/decimal.ts';
import {
  netPositions,
  type BrokerAdapter,
  type BrokerEnvironment,
  type OrderRequest
} from './contract.ts';
import { etradeTaxTreatment } from './tax.ts';

/** The ref carries both halves; `place` needs the preview id specifically. */
const previewIdOf = (ref: string): string => ref.split(':').at(-1) ?? ref;

const toEtradeOrder = (
  request: OrderRequest,
  clientOrderId: string
): EtradeOrderRequest => ({
  accountIdKey: request.accountId,
  clientOrderId: clientOrderId.split(':')[0] ?? clientOrderId,
  limitPrice: request.limitPrice.toString(),
  quantity: request.quantity.toString(),
  side: request.side,
  symbol: request.symbol
});

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
      // E*TRADE says CLOSED and nothing else means closed.
      active: account.accountStatus?.toUpperCase() !== 'CLOSED',
      description: account.accountDesc || account.accountName,
      id: account.accountIdKey,
      number: account.accountId,
      status: account.accountStatus,
      taxTreatment: etradeTaxTreatment(
        account.accountType,
        account.accountMode
      ),
      type: account.accountType
    })),

  authorize: {
    begin: async () => ({
      instructions:
        'E*TRADE displays a short verification code rather than redirecting ' +
        'anywhere. The URL is only good for **five minutes**.',
      url: await startAuthorization()
    }),
    complete: completeAuthorization,
    // The boolean is dropped: a failed renewal is not a failed read, and the
    // read that follows reports the truth either way.
    keepAlive: async () => void (await renewIfStale()),
    revoke: revokeAccessToken
  },

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

  feeSchedule: () => ({
    commission: ZERO,
    // E*TRADE charges $6.95 on an OTC name, dropping to $4.95 above 30 trades
    // a quarter. The higher figure is used: understating a cost is the worse
    // error, and this server cannot see the trade count.
    otcSurcharge: dec('6.95') ?? ZERO
  }),

  hasCredentialsFor: env =>
    configuredEnvironments().find(entry => entry.env === toEtrade(env))
      ?.hasConsumer === true,

  isConfigured: () => hasConsumerCredentials(),

  // The consumer key is not a session. A token that expired at midnight leaves
  // this false while `isConfigured` stays true, which is the whole reason the
  // two are separate.
  isConnected: () => hasConsumerCredentials() && hasAccessToken(),

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

  trading: {
    cancel: cancelOrder,

    open: async accountId =>
      (await listOrders(accountId)).map(order => ({
        filledQuantity: order.filledQuantity,
        orderId: order.orderId,
        placedAt: order.placedAt,
        status: order.status,
        symbol: order.symbol
      })),

    /**
     * Quotes the preview id back to E*TRADE, which is what its API requires —
     * the broker will not place an order that was not previewed. The neutral
     * contract's preview-then-place shape was taken from here.
     */
    place: async preview => {
      const placed = await placeOrder(
        toEtradeOrder(preview.request, preview.ref),
        previewIdOf(preview.ref)
      );
      return {
        filledQuantity: undefined,
        orderId: placed.orderId,
        placedAt: new Date().toISOString().slice(0, 10),
        status: placed.status,
        symbol: preview.request.symbol
      };
    },

    preview: async request => {
      // E*TRADE caps clientOrderId at 20 alphanumeric characters, and the ref
      // has to carry the preview id so `place` can quote it back.
      const clientOrderId = `cb${Date.now().toString(36)}`.slice(0, 20);
      const result = await previewOrder(toEtradeOrder(request, clientOrderId));

      return {
        estimatedCommission: result.estimatedCommission,
        estimatedTotal: result.estimatedTotal,
        ref: `${clientOrderId}:${result.previewId}`,
        request,
        warnings: [
          ...result.warnings,
          environment() === 'sandbox'
            ? 'Sandbox account: this order is simulated and moves no money.'
            : 'Production account: this order commits real money.'
        ]
      };
    }
  },

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
