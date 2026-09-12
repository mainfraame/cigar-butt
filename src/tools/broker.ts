import {
  acceptedContent,
  inputRequired,
  type CallToolResult,
  type InputRequiredResult,
  type McpServer
} from '@modelcontextprotocol/server';

import { sortBy, uniq } from 'lodash-es';
import * as z from 'zod/v4';

import {
  bookTaxTreatment,
  openBook,
  readBook,
  type BookScope,
  type BrokerFailure,
  type CombinedPosition,
  type PositionLeg
} from '../broker/aggregate.ts';
import { type BrokerAdapter } from '../broker/contract.ts';
import {
  allBrokers,
  brokerAdapter,
  configuredBrokers,
  connectedBrokers
} from '../broker/registry.ts';
import { describeTaxTreatment } from '../broker/tax.ts';
import { div, gtZero, money, out, ZERO } from '../math/decimal.ts';
import {
  attempt,
  cell,
  DISCLAIMER,
  pct,
  TAX_NOTE,
  text,
  usd,
  type ToolResult
} from './shared.ts';

/**
 * The brokerage side of the server: read the real portfolio rather than make
 * the user retype it into `plan_rebalance`.
 *
 * Every tool here is broker-neutral and reads the whole book. Positions held
 * at two brokers are one position — 200 shares at one and 100 at another is a
 * 300-share bet, and weighting it per broker would be wrong at the only level
 * that matters. What the aggregate must never lose is which account a share
 * actually sits in, because a sale happens at a broker and its tax
 * consequence depends on which one.
 *
 * These tools read. Nothing here places, previews or cancels an order, and
 * that is deliberate — a screen handing a model the ability to trade is a
 * different product with a different risk profile.
 */

/** A currency row that stays out of the table when a broker did not send it. */
function moneyRow(label: string, value: Parameters<typeof money>[0]): string {
  const amount = money(value);
  return amount === undefined ? '' : `| ${label} | ${usd(amount)} |\n`;
}

const brokerArg = z
  .string()
  .min(1)
  .max(32)
  .optional()
  .describe(
    'Restrict to one brokerage by id, e.g. `etrade` or `alpaca`. Omit to use ' +
      'every connected broker as a single book.'
  );

const accountArg = z
  .string()
  .min(1)
  .max(80)
  .describe(
    'An account `ref` from `broker_accounts`, e.g. `etrade:abc123`. The bare ' +
      'account id is accepted too, but a ref is unambiguous across brokers.'
  );

const verifierForm = z.object({
  verifier: z
    .string()
    .min(1)
    .meta({
      description:
        'The code the broker displayed after you approved the application. ' +
        'Usually five characters.',
      title: 'Broker verification code'
    })
});

const TOKEN_LIFECYCLE =
  'E*TRADE access tokens go idle after two hours without a request and expire ' +
  'outright at midnight US Eastern, no matter how recently they were used. ' +
  'After midnight the user must authorize again; there is no refresh token. ' +
  'Alpaca uses static API keys and has no such expiry.';

export function registerBrokerTools(server: McpServer): void {
  server.registerTool(
    'broker_connect',
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false
      },
      description:
        'Authorize a brokerage connection. Brokers that use static API keys ' +
        '(Alpaca) need no authorization and are connected as soon as their ' +
        'keys are set — this tool says so rather than pretending to do work. ' +
        'For a broker that needs an interactive grant (E*TRADE, OAuth 1.0a), ' +
        'call with no arguments to get an authorization URL for the user to ' +
        'open; the broker shows them a short verification code, which you pass ' +
        'back as `verifier` on a second call. There is no browser redirect. ' +
        `${TOKEN_LIFECYCLE} Call this again whenever a read reports an expired ` +
        'token. While a connection is live the server renews it in the ' +
        'background, so the idle timeout should never end a session — only ' +
        'midnight does.',
      inputSchema: z.object({
        broker: brokerArg,
        verifier: z
          .string()
          .min(1)
          .max(32)
          .optional()
          .describe(
            'The verification code from the authorization page. Omit on the first call.'
          )
      }),
      title: 'Connect a brokerage account'
    },
    (args, ctx): Promise<CallToolResult | InputRequiredResult> =>
      attempt(async () => {
        const target = resolveAuthorizable(args.broker);
        if ('message' in target) return text(target.message);

        const { adapter, id } = target;
        const authorize = adapter.authorize!;

        if (args.verifier) return finishConnect(id, adapter, args.verifier);

        // A previous round of this same call may already carry the answer.
        const answered = acceptedContent(
          ctx.mcpReq.inputResponses,
          'verifier',
          verifierForm
        );
        if (answered?.verifier) {
          return finishConnect(id, adapter, answered.verifier);
        }

        const { instructions, url } = await authorize.begin();
        const body = `Open this URL, log in, and approve the application:\n\n${url}\n\n${instructions}`;

        // Not every client can prompt, and an unsupported elicitation is
        // rejected when the result is serialised — after this handler has
        // already returned, so it cannot be caught here. Check first and hand
        // the URL back as text instead: the model relays it, the user reads the
        // code back, and the second call completes the exchange.
        if (server.server.getClientCapabilities()?.elicitation?.form) {
          return inputRequired({
            inputRequests: {
              verifier: inputRequired.elicit({
                message: `${body}\n\n${TOKEN_LIFECYCLE}`,
                requestedSchema: verifierForm
              })
            }
          });
        }

        return text(
          `## Connect ${adapter.label()}\n\n${body}\n\n` +
            `Then call \`broker_connect\` again with that code as \`verifier\`` +
            `${args.broker ? ` and \`broker: "${id}"\`` : ''}.\n\n` +
            TOKEN_LIFECYCLE
        );
      })
  );

  server.registerTool(
    'broker_accounts',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'Every account at every connected brokerage, with the `ref` the other ' +
        'broker tools take and the tax treatment of each. Call this first: the ' +
        'account number a user quotes is not the key any API accepts, and the ' +
        'tax treatment decides whether selling in that account realises a ' +
        'reportable gain.',
      inputSchema: z.object({ broker: brokerArg }),
      title: 'List brokerage accounts'
    },
    ({ broker }) =>
      attempt(async () => {
        const blocked = await requireConnection(broker);
        if (blocked) return blocked;

        const scope = await openBook({ broker });
        if (scope.accounts.length === 0) {
          return text(
            'No accounts came back from ' +
              `${connectedBrokers()
                .map(entry => entry.adapter.label())
                .join(', ')}. ` +
              'If this is a production environment, confirm the credentials ' +
              'belong to the same login as the brokerage account.' +
              scopeNotes(scope)
          );
        }

        const rows = scope.accounts
          .map(
            entry =>
              `| \`${entry.ref}\` | ${entry.brokerLabel} | ${entry.account.number} | ` +
              `${entry.account.type} | ${entry.account.description} | ` +
              `${entry.account.status} | ${entry.account.taxTreatment} |`
          )
          .join('\n');

        return text(
          `## Accounts\n\n` +
            '| Ref | Broker | Account | Type | Description | Status | Tax |\n' +
            '|---|---|---|---|---|---|---|\n' +
            `${rows}\n\n` +
            uniq(
              scope.accounts.map(
                entry =>
                  `- **${entry.account.number}** (${entry.brokerLabel}) — ` +
                  `${describeTaxTreatment(entry.account.taxTreatment)}`
              )
            ).join('\n') +
            '\n\n`broker_positions` reads all of these as one book. Pass a ref ' +
            'from the first column to narrow it to one account.' +
            scopeNotes(scope) +
            TAX_NOTE
        );
      })
  );

  server.registerTool(
    'broker_positions',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'The whole book: holdings and investable cash across every connected ' +
        'brokerage account, combined per ticker and each marked at its last ' +
        'trade with the date that trade happened. Shares of one name held at ' +
        'two brokers are reported as one position, with the split shown, ' +
        'because that is what the bet actually is. The response ends with a ' +
        'JSON block in exactly the shape `plan_rebalance` takes for its ' +
        '`holdings` argument, plus the cash figure for `availableCash`. ' +
        'Positions without a symbol or a usable mark are omitted: an undated or ' +
        'unpriced position cannot be sized against.',
      inputSchema: z.object({
        account: accountArg.optional(),
        broker: brokerArg
      }),
      title: 'Read the combined portfolio'
    },
    ({ account, broker }) =>
      attempt(async () => {
        const blocked = await requireConnection(broker);
        if (blocked) return blocked;

        const scope = await openBook({ account, broker });
        if (scope.accounts.length === 0)
          return text(noAccounts(account, scope));

        const book = await readBook(scope);
        const { positions } = book;

        const holdings = sortBy(
          positions.filter(position => gtZero(position.shares)),
          position => position.ticker
        ).map(position => ({
          asOf: position.asOf,
          costBasis: money(position.costBasis),
          price: money(position.price) ?? 0,
          shares: out(position.shares, 6) ?? 0,
          ticker: position.ticker
        }));

        const excluded = positions
          .filter(position => !gtZero(position.shares))
          .map(
            position => `${position.ticker} (net ${out(position.shares, 6)})`
          );

        const multiBroker = positions.filter(
          position => uniq(position.legs.map(leg => leg.account.ref)).length > 1
        );

        const rows = positions
          .map(
            position =>
              `| ${position.ticker} | ${out(position.shares, 6)} | ` +
              `${usd(money(position.price))} | ${usd(money(position.marketValue))} | ` +
              `${cell(money(position.costBasis) === undefined ? undefined : usd(money(position.costBasis)))} | ` +
              `${cell(money(position.unrealisedGain) === undefined ? undefined : usd(money(position.unrealisedGain)))} | ` +
              `${position.asOf} | ${where(position)} |`
          )
          .join('\n');

        const cash = book.balances?.cashAvailable ?? ZERO;
        const treatment = bookTaxTreatment(scope.accounts);

        return text(
          `## Portfolio — ${describeScope(scope)}\n\n` +
            (positions.length > 0
              ? '| Ticker | Shares | Price | Market value | Cost basis | Unrealised | Price as of | Held at |\n' +
                `|---|---|---|---|---|---|---|---|\n${rows}\n\n`
              : 'No equity positions in these accounts.\n\n') +
            `Cash available for investment: **${usd(money(cash))}**` +
            (book.balances && book.balances.rows.length > 1
              ? ` across ${book.balances.rows.length} accounts`
              : '') +
            `. Total account value ${cell(money(book.balances?.totalValue) === undefined ? undefined : usd(money(book.balances?.totalValue)))} ` +
            `as of ${book.balances?.asOf ?? 'unknown'}.\n\n` +
            splitNote(multiBroker) +
            markNote(positions) +
            concentration(positions) +
            '### For `plan_rebalance`\n\n' +
            `Pass this as \`holdings\`, ${money(cash) ?? 0} as ` +
            `\`availableCash\`, and \`taxTreatment: "${treatment}"\`:\n\n` +
            `\`\`\`json\n${JSON.stringify(holdings, undefined, 2)}\n\`\`\`\n\n` +
            (excluded.length > 0
              ? `**Excluded from that block:** ${excluded.join(', ')}. Multiple ` +
                'lots of a symbol are netted first, and anything not net long is ' +
                'left out — this server screens long-only value, and a negative ' +
                'share count is out of scope rather than silently rebalanced.\n\n'
              : '') +
            'Every price above is a last-trade mark carrying its own date. A mark from ' +
            'a thin name may be days old even while the market is open, and sizing ' +
            'against a stale mark is the mistake this server exists to prevent — check ' +
            'the dates before acting on a plan built from them.\n\n' +
            taxNote(scope, treatment) +
            failureNotes(book.failures) +
            scopeNotes(scope) +
            TAX_NOTE +
            DISCLAIMER
        );
      })
  );

  server.registerTool(
    'broker_balances',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'Cash and account value across every connected brokerage: available to ' +
        'invest, settled versus unsettled, total value, and any open margin ' +
        'calls, per account and summed. Use this when the question is "what do ' +
        'I have to deploy?" — `broker_positions` answers "what do I hold?".',
      inputSchema: z.object({
        account: accountArg.optional(),
        broker: brokerArg
      }),
      title: 'Read brokerage balances'
    },
    ({ account, broker }) =>
      attempt(async () => {
        const blocked = await requireConnection(broker);
        if (blocked) return blocked;

        const scope = await openBook({ account, broker });
        if (scope.accounts.length === 0)
          return text(noAccounts(account, scope));

        const book = await readBook(scope);
        const balances = book.balances;
        if (!balances) {
          return text(
            'No balances came back from any account in scope.' +
              failureNotes(book.failures) +
              scopeNotes(scope)
          );
        }

        const calls = money(balances.openCalls);
        const perAccount = balances.rows
          .map(
            row =>
              `| \`${row.account.ref}\` | ${row.account.account.number} | ` +
              `${usd(money(row.balances.cashAvailable))} | ` +
              `${cell(money(row.balances.totalValue) === undefined ? undefined : usd(money(row.balances.totalValue)))} | ` +
              `${row.balances.asOf} |`
          )
          .join('\n');

        return text(
          `## Balances — ${describeScope(scope)}\n\n` +
            `As of **${balances.asOf}**` +
            (balances.rows.length > 1
              ? ' — the oldest of the accounts below, because a total is only ' +
                'as current as its stalest part'
              : '') +
            '\n\n' +
            (calls !== undefined && calls > 0
              ? `> **Open margin call of ${usd(calls)}.** That outranks every figure ` +
                'below: the broker can liquidate positions to meet it, and cash ' +
                'shown as available may not be yours to deploy.\n\n'
              : '') +
            '| Figure | Amount |\n|---|---|\n' +
            moneyRow('Cash available to invest', balances.cashAvailable) +
            moneyRow('Cash balance', balances.cashTotal) +
            moneyRow('Open margin calls', balances.openCalls) +
            moneyRow('Total account value', balances.totalValue) +
            '\n' +
            (balances.rows.length > 1
              ? '| Account | Number | Cash available | Total value | As of |\n' +
                `|---|---|---|---|---|\n${perAccount}\n\n`
              : '') +
            incompleteNote(balances.incomplete) +
            'For sizing a screen, **cash available to invest** is the figure that ' +
            'belongs in `build_allocation` — buying power includes margin, and ' +
            'this strategy is not a margin strategy. Unsettled cash is spendable ' +
            'but not withdrawable, and selling against it can trip a good-faith ' +
            'violation in a cash account.\n\n' +
            (balances.rows.length > 1
              ? 'The total is deployable only in the sense that the money exists. ' +
                'Cash does not move between brokers on a trade date, so a ' +
                'purchase has to be funded from the account it settles in.\n\n'
              : '') +
            failureNotes(book.failures) +
            scopeNotes(scope) +
            DISCLAIMER
        );
      })
  );

  server.registerTool(
    'broker_transactions',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'Transaction history for one account as a table: trades, dividends, ' +
        'transfers and fees, each with its date, symbol, quantity, price and ' +
        'amount. This one takes a single account rather than the whole book — ' +
        'history is where basis is reconstructed, and interleaving two ' +
        "brokers' ledgers would obscure which account a lot belongs to. " +
        'E*TRADE keeps two years and pages at 50 rows.',
      inputSchema: z.object({
        account: accountArg,
        count: z
          .number()
          .int()
          .min(1)
          .max(100)
          .default(50)
          .describe("E*TRADE's own page size cap is 50; Alpaca allows 100."),
        endDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO date, e.g. 2026-09-12')
          .optional(),
        startDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/, 'ISO date, e.g. 2026-01-01')
          .optional()
          .describe(
            'Defaults to whatever the broker returns; two years is the E*TRADE limit.'
          ),
        symbol: z
          .string()
          .max(10)
          .optional()
          .describe(
            'Filter to one ticker after fetching. Neither API has a symbol ' +
              'filter, so this narrows the page rather than the query — widen ' +
              '`count` or the date range if a name is missing.'
          )
      }),
      title: 'Read account transactions'
    },
    ({ account, count, endDate, startDate, symbol }) =>
      attempt(async () => {
        const blocked = await requireConnection();
        if (blocked) return blocked;

        const scope = await openBook({ account });
        const target = scope.accounts[0];
        if (!target) return text(noAccounts(account, scope));
        if (scope.accounts.length > 1) {
          return text(
            `\`${account}\` matches ${scope.accounts.length} accounts: ` +
              `${scope.accounts.map(entry => `\`${entry.ref}\``).join(', ')}. ` +
              'Pass one ref.'
          );
        }

        const { more, transactions } = await brokerAdapter(
          target.brokerId
        ).transactions(target.account.id, { count, endDate, startDate });

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
              `| ${item.tradeDate} | ${item.type} | ` +
              `${cell(item.symbol)} | ${cell(out(item.quantity, 6))} | ` +
              `${cell(money(item.price) === undefined ? undefined : usd(money(item.price)))} | ` +
              `${cell(money(item.amount) === undefined ? undefined : usd(money(item.amount)))} | ` +
              `${cell(money(item.fee) === undefined ? undefined : usd(money(item.fee)))} | ` +
              `${item.description.slice(0, 60)} |`
          )
          .join('\n');

        return text(
          `## Transactions — ${target.account.number} (${target.brokerLabel})\n\n` +
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
    'broker_environment',
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false
      },
      description:
        'Show or switch which book each brokerage is pointed at. Every broker ' +
        'has two: a simulated one (E*TRADE calls it sandbox, Alpaca calls it ' +
        'paper) and the real one. Call with no arguments to see every broker, ' +
        'its credentials and which book is active; pass `broker` and ' +
        '`environment` to switch one. Credentials and session tokens are held ' +
        'separately per environment, so switching never mixes them and never ' +
        'disconnects the other side. Simulated books return synthetic data — ' +
        'E*TRADE’s sandbox answers a request for GOOG with AAPL — so use ' +
        'them to prove a connection works, never to read a real figure.',
      inputSchema: z.object({
        broker: brokerArg,
        environment: z
          .enum(['live', 'test'])
          .optional()
          .describe(
            'Omit to report without changing anything. `test` is sandbox at ' +
              'E*TRADE and paper at Alpaca; `live` is real money at both.'
          )
      }),
      title: 'Show or switch brokerage environments'
    },
    ({ broker, environment: next }) =>
      Promise.resolve(
        attempt(() => {
          let shadowedBy: string | undefined;
          let switched: string | undefined;

          if (next) {
            if (!broker) {
              return Promise.resolve(
                text(
                  'Pass `broker` as well as `environment`. Switching every ' +
                    'broker at once would be a single word with several ' +
                    'meanings, and one of them moves real money into view.'
                )
              );
            }
            const adapter = brokerAdapter(broker);
            shadowedBy = adapter.setEnvironment(next).shadowedBy;
            switched = `${adapter.label()} switched to ${adapter.environmentLabel(next)}.`;
          }

          const rows = allBrokers()
            .map(({ adapter, id }) => {
              const active = adapter.environment();
              return (['live', 'test'] as const)
                .map(
                  env =>
                    `| \`${id}\` | ${adapter.environmentLabel(env)}` +
                    `${env === active ? ' **(active)**' : ''} | ` +
                    `${adapter.hasCredentialsFor(env) ? 'yes' : 'no'} | ` +
                    `${env === active && adapter.isConnected() ? 'yes' : '—'} |`
                )
                .join('\n');
            })
            .join('\n');

          const live = connectedBrokers().filter(
            entry => entry.adapter.environment() === 'live'
          );
          const test = connectedBrokers().filter(
            entry => entry.adapter.environment() === 'test'
          );

          return Promise.resolve(
            text(
              '## Brokerage environments\n\n' +
                (switched ? `${switched}\n\n` : '') +
                '| Broker | Book | Credentials | Connected |\n' +
                `|---|---|---|---|\n${rows}\n\n` +
                (shadowedBy
                  ? `**The switch will not survive a restart.** \`${shadowedBy}\` is ` +
                    'exported in your shell environment, and environment variables ' +
                    'win over the stored setting by design. Unset it (or change it ' +
                    `to "${next}") to make this stick.\n\n`
                  : '') +
                (live.length > 0 && test.length > 0
                  ? `**Mixed books.** ${live.map(entry => entry.adapter.label()).join(', ')} ` +
                    `${live.length === 1 ? 'is' : 'are'} live while ` +
                    `${test.map(entry => entry.adapter.label()).join(', ')} ` +
                    `${test.length === 1 ? 'is' : 'are'} simulated. The combined ` +
                    'book uses the live side only and names what it left out; ' +
                    'simulated positions are never summed into real ones. Pass ' +
                    '`broker` to read a simulated book on its own.\n\n'
                  : '') +
                (test.length > 0 && live.length === 0
                  ? '**Everything connected is a simulated book.** Figures here ' +
                    'are synthetic: they prove the plumbing works and nothing ' +
                    'else.\n\n'
                  : '') +
                'Alpaca is the better unattended choice where you have the ' +
                'option: static API keys, so no midnight expiry and no verifier ' +
                'to type. E*TRADE cannot be read by a scheduled job across a day ' +
                'boundary at all.' +
                DISCLAIMER
            )
          );
        })
      )
  );

  server.registerTool(
    'broker_disconnect',
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false
      },
      description:
        'Revoke and delete a stored brokerage session token, ending the ' +
        'session. API keys and secrets are left in place, so `broker_connect` ' +
        'can reconnect without re-entering them. Use this when handing the ' +
        'machine over, switching between key pairs, or when a token is ' +
        'behaving oddly. A broker authenticated with static API keys has no ' +
        'session to end — remove its keys with `setup_credentials` instead.',
      inputSchema: z.object({ broker: brokerArg }),
      title: 'Disconnect a brokerage'
    },
    ({ broker }) =>
      attempt(async () => {
        const targets = allBrokers().filter(
          entry =>
            entry.adapter.authorize !== undefined &&
            (!broker || entry.id === broker)
        );

        if (targets.length === 0) {
          return text(
            broker
              ? `\`${broker}\` holds no revocable session. ` +
                  'It authenticates with static API keys, which `setup_credentials` manages.'
              : 'No broker here uses a revocable session token.'
          );
        }

        const results: string[] = [];
        for (const { adapter } of targets) {
          // eslint-disable-next-line no-await-in-loop
          const revoked = await adapter.authorize!.revoke();
          results.push(
            revoked
              ? `- ${adapter.label()}: token revoked at the broker and deleted locally.`
              : `- ${adapter.label()}: no stored token to revoke. Nothing changed.`
          );
        }

        return text(
          `${results.join('\n')}\n\nRun \`broker_connect\` to start a new session.`
        );
      })
  );
}

/**
 * Picks the broker to authorize.
 *
 * A broker with no `authorize` capability is already connected once its keys
 * are set, so saying "connected" is the honest answer rather than inventing a
 * handshake. Ambiguity is refused rather than guessed: connecting the wrong
 * broker costs the user a five-minute verifier window.
 */
function resolveAuthorizable(
  broker: string | undefined
): { adapter: BrokerAdapter; id: string } | { message: string } {
  if (broker) {
    const adapter = brokerAdapter(broker);
    if (!adapter.authorize) {
      return {
        message:
          `${adapter.label()} needs no authorization — it uses static API keys. ` +
          (adapter.isConfigured()
            ? 'Its keys are set, so it is already connected. Call `broker_accounts`.'
            : 'Set its keys with `setup_credentials` and it is connected.')
      };
    }
    return { adapter, id: broker };
  }

  const candidates = allBrokers().filter(entry => entry.adapter.authorize);
  const pending = candidates.filter(entry => !entry.adapter.isConnected());
  const choice = pending.length > 0 ? pending : candidates;

  if (choice.length === 0) {
    return {
      message:
        'No broker here uses an interactive authorization. Set API keys with ' +
        '`setup_credentials` and call `broker_accounts`.'
    };
  }
  if (choice.length > 1) {
    return {
      message:
        'Several brokers need authorizing: ' +
        `${choice.map(entry => `\`${entry.id}\``).join(', ')}. Pass \`broker\`.`
    };
  }

  return { adapter: choice[0]!.adapter, id: choice[0]!.id };
}

/** Completes the OAuth exchange and reports without echoing a token. */
async function finishConnect(
  id: string,
  adapter: BrokerAdapter,
  verifier: string
): Promise<ToolResult> {
  await adapter.authorize!.complete(verifier);

  // The token is stored by this point, so the connection has succeeded. Listing
  // accounts is a convenience, and letting it fail the whole call reported a
  // total failure for a connection that had actually worked — the user would
  // then re-run the flow and burn another five-minute verifier for nothing.
  let summary: string;
  try {
    const accounts = await adapter.accounts();
    summary =
      `${accounts.length} account(s) visible. Call \`broker_accounts\` for the ` +
      'account refs.';
  } catch (error) {
    summary =
      'Could not list accounts on this first call: ' +
      `${error instanceof Error ? error.message : String(error)}\n\n` +
      'The connection itself succeeded — try `broker_accounts` directly. ' +
      'E*TRADE intermittently answers a valid request with HTTP 404.';
  }

  return text(
    `Connected to ${adapter.label()} (\`${id}\`). The access token is stored in ` +
      "the server's 0600 credential file and survives a restart.\n\n" +
      `${summary}\n\n${TOKEN_LIFECYCLE}`
  );
}

/**
 * Guards the read tools.
 *
 * A stored session that has merely idled out is revived here rather than
 * surfaced as a 401, because renewal is free and a model told "expired" will
 * otherwise walk the user through a browser round-trip it did not need. A
 * failed renewal is not treated as fatal — it is as likely to be a dropped
 * connection as a dead token, and the read that follows will say which.
 */
async function requireConnection(
  broker?: string
): Promise<ToolResult | undefined> {
  const connected = connectedBrokers().filter(
    entry => !broker || entry.id === broker
  );

  if (connected.length === 0) {
    const configured = configuredBrokers().filter(
      entry => (!broker || entry.id === broker) && entry.configured
    );
    const needsGrant = configured.filter(entry => entry.needsAuthorization);

    return text(
      needsGrant.length > 0
        ? `${needsGrant.map(entry => entry.label).join(', ')} ` +
            `${needsGrant.length === 1 ? 'has' : 'have'} credentials but no live ` +
            'session. Call `broker_connect` to authorize one. ' +
            TOKEN_LIFECYCLE
        : 'No brokerage is connected. Run `setup_credentials` to add API keys ' +
            '(Alpaca connects as soon as its keys are set), or ' +
            '`broker_connect` to authorize E*TRADE.\n\n' +
            configuredBrokers()
              .map(
                entry =>
                  `- \`${entry.id}\` — ${entry.label}: ` +
                  `${entry.configured ? 'keys set' : 'no credentials'}`
              )
              .join('\n')
    );
  }

  for (const { adapter } of connected) {
    // eslint-disable-next-line no-await-in-loop
    await adapter.authorize?.keepAlive?.();
  }
  return undefined;
}

/** Which accounts a figure covers, for the heading. */
function describeScope(scope: BookScope): string {
  const brokers = uniq(scope.accounts.map(entry => entry.brokerLabel));
  return scope.accounts.length === 1
    ? `${scope.accounts[0]!.account.number} (${scope.accounts[0]!.brokerLabel})`
    : `${scope.accounts.length} accounts across ${brokers.join(', ')}`;
}

/**
 * Where the shares of one combined position actually sit.
 *
 * The account number, not the broker label: four accounts at one broker
 * rendered as the broker's name four times says nothing, and this column
 * exists to answer "which account do I sell from?".
 */
export function where(position: CombinedPosition): string {
  // Qualify by broker only when this position is actually split across two of
  // them. Four accounts at one broker do not need its name repeated four
  // times, and the column has to stay readable to be used.
  const spansBrokers =
    uniq(position.legs.map(leg => leg.account.brokerId)).length > 1;

  const name = (leg: PositionLeg): string =>
    spansBrokers
      ? `${leg.account.brokerLabel} ${leg.account.account.number}`
      : leg.account.account.number;

  if (position.legs.length === 1) return name(position.legs[0]!);
  return position.legs
    .map(leg => `${name(leg)} ${out(leg.position.shares, 6) ?? '?'}`)
    .join(' + ');
}

function noAccounts(account: string | undefined, scope: BookScope): string {
  return (
    (account
      ? `No account matches \`${account}\`. Call \`broker_accounts\` for the refs.`
      : 'No accounts are visible at any connected brokerage.') +
    scopeNotes(scope)
  );
}

/**
 * Says what was left out and why.
 *
 * Silent exclusion is the failure worth guarding against here: a book missing
 * a broker looks exactly like a book that is smaller than the user thought.
 */
function scopeNotes(scope: BookScope): string {
  const parts: string[] = [];

  if (scope.excluded.length > 0) {
    parts.push(
      `**Not included:** ${scope.excluded
        .map(entry => `${entry.label} — ${entry.reason}`)
        .join(
          '; '
        )}. Pass \`broker: "${scope.excluded[0]!.brokerId}"\` to read ` +
        'that book on its own.'
    );
  }

  if (scope.environment === 'test') {
    parts.push(
      '**This is a simulated book.** The figures are synthetic and prove only ' +
        'that the connection works. Switch with `broker_environment` before ' +
        'reading anything real.'
    );
  }

  return parts.length > 0 ? `\n\n${parts.join('\n\n')}` : '';
}

function failureNotes(failures: readonly BrokerFailure[]): string {
  if (failures.length === 0) return '';
  return (
    '**Some of the book could not be read**, so every total above is short by ' +
    'whatever those accounts hold:\n\n' +
    failures.map(entry => `- ${entry.label}: ${entry.reason}`).join('\n') +
    '\n\n'
  );
}

/** Flags a position split across brokers — the thing a per-broker view hides. */
function splitNote(positions: readonly CombinedPosition[]): string {
  if (positions.length === 0) return '';
  return (
    `${positions.length} position(s) span more than one account: ` +
    `${positions.map(position => position.ticker).join(', ')}. They are one ` +
    'holding for weighting and one decision to make, but a sale happens at a ' +
    'broker — the "held at" column says where the shares are.\n\n' +
    (positions.some(position => position.taxTreatment === 'mixed')
      ? '**Tax treatment differs across the accounts holding ' +
        `${positions
          .filter(position => position.taxTreatment === 'mixed')
          .map(position => position.ticker)
          .join(
            ', '
          )}.** Which account a sale comes out of decides whether it ` +
        'is reportable at all. That is a choice this server will not make for ' +
        'you, and no gain figure is offered for those names.\n\n'
      : '')
  );
}

/** Two brokers marking one security differently is information, not noise. */
function markNote(positions: readonly CombinedPosition[]): string {
  const disagreeing = positions.filter(position => {
    const gap = position.markSpread;
    return gap !== undefined && gap.gt('0.005');
  });
  if (disagreeing.length === 0) return '';

  return (
    '**Brokers disagree on the mark** for ' +
    disagreeing
      .map(
        position =>
          `${position.ticker} (${pct(out(position.markSpread) ?? 0)} apart, ` +
          `stalest ${position.stalestAsOf})`
      )
      .join(', ') +
    '. The newest mark is used above. A gap that size on a quiet name usually ' +
    'means one broker is quoting a last trade from an earlier session rather ' +
    'than that the security is worth two different amounts.\n\n'
  );
}

/**
 * Equal weight is the strategy, so a position that has run away from its
 * neighbours is the thing a Schloss book most wants surfaced — and it is
 * invisible in a share count. Derived here rather than read from a broker: not
 * every broker reports a portfolio weight, one that does may exclude cash, and
 * across two brokers neither of them can compute it at all.
 */
export function concentration(positions: readonly CombinedPosition[]): string {
  // Long only. A short leg carries negative market value, so including it
  // shrinks the denominator and can report a name at more than 100% of a book
  // it is plainly a fraction of — and a short is not a position this method
  // sizes anyway.
  const held = positions.filter(position => gtZero(position.shares));
  const total = held.reduce(
    (sum, position) => sum.plus(position.marketValue),
    ZERO
  );
  if (!gtZero(total)) return '';

  const heaviest = sortBy(held, position =>
    position.marketValue.neg().toNumber()
  )[0];
  if (!heaviest) return '';

  const weight = out(div(heaviest.marketValue, total));
  return weight !== undefined && weight > 0.1
    ? `Largest position: **${heaviest.ticker}** at ${pct(weight)} of the ` +
        'book. Equal weight is the method here, and a name that has run past ' +
        'its neighbours is a decision to make, not a position to leave alone.\n\n'
    : '';
}

function taxNote(scope: BookScope, treatment: string): string {
  const treatments = uniq(
    scope.accounts.map(entry => entry.account.taxTreatment)
  );
  if (treatments.length === 1) {
    return `Tax treatment: ${describeTaxTreatment(treatments[0]!)}.\n\n`;
  }
  return (
    `The accounts in this book are taxed differently (${treatments.join(', ')}), ` +
    `so the handoff above says \`${treatment}\`. A combined book has no single ` +
    'answer to "does selling realise a gain?", and picking one would fabricate ' +
    'a cost or hide one. Plan per account when the tax consequence matters.\n\n'
  );
}

function incompleteNote(incomplete: {
  cashTotal: number;
  openCalls: number;
  totalValue: number;
}): string {
  const gaps = [
    incomplete.cashTotal > 0 ? 'cash balance' : undefined,
    incomplete.openCalls > 0 ? 'open margin calls' : undefined,
    incomplete.totalValue > 0 ? 'total account value' : undefined
  ].filter((gap): gap is string => gap !== undefined);

  return gaps.length === 0
    ? ''
    : `Not every broker reports ${gaps.join(', ')}, so those totals cover only ` +
        'the accounts that do. Alpaca, for instance, closes positions rather ' +
        'than issuing a margin call, so it has none to report.\n\n';
}
