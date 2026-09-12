import {
  acceptedContent,
  inputRequired,
  type CallToolResult,
  type InputRequiredResult,
  type McpServer
} from '@modelcontextprotocol/server';

import * as z from 'zod/v4';

import {
  completeAuthorization,
  environment,
  hasAccessToken,
  accountBalance,
  hasConsumerCredentials,
  listAccounts,
  portfolioPositions,
  revokeAccessToken,
  renewIfStale,
  startAuthorization
} from '../data/etrade.ts';
import { money, out } from '../math/decimal.ts';
import { attempt, DISCLAIMER, text, usd, type ToolResult } from './shared.ts';

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
        return inputRequired({
          inputRequests: {
            verifier: inputRequired.elicit({
              message:
                `Open ${url} in a browser, log in, and approve the application. ` +
                'E*TRADE will display a verification code rather than redirecting ' +
                `anywhere — paste that code here. The URL is only good for five ` +
                `minutes. ${TOKEN_LIFECYCLE}`,
              requestedSchema: verifierForm
            })
          }
        });
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
              `| ${position.ticker} | ${out(position.shares, 6)} | ${usd(money(position.price))} | ` +
              `${usd(money(position.marketValue))} | ${usd(money(position.totalCost))} | ` +
              `${usd(money(position.totalGain))} | ${position.asOf} |`
          )
          .join('\n');

        return text(
          `## E*TRADE portfolio — ${accountIdKey} (${environment()})\n\n` +
            (portfolio.positions.length > 0
              ? '| Ticker | Shares | Price | Market value | Cost | Gain | Price as of |\n' +
                `|---|---|---|---|---|---|---|\n${rows}\n\n`
              : 'No equity positions in this account.\n\n') +
            `Cash available for investment: **${usd(money(balance.cash))}**. ` +
            `Net cash ${usd(money(balance.netCash))}; total account value ` +
            `${usd(money(balance.totalValue ?? portfolio.totalValue))} ` +
            `as of ${balance.asOf}.\n\n` +
            '### For `plan_rebalance`\n\n' +
            `Pass this as \`holdings\`, and ${money(balance.cash) ?? 0} as ` +
            '`availableCash`:\n\n' +
            `\`\`\`json\n${JSON.stringify(holdings, undefined, 2)}\n\`\`\`\n\n` +
            'Every price above is a last-trade mark carrying its own date. A mark from ' +
            'a thin name may be days old even while the market is open, and sizing ' +
            'against a stale mark is the mistake this server exists to prevent — check ' +
            'the dates before acting on a plan built from them.' +
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
