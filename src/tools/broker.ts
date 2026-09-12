import {
  acceptedContent,
  inputRequired,
  type CallToolResult,
  type InputRequiredResult,
  type McpServer
} from '@modelcontextprotocol/server';

import * as z from 'zod/v4';

import {
  accountBalance,
  completeAuthorization,
  configuredEnvironments,
  environment,
  hasAccessToken,
  hasConsumerCredentials,
  listAccounts,
  listTransactions,
  portfolioPositions,
  renewIfStale,
  revokeAccessToken,
  scopedName,
  setEnvironment,
  startAuthorization
} from '../data/etrade.ts';
import { money, out } from '../math/decimal.ts';
import {
  attempt,
  cell,
  DISCLAIMER,
  pct,
  text,
  usd,
  type ToolResult
} from './shared.ts';

/** A currency row that stays out of the table when E*TRADE did not send it. */
function moneyRow(label: string, value: Parameters<typeof money>[0]): string {
  const amount = money(value);
  return amount === undefined ? '' : `| ${label} | ${usd(amount)} |\n`;
}

/**
 * The brokerage side of the server: read the real portfolio rather than make
 * the user retype it into `plan_rebalance`.
 *
 * These tools read. Nothing here places, previews or cancels an order, and that
 * is deliberate — a screen handing a model the ability to trade is a different
 * product with a different risk profile.
 */

const accountIdKeyArg = z
  .string()
  .min(1)
  .max(64)
  .describe(
    "The account's `accountIdKey` from `etrade_accounts` — the opaque key, not " +
      'the human-readable account number. The API rejects the account number.'
  );

const verifierForm = z.object({
  verifier: z
    .string()
    .min(1)
    .meta({
      description:
        'The code E*TRADE displayed after you approved the application. Usually five ' +
        'characters.',
      title: 'E*TRADE verification code'
    })
});

const TOKEN_LIFECYCLE =
  'E*TRADE access tokens go idle after two hours without a request and expire ' +
  'outright at midnight US Eastern, no matter how recently they were used. ' +
  'After midnight the user must authorize again; there is no refresh token.';

export function registerBrokerTools(server: McpServer): void {
  server.registerTool(
    'etrade_connect',
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false
      },
      description:
        'Connect this server to an E*TRADE brokerage account over OAuth 1.0a. Call ' +
        'with no arguments to get an authorization URL for the user to open; E*TRADE ' +
        'shows them a short verification code, which you pass back as `verifier` on a ' +
        'second call. There is no browser redirect — E*TRADE issues the code ' +
        'out-of-band, which is why the user has to read it back to you. ' +
        `${TOKEN_LIFECYCLE} Call this tool again whenever another E*TRADE tool ` +
        'reports an expired token. While a connection is live the server renews it ' +
        'in the background every ninety minutes, so the idle timeout should never ' +
        'be what ends a session — only midnight does.',
      inputSchema: z.object({
        verifier: z
          .string()
          .min(1)
          .max(32)
          .optional()
          .describe(
            'The verification code from the authorization page. Omit on the first call.'
          )
      }),
      title: 'Connect an E*TRADE account'
    },
    (args, ctx): Promise<CallToolResult | InputRequiredResult> =>
      attempt(async () => {
        if (args.verifier) return finishConnect(args.verifier);

        // A previous round of this same call may already carry the user's answer.
        const answered = acceptedContent(
          ctx.mcpReq.inputResponses,
          'verifier',
          verifierForm
        );
        if (answered?.verifier) return finishConnect(answered.verifier);

        const url = await startAuthorization();
        const instructions =
          `Open this URL, log in, and approve the application:\n\n${url}\n\n` +
          'E*TRADE displays a short verification code rather than redirecting ' +
          'anywhere. The URL is only good for **five minutes**.';

        // Not every client can prompt, and an unsupported elicitation is
        // rejected when the result is serialised — after this handler has
        // already returned, so it cannot be caught here. Check first and hand
        // the URL back as text instead: the model relays it, the user reads the
        // code back, and the second call completes the exchange. The five-minute
        // window makes a dead end expensive.
        if (server.server.getClientCapabilities()?.elicitation?.form) {
          return inputRequired({
            inputRequests: {
              verifier: inputRequired.elicit({
                message: `${instructions}\n\n${TOKEN_LIFECYCLE}`,
                requestedSchema: verifierForm
              })
            }
          });
        }

        return text(
          `## Connect E*TRADE (${environment()})\n\n${instructions}\n\n` +
            'Then call `etrade_connect` again with that code as `verifier`.\n\n' +
            TOKEN_LIFECYCLE
        );
      })
  );

  server.registerTool(
    'etrade_accounts',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'List the E*TRADE accounts this connection can read, with the `accountIdKey` ' +
        'every other E*TRADE tool needs. Call this before `etrade_positions` — the ' +
        'account number a user quotes is not the key the API accepts.',
      inputSchema: z.object({}).meta({ title: 'No arguments' }),
      title: 'List E*TRADE accounts'
    },
    () =>
      attempt(async () => {
        const blocked = await requireConnection();
        if (blocked) return blocked;

        const accounts = await listAccounts();
        if (accounts.length === 0) {
          return text(
            `No accounts came back from E*TRADE (${environment()}). If this is the ` +
              'production environment, confirm the consumer key belongs to the same ' +
              'login as the brokerage account.'
          );
        }

        const rows = accounts
          .map(
            account =>
              `| \`${account.accountIdKey}\` | ${account.accountId} | ${account.accountType} | ` +
              `${account.accountDesc || account.accountName} | ${account.accountStatus} |`
          )
          .join('\n');

        return text(
          `## E*TRADE accounts (${environment()})\n\n` +
            '| Account ID key | Account | Type | Description | Status |\n|---|---|---|---|---|\n' +
            `${rows}\n\nPass the account ID key — the first column — to \`etrade_positions\`.`
        );
      })
  );

  server.registerTool(
    'etrade_positions',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'Current holdings and investable cash for one E*TRADE account, each position ' +
        'marked at its last trade with the date that trade happened. The response ' +
        'ends with a JSON block in exactly the shape `plan_rebalance` takes for its ' +
        '`holdings` argument, plus the cash figure for `availableCash`, so a rebalance ' +
        'can be planned against the real book without the user retyping it. Positions ' +
        'that came back without a symbol or a usable mark are omitted: an undated or ' +
        'unpriced position cannot be sized against.',
      inputSchema: z.object({ accountIdKey: accountIdKeyArg }),
      title: 'Read E*TRADE positions and cash'
    },
    ({ accountIdKey }) =>
      attempt(async () => {
        const blocked = await requireConnection();
        if (blocked) return blocked;

        const portfolio = await portfolioPositions(accountIdKey);
        // Balances come from a different endpoint than positions, and the two
        // can disagree when a trade has settled but not yet cleared — showing
        // both is more honest than picking one.
        const balance = await accountBalance(accountIdKey);
        const holdings = portfolio.positions.map(position => ({
          asOf: position.asOf,
          price: money(position.price),
          shares: out(position.shares, 6),
          ticker: position.ticker
        }));

        const rows = portfolio.positions
          .map(
            position =>
              `| ${position.ticker} | ${out(position.shares, 6)} | ` +
              `${usd(money(position.price))} | ${cell(money(position.pricePaid) === undefined ? undefined : usd(money(position.pricePaid)))} | ` +
              `${usd(money(position.marketValue))} | ${usd(money(position.totalCost))} | ` +
              `${usd(money(position.totalGain))} | ` +
              // E*TRADE sends these percentages already scaled to 0-100.
              `${cell(out(position.totalGainPct, 2), '%')} | ` +
              `${cell(money(position.daysGain) === undefined ? undefined : usd(money(position.daysGain)))} | ` +
              `${cell(out(position.pctOfPortfolio, 2), '%')} | ${position.asOf} |`
          )
          .join('\n');

        return text(
          `## E*TRADE portfolio — ${accountIdKey} (${environment()})\n\n` +
            (portfolio.positions.length > 0
              ? '| Ticker | Shares | Price | Paid | Market value | Cost | Gain | Gain % | Day | % of book | Price as of |\n' +
                `|---|---|---|---|---|---|---|---|---|---|---|\n${rows}\n\n`
              : 'No equity positions in this account.\n\n') +
            `Cash available for investment: **${usd(money(balance.cash))}**. ` +
            `Net cash ${usd(money(balance.netCash))}; total account value ` +
            `${usd(money(balance.totalValue ?? portfolio.totalValue))} ` +
            `as of ${balance.asOf}.\n\n` +
            '### For `plan_rebalance`\n\n' +
            `Pass this as \`holdings\`, and ${money(balance.cash) ?? 0} as ` +
            '`availableCash`:\n\n' +
            `\`\`\`json\n${JSON.stringify(holdings, undefined, 2)}\n\`\`\`\n\n` +
            (() => {
              // Equal weight is the strategy, so a position that has run away
              // from its neighbours is the thing a Schloss book most wants
              // surfaced — and it is invisible in a share count.
              const heaviest = portfolio.positions
                .filter(position => position.pctOfPortfolio !== undefined)
                .toSorted(
                  (a, b) =>
                    (out(b.pctOfPortfolio) ?? 0) - (out(a.pctOfPortfolio) ?? 0)
                )[0];
              const weight = out(heaviest?.pctOfPortfolio);
              return weight !== undefined && weight > 10 && heaviest
                ? `Largest position: **${heaviest.ticker}** at ${pct(weight / 100)} of the ` +
                    'book. Equal weight is the method here, and a name that has ' +
                    'run past its neighbours is a decision to make, not a ' +
                    'position to leave alone.\n\n'
                : '';
            })() +
            'Every price above is a last-trade mark carrying its own date. A mark from ' +
            'a thin name may be days old even while the market is open, and sizing ' +
            'against a stale mark is the mistake this server exists to prevent — check ' +
            'the dates before acting on a plan built from them.' +
            DISCLAIMER
        );
      })
  );

  server.registerTool(
    'etrade_environment',
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false
      },
      description:
        'Show or switch which E*TRADE environment is active. Call with no ' +
        'argument to see which key pairs are configured and which is in use; ' +
        'pass `environment` to switch. Sandbox and production hold entirely ' +
        'separate keys AND separate access tokens, so switching never mixes ' +
        'credentials and never invalidates the other side — you can keep both ' +
        'connected and flip between them. Sandbox returns canned data that does ' +
        'not match what you ask for, so use production for any real figure.',
      inputSchema: z.object({
        environment: z
          .enum(['sandbox', 'production'])
          .optional()
          .describe('Omit to report the current state without changing it.')
      }),
      title: 'Show or switch E*TRADE environment'
    },
    ({ environment: next }) =>
      Promise.resolve(
        attempt(() => {
          let shadowedBy: string | undefined;
          if (next) shadowedBy = setEnvironment(next).shadowedBy;

          const active = environment();
          const rows = configuredEnvironments()
            .map(
              entry =>
                `| ${entry.env}${entry.env === active ? ' **(active)**' : ''} | ` +
                `${entry.hasConsumer ? 'yes' : 'no'} | ` +
                `${entry.hasToken ? 'yes' : 'no'} | ` +
                `\`${scopedName('consumerKey', entry.env)}\` |`
            )
            .join('\n');

          const missing = configuredEnvironments().find(
            entry => entry.env === active && !entry.hasConsumer
          );

          return Promise.resolve(
            text(
              `## E*TRADE environment\n\nActive: **${active}**\n\n` +
                '| Environment | Key pair | Connected | Key variable |\n' +
                `|---|---|---|---|\n${rows}\n\n` +
                (shadowedBy
                  ? `**The switch will not survive a restart.** \`${shadowedBy}\` is ` +
                    'exported in your shell environment, and environment variables ' +
                    'win over the stored setting by design. Unset it (or change it ' +
                    `to "${next}") to make this stick.\n\n`
                  : '') +
                (missing
                  ? `No ${active} key pair is configured. Set ` +
                    `\`${scopedName('consumerKey', active)}\` and ` +
                    `\`${scopedName('consumerSecret', active)}\`, or run ` +
                    '`setup_credentials`.\n\n'
                  : '') +
                (active === 'sandbox'
                  ? '**Sandbox returns canned data.** Ask for GOOG and you may get ' +
                    'AAPL; balances and positions are synthetic. It proves the ' +
                    'connection works and nothing else — never read a real number ' +
                    'from it.\n\n'
                  : '') +
                'Access tokens are stored per environment, so connecting one does ' +
                'not disconnect the other.' +
                DISCLAIMER
            )
          );
        })
      )
  );

  server.registerTool(
    'etrade_balances',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'Full balance detail for one E*TRADE account: cash available to invest, ' +
        'settled versus unsettled, buying power, margin balance, market value, ' +
        'and any open margin calls. Use this when the question is "what do I have ' +
        'to deploy?" — `etrade_positions` answers "what do I hold?".',
      inputSchema: z.object({ accountIdKey: accountIdKeyArg }),
      title: 'Read E*TRADE balances'
    },
    ({ accountIdKey }) =>
      attempt(async () => {
        const blocked = await requireConnection();
        if (blocked) return blocked;

        const balance = await accountBalance(accountIdKey);
        const calls = money(balance.openCalls);

        return text(
          `## E*TRADE balances — ${balance.accountDescription ?? accountIdKey}` +
            ` (${environment()})\n\n` +
            `${balance.accountType ? `${balance.accountType} account · ` : ''}` +
            `as of **${balance.asOf}**\n\n` +
            (calls !== undefined && calls > 0
              ? `> **Open margin call of ${usd(calls)}.** That outranks every figure ` +
                'below: the broker can liquidate positions to meet it, and cash ' +
                'shown as available may not be yours to deploy.\n\n'
              : '') +
            '| Figure | Amount |\n|---|---|\n' +
            moneyRow('Cash available to invest', balance.cash) +
            moneyRow('Settled cash', balance.settledCash) +
            moneyRow('Unsettled cash', balance.unsettledCash) +
            moneyRow('Cash available to withdraw', balance.cashForWithdrawal) +
            moneyRow('Net cash', balance.netCash) +
            moneyRow('Cash balance', balance.cashBalance) +
            moneyRow('Cash buying power', balance.cashBuyingPower) +
            moneyRow('Margin buying power', balance.marginBuyingPower) +
            moneyRow('Margin balance', balance.marginBalance) +
            moneyRow('Long market value', balance.netMarketValue) +
            moneyRow('Account balance', balance.accountBalance) +
            moneyRow('Total account value', balance.totalValue) +
            '\n' +
            'For sizing a screen, **cash available to invest** is the figure that ' +
            'belongs in `build_allocation` — buying power includes margin, and ' +
            'this strategy is not a margin strategy. Unsettled cash is spendable ' +
            'but not withdrawable, and selling against it can trip a good-faith ' +
            'violation in a cash account.' +
            DISCLAIMER
        );
      })
  );

  server.registerTool(
    'etrade_transactions',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'Transaction history for one E*TRADE account as a table: trades, ' +
        'dividends, transfers and fees, each with its date, symbol, quantity, ' +
        'price and amount. E*TRADE keeps two years and pages at 50 rows. Useful ' +
        'for reconstructing cost basis, checking what a rebalance actually ' +
        'executed at, and separating dividend income from realised gains.',
      inputSchema: z.object({
        accountIdKey: accountIdKeyArg,
        count: z
          .number()
          .int()
          .min(1)
          .max(50)
          .default(50)
          .describe("E*TRADE's own page size cap is 50."),
        endDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO date, e.g. 2026-09-12')
          .optional(),
        startDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO date, e.g. 2026-01-01')
          .optional()
          .describe(
            'Defaults to whatever E*TRADE returns; two years is the limit.'
          ),
        symbol: z
          .string()
          .max(10)
          .optional()
          .describe(
            'Filter to one ticker after fetching. The API has no symbol filter, ' +
              'so this narrows the page rather than the query — widen `count` or ' +
              'the date range if a name is missing.'
          )
      }),
      title: 'Read E*TRADE transactions'
    },
    ({ accountIdKey, count, endDate, startDate, symbol }) =>
      attempt(async () => {
        const blocked = await requireConnection();
        if (blocked) return blocked;

        const { more, transactions } = await listTransactions(accountIdKey, {
          count,
          endDate,
          startDate
        });

        const wanted = symbol?.trim().toUpperCase();
        const shown = wanted
          ? transactions.filter(item => item.symbol?.toUpperCase() === wanted)
          : transactions;

        if (shown.length === 0) {
          return text(
            `No transactions${wanted ? ` for ${wanted}` : ''} in this window.` +
              (transactions.length > 0
                ? ` The page held ${transactions.length} other transaction(s), so ` +
                  'widen `count` or the date range before concluding there are none.'
                : '') +
              DISCLAIMER
          );
        }

        const rows = shown
          .map(
            item =>
              `| ${item.transactionDate} | ${item.transactionType} | ` +
              `${cell(item.symbol)} | ${cell(out(item.quantity, 6))} | ` +
              `${cell(money(item.price) === undefined ? undefined : usd(money(item.price)))} | ` +
              `${cell(money(item.amount) === undefined ? undefined : usd(money(item.amount)))} | ` +
              `${cell(money(item.fee) === undefined ? undefined : usd(money(item.fee)))} | ` +
              `${item.description.slice(0, 60)} |`
          )
          .join('\n');

        return text(
          `## E*TRADE transactions — ${accountIdKey} (${environment()})\n\n` +
            `${shown.length} row(s)${wanted ? ` for ${wanted}` : ''}` +
            `${startDate || endDate ? `, ${startDate ?? 'earliest'} to ${endDate ?? 'today'}` : ''}` +
            '.\n\n' +
            '| Date | Type | Symbol | Quantity | Price | Amount | Fee | Description |\n' +
            `|---|---|---|---|---|---|---|---|\n${rows}\n\n` +
            (more
              ? 'More transactions exist beyond this page. Narrow the date range to ' +
                'reach them — this tool does not follow the pagination marker.\n\n'
              : '') +
            'Amount is signed from the account’s point of view: money in is ' +
            'positive, money out is negative. A dividend and a sale both read as ' +
            'positive, so use the type column rather than the sign to tell income ' +
            'from a disposal.' +
            DISCLAIMER
        );
      })
  );

  server.registerTool(
    'etrade_disconnect',
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false
      },
      description:
        'Revoke the stored E*TRADE access token and delete it, ending the ' +
        'session. The consumer key and secret are left in place, so ' +
        '`etrade_connect` can reconnect without re-entering them. Use this when ' +
        'handing the machine over, switching between the sandbox and production ' +
        'key pairs, or when a token is behaving oddly.',
      inputSchema: z.object({}).meta({ title: 'No arguments' }),
      title: 'Disconnect E*TRADE'
    },
    () =>
      attempt(async () => {
        if (!hasConsumerCredentials()) {
          return text(
            'No E*TRADE consumer credentials are configured, so there is nothing ' +
              'to disconnect.'
          );
        }

        const revoked = await revokeAccessToken();
        return text(
          revoked
            ? `Access token revoked at E*TRADE and deleted locally (${environment()}). ` +
                'Run `etrade_connect` to start a new session.'
            : 'No stored access token to revoke. Nothing changed.'
        );
      })
  );
}

/** Completes the OAuth exchange and reports without echoing a token. */
async function finishConnect(verifier: string): Promise<ToolResult> {
  await completeAuthorization(verifier);
  const accounts = await listAccounts();

  return text(
    `Connected to E*TRADE (${environment()}). The access token is stored in the ` +
      "server's 0600 credential file and survives a restart.\n\n" +
      `${accounts.length} account(s) visible. Call \`etrade_accounts\` for the ` +
      `account ID keys.\n\n${TOKEN_LIFECYCLE}`
  );
}

/**
 * Guards the read tools. A stored token that has merely idled out is revived
 * here rather than surfaced as a 401, because renewal is free and a model told
 * "expired" will otherwise walk the user through a browser round-trip it did
 * not need. A failed renewal is not treated as fatal — it is as likely to be a
 * dropped connection as a dead token, and the read that follows will say which.
 */
async function requireConnection(): Promise<ToolResult | undefined> {
  if (!hasAccessToken()) {
    return text(
      'No E*TRADE connection yet. Call `etrade_connect` to authorize one. ' +
        `${TOKEN_LIFECYCLE}`
    );
  }
  await renewIfStale();
  return undefined;
}
