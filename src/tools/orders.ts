import type { McpServer } from '@modelcontextprotocol/server';

import * as z from 'zod/v4';

import { openBook } from '../broker/aggregate.ts';
import { brokerAdapter } from '../broker/registry.ts';
import { ordersEnabled, refuseOrder } from '../broker/trading-gate.ts';
import { dec, money, out } from '../math/decimal.ts';
import { attempt, cell, DISCLAIMER, text, usd } from './shared.ts';

import type {
  OrderPreview,
  OrderRequest,
  PlacedOrder
} from '../broker/contract.ts';

/**
 * Placing orders.
 *
 * Everything else in this server reads. These four tools are the exception,
 * and the risk they carry is not a mistyped ticket — it is this assistant
 * sending an order nobody asked for. The design answers that specifically:
 *
 * - **Nothing executes in one call.** `order_preview` prices an order and
 *   returns a ref; `order_place` takes only a ref. There is no argument you
 *   can pass to a single tool that both decides and executes.
 * - **A ref must be quoted back.** It is issued by the broker adapter and
 *   printed in a preview a human reads. A model cannot invent one.
 * - **Off by default, twice.** `CIGAR_BUTT_ENABLE_ORDERS` turns on paper
 *   trading; real money needs `CIGAR_BUTT_ENABLE_LIVE_ORDERS` as well.
 * - **Limit only, day only, capped.** See `trading-gate.ts`.
 *
 * A preview is deliberately not persisted. It lives in this conversation, so
 * placing one requires the exchange in which it was shown — which is the
 * closest thing to a human signature available here.
 */

/**
 * Previews issued this session, by ref. Never written to disk.
 *
 * The account *ref* is kept beside the preview, not just the broker's own
 * account id. `place` has to re-scope the book to re-check the gate, and
 * scoping on a bare id loses the broker prefix — which meant a paper order
 * priced happily and then refused to place, because environment arbitration
 * discarded the broker it belonged to.
 */
const previews = new Map<
  string,
  { accountRef: string; preview: OrderPreview }
>();

function renderPreview(preview: OrderPreview, environment: string): string {
  const { limitPrice, quantity, side, symbol } = preview.request;
  return (
    `## Preview — ${side.toUpperCase()} ${out(quantity, 0)} ${symbol}\n\n` +
    `| Field | Value |\n|---|---|\n` +
    `| Side | ${side} |\n` +
    `| Symbol | ${symbol} |\n` +
    `| Quantity | ${out(quantity, 0)} shares |\n` +
    `| Order type | limit, ${preview.request.timeInForce === 'gtc' ? 'good till cancelled' : 'day'} |\n` +
    `| Limit price | ${usd(money(limitPrice))} |\n` +
    (preview.request.takeProfit
      ? `| Attached sell | ${usd(money(preview.request.takeProfit))} |\n`
      : '') +
    `| Worst-case cost | ${cell(money(preview.estimatedTotal) === undefined ? undefined : usd(money(preview.estimatedTotal)))} |\n` +
    `| Commission | ${cell(money(preview.estimatedCommission) === undefined ? undefined : usd(money(preview.estimatedCommission)))} |\n` +
    `| Account | ${preview.request.accountId} (${environment}) |\n\n` +
    (preview.warnings.length > 0
      ? `${preview.warnings.map(warning => `> ${warning}`).join('\n')}\n\n`
      : '') +
    `**Nothing has been sent.** To place this exact order, call ` +
    `\`order_place\` with \`ref: "${preview.ref}"\`. The ref is the only way ` +
    'to place it, and it expires with this conversation.\n'
  );
}

/**
 * One row for an order, plus one for each exit attached to it.
 *
 * An attached exit is a child the broker holds until the entry fills, so it
 * is indented rather than listed flat — it reads as conditional on the order
 * above it, which is what it is.
 */
function orderRows(order: PlacedOrder): string[] {
  const rows = [
    `| \`${order.orderId}\` | ${order.symbol} | ${order.status} | ` +
      `${cell(out(order.filledQuantity, 0))} | ${order.placedAt} |`
  ];

  for (const leg of order.attached ?? []) {
    rows.push(
      `| ↳ \`${leg.orderId}\` | ${leg.symbol} ${leg.side ?? ''} ` +
        `${cell(money(leg.limitPrice) === undefined ? undefined : usd(money(leg.limitPrice)))} | ` +
        `${leg.status} (held until the entry fills) | ` +
        `${cell(out(leg.filledQuantity, 0))} | ${leg.placedAt} |`
    );
  }

  return rows;
}

export function registerOrderTools(server: McpServer): void {
  server.registerTool(
    'order_preview',
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: true
      },
      description:
        'Price an order without sending it. Returns a `ref` that ' +
        '`order_place` requires — there is no single call that both decides ' +
        'and executes, so nothing can reach a market that a person has not ' +
        'seen priced first.\n\n' +
        'Limit orders only, good for the day only, whole shares only. A ' +
        'market order into the thinly-traded names this method selects for is ' +
        'how you pay for someone else’s exit, and a limit is the only ' +
        'order whose worst case a preview can state honestly.',
      inputSchema: z.object({
        account: z
          .string()
          .min(1)
          .max(80)
          .describe('Account `ref` from `broker_accounts`, e.g. `alpaca:xyz`.'),
        limitPrice: z
          .number()
          .positive()
          .finite()
          .describe(
            'Required. The most you will pay, or the least you accept.'
          ),
        quantity: z.number().int().positive().describe('Whole shares.'),
        side: z.enum(['buy', 'sell']),
        symbol: z.string().min(1).max(10),
        takeProfit: z
          .number()
          .positive()
          .finite()
          .optional()
          .describe(
            'Attach a sell at this price to a buy, so the exit exists only if ' +
              'the entry fills. Alpaca supports this; E*TRADE has no bracket ' +
              'order type at all, so there the exit is a separate `gtc` sell ' +
              'placed once the buy fills. There is deliberately no stop-loss ' +
              'counterpart: a falling price makes a net-net cheaper, and a ' +
              'stop would sell it at its most attractive.'
          ),
        timeInForce: z
          .enum(['day', 'gtc'])
          .default('day')
          .describe(
            '`day` for an entry. `gtc` for an exit — this method waits ' +
              'quarters or years for a discount to close, and a take-profit ' +
              'that expires at the bell is not an exit. Brokers cap ' +
              'good-till-cancelled at 60 to 180 days, so it still needs ' +
              're-placing.'
          )
      }),
      title: 'Price an order without sending it'
    },
    ({
      account,
      limitPrice,
      quantity,
      side,
      symbol,
      takeProfit,
      timeInForce
    }) =>
      attempt(async () => {
        if (!ordersEnabled()) {
          return text(refuseOrder({} as OrderRequest, 'test') ?? '');
        }

        const scope = await openBook({ account });
        const target = scope.accounts[0];
        if (!target) {
          return text(
            `No account matches \`${account}\`. Call \`broker_accounts\` for refs.`
          );
        }

        const adapter = brokerAdapter(target.brokerId);
        if (!adapter.trading) {
          return text(
            `${adapter.label()} cannot place orders through this server. ` +
              'Only brokers with a trading adapter can, and it is a separate ' +
              'piece of work per broker.'
          );
        }

        const request: OrderRequest = {
          accountId: target.account.id,
          limitPrice: dec(limitPrice)!,
          quantity: dec(quantity)!,
          side,
          symbol: symbol.trim().toUpperCase(),
          takeProfit: dec(takeProfit),
          timeInForce
        };

        const refusal = refuseOrder(request, target.environment);
        if (refusal) return text(refusal);

        const preview = await adapter.trading.preview(request);
        previews.set(preview.ref, { accountRef: target.ref, preview });

        return text(
          renderPreview(preview, adapter.environmentLabel(target.environment)) +
            DISCLAIMER
        );
      })
  );

  server.registerTool(
    'order_place',
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
        readOnlyHint: false
      },
      description:
        'Send an order that `order_preview` has already priced. Takes only a ' +
        '`ref` — the order itself cannot be specified here, so this tool ' +
        'cannot originate a trade, only complete one a person has seen.\n\n' +
        'A ref is issued by the preview and expires with the conversation. ' +
        'If it is not recognised, preview again and read the result rather ' +
        'than guessing a ref.',
      inputSchema: z.object({
        ref: z
          .string()
          .min(1)
          .max(80)
          .describe('The `ref` printed by `order_preview`.')
      }),
      title: 'Place a previewed order'
    },
    ({ ref }) =>
      attempt(async () => {
        const held = previews.get(ref);
        if (!held) {
          return text(
            `No preview with ref \`${ref}\` in this conversation. Previews are ` +
              'held in memory and expire with the session, which is ' +
              'deliberate — placing an order should require the exchange in ' +
              'which it was shown. Run `order_preview` again.'
          );
        }

        const { accountRef, preview } = held;
        const scope = await openBook({ account: accountRef });
        const target = scope.accounts[0];
        if (!target) {
          return text(
            `The account this preview was priced against (\`${accountRef}\`) is ` +
              'no longer visible. Nothing was sent.'
          );
        }

        // Re-checked at the point of execution, not only at preview: the
        // switches or the ceiling may have changed since, and the preview
        // may have been sitting in the conversation for a while.
        const refusal = refuseOrder(preview.request, target.environment);
        if (refusal) return text(`${refusal}\n\nNothing was sent.`);

        const adapter = brokerAdapter(target.brokerId);
        if (!adapter.trading) {
          return text(
            `${adapter.label()} cannot place orders. Nothing was sent.`
          );
        }

        const placed = await adapter.trading.place(preview);
        // One ref, one order. Without this a repeated call duplicates a
        // position, and a duplicate buy is indistinguishable from intent.
        previews.delete(ref);

        return text(
          `## Order sent — ${preview.request.side.toUpperCase()} ` +
            `${out(preview.request.quantity, 0)} ${placed.symbol}\n\n` +
            `| Field | Value |\n|---|---|\n` +
            `| Broker order id | \`${placed.orderId}\` |\n` +
            `| Status | ${placed.status} |\n` +
            `| Placed at | ${placed.placedAt || 'unknown'} |\n` +
            `| Filled so far | ${cell(out(placed.filledQuantity, 0))} |\n\n` +
            'A limit order rests until it fills or the session ends. Check ' +
            '`order_list` for its state, and `broker_positions` once it has ' +
            'filled — a status here is the broker acknowledging the order, ' +
            'not a fill.\n\n' +
            'This ref is now spent. Preview again to place another.' +
            DISCLAIMER
        );
      })
  );

  server.registerTool(
    'order_list',
    {
      annotations: { openWorldHint: true, readOnlyHint: true },
      description:
        'Open orders at a broker: what is resting, and how much of it has ' +
        'filled. A placement acknowledgement is not a fill, and this is how ' +
        'you tell the difference.',
      inputSchema: z.object({
        account: z.string().min(1).max(80).describe('Account `ref`.')
      }),
      title: 'List open orders'
    },
    ({ account }) =>
      attempt(async () => {
        const scope = await openBook({ account });
        const target = scope.accounts[0];
        if (!target) return text(`No account matches \`${account}\`.`);

        const adapter = brokerAdapter(target.brokerId);
        if (!adapter.trading) {
          return text(`${adapter.label()} does not expose orders here.`);
        }

        const orders = await adapter.trading.open(target.account.id);
        if (orders.length === 0) {
          return text(`No open orders at ${adapter.label()}.`);
        }

        return text(
          `## Open orders — ${adapter.label()}\n\n` +
            '| Order id | Symbol | Status | Filled | Placed |\n|---|---|---|---|---|\n' +
            orders.flatMap(order => orderRows(order)).join('\n') +
            DISCLAIMER
        );
      })
  );

  server.registerTool(
    'order_cancel',
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
        readOnlyHint: false
      },
      description:
        'Cancel a resting order by its broker order id, from `order_list`. ' +
        'A failure is reported as a failure — an order you believe is pulled ' +
        'while it is still working is the worse error.',
      inputSchema: z.object({
        account: z.string().min(1).max(80).describe('Account `ref`.'),
        orderId: z.string().min(1).max(80)
      }),
      title: 'Cancel a resting order'
    },
    ({ account, orderId }) =>
      attempt(async () => {
        const scope = await openBook({ account });
        const target = scope.accounts[0];
        if (!target) return text(`No account matches \`${account}\`.`);

        const adapter = brokerAdapter(target.brokerId);
        if (!adapter.trading) {
          return text(`${adapter.label()} does not expose orders here.`);
        }

        await adapter.trading.cancel(target.account.id, orderId);

        return text(
          `Cancellation for \`${orderId}\` accepted by ${adapter.label()}. ` +
            'Confirm with `order_list` — a broker accepting a cancellation is ' +
            'not the same as the order being gone, and an order that filled ' +
            'in the meantime cannot be cancelled.' +
            DISCLAIMER
        );
      })
  );
}
