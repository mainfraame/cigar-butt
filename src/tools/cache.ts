import type { McpServer } from '@modelcontextprotocol/server';

import * as z from 'zod/v4';

import { purge, stats, TTL, vacuumExpired } from '../cache/store.ts';
import { clearCooldowns } from '../data/pool.ts';
import { quoteProviderStatus } from '../data/prices.ts';
import { attempt, cell, text } from './shared.ts';

/**
 * Cache inspection and eviction.
 *
 * Exposed as a tool because the cache is the difference between a screen that
 * reruns in seconds and one that burns a day's Alpha Vantage quota — and
 * because a user who suspects a figure is stale needs a way to force a refetch
 * without editing environment variables and restarting the client.
 */

const NAMESPACES = [
  'quote',
  'sec-concept',
  'sec-frames',
  'sec-submissions',
  'sec-tickers'
] as const;

/** Compact duration for a table cell. */
function humanise(seconds: number): string {
  if (seconds >= 3600) return `${Math.round(seconds / 3600)}h`;
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`;
  return `${seconds}s`;
}

export function registerCacheTools(server: McpServer): void {
  server.registerTool(
    'cache_status',
    {
      annotations: { openWorldHint: false, readOnlyHint: true },
      description:
        'Report what the local response cache holds, by source, and where the ' +
        'database file lives. Useful when a figure looks stale or when you want to ' +
        'know whether the next screen will hit the network.',
      inputSchema: z.object({}).meta({ title: 'No arguments' }),
      title: 'Inspect the cache'
    },
    () =>
      Promise.resolve(
        attempt(() => {
          const snapshot = stats();
          const rows = snapshot.byNamespace
            .map(entry => `| ${entry.namespace} | ${entry.entries} |`)
            .join('\n');

          return Promise.resolve(
            text(
              `## Cache\n\n${snapshot.path}\n\n` +
                `${snapshot.live} live entries, ${snapshot.expired} expired.\n\n` +
                (rows
                  ? `| Source | Live entries |\n|---|---|\n${rows}\n\n`
                  : 'Cache is empty.\n\n') +
                '### TTLs\n\n' +
                `- Quotes: ${TTL.prices / 60} minutes. Short on purpose — a stale price ` +
                'is the single largest source of wrong answers in this domain.\n' +
                `- SEC balance-sheet concepts: ${TTL.fundamentals / 3600} hours. These ` +
                'change only when a filing lands.\n' +
                `- SEC filing index: ${TTL.submissions / 3600} hours, so a new 8-K is ` +
                'not missed.\n' +
                `- SEC frames: ${TTL.frames / 86_400} days. A quarter is fixed once filed.\n` +
                `- Ticker index: ${TTL.tickerIndex / 86_400} days.\n\n` +
                'Set `CIGAR_BUTT_NO_CACHE=1` to bypass reads and writes entirely.'
            )
          );
        })
      )
  );

  server.registerTool(
    'cache_clear',
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false
      },
      description:
        'Drop cached responses so the next call refetches. Pass a source to clear ' +
        'just that one, or omit to clear everything. Use `expiredOnly` for routine ' +
        'housekeeping, which never discards a live entry.',
      inputSchema: z.object({
        expiredOnly: z
          .boolean()
          .default(false)
          .describe(
            'Remove only entries past their TTL. Safe to run any time.'
          ),
        source: z
          .enum(NAMESPACES)
          .optional()
          .describe('Clear one source. Omit to clear all of them.')
      }),
      title: 'Clear the cache'
    },
    ({ expiredOnly, source }) =>
      Promise.resolve(
        attempt(() => {
          if (expiredOnly) {
            const removed = vacuumExpired();
            return Promise.resolve(
              text(
                `Removed ${removed} expired entr${removed === 1 ? 'y' : 'ies'}.`
              )
            );
          }
          const removed = purge(source);
          return Promise.resolve(
            text(
              `Removed ${removed} entr${removed === 1 ? 'y' : 'ies'} from ` +
                `${source ?? 'every source'}. The next call will refetch.`
            )
          );
        })
      )
  );

  server.registerTool(
    'provider_status',
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false
      },
      description:
        'Show every price provider: whether it has a key, the rate it is being ' +
        'called at, and whether it is currently sitting out a free-tier cap. ' +
        'Providers are a failover pool — a request tries them in order and skips ' +
        'any that is unconfigured or cooling down — so this answers "why did that ' +
        'quote come from there?" and "why is this slow?". Pass `clearCooldowns` ' +
        'to forget recorded caps, which is worth doing when you know a daily ' +
        'quota has reset or you have just upgraded a plan.',
      inputSchema: z.object({
        clearCooldowns: z
          .boolean()
          .default(false)
          .describe('Forget every recorded cap and retry all providers.')
      }),
      title: 'Price provider status'
    },
    ({ clearCooldowns: shouldClear }) =>
      Promise.resolve(
        attempt(() => {
          const cleared = shouldClear ? clearCooldowns() : 0;
          const rows = quoteProviderStatus()
            .map(status => {
              const budgets =
                status.budgets.length > 0
                  ? status.budgets
                      .map(
                        budget =>
                          `${budget.used}/${budget.limit === 0 ? '∞' : budget.limit} per ` +
                          `${budget.per}${budget.unit === 'symbols' ? ' (symbols)' : ''}`
                      )
                      .join('<br>')
                  : '—';
              const state =
                status.cooldownSeconds > 0
                  ? `cooling ${humanise(status.cooldownSeconds)}`
                  : status.budgets.some(
                        budget =>
                          budget.limit > 0 && budget.used >= budget.limit
                      )
                    ? 'budget spent'
                    : 'ready';

              return (
                `| ${status.label} | ${status.configured ? 'yes' : '—'} | ` +
                `${status.requestsPerSecond}/s | ${budgets} | ${state} | ` +
                `${status.quotaHits} | ${cell(status.lastReason?.slice(0, 40))} |`
              );
            })
            .join('\n');

          return Promise.resolve(
            text(
              '## Price providers\n\n' +
                'Tried top to bottom; unconfigured and cooling-down providers are ' +
                'skipped.\n\n' +
                '| Provider | Key | Rate | Budget used | Status | Caps hit | Last reason |\n' +
                `|---|---|---|---|---|---|---|\n${rows}\n\n` +
                (shouldClear
                  ? `Cleared ${cleared} recorded cooldown(s).\n\n`
                  : '') +
                '### How this works\n\n' +
                'Usage is counted locally against each service\u2019s **documented** ' +
                'limits and checked *before* a request goes out, rather than ' +
                'inferred from a 429 afterwards — on a daily cap the rejected ' +
                'call still counts, so learning reactively costs a request that ' +
                'was never going to work. A 429 is still honoured as a backstop, ' +
                'since the same key may be in use elsewhere.\n\n' +
                'Windows roll over on their own: a new minute, hour, day or month ' +
                'produces a new counter and the old one stops applying. Counters ' +
                'persist across restarts, because a daily quota does not reset ' +
                'just because the process did.\n\n' +
                'Note Tiingo meters **unique symbols per month**, not just ' +
                'requests — one wide screen can spend a large share of the month ' +
                'while the request counters still look healthy. Re-reading a ' +
                'symbol already counted this month is free.\n\n' +
                '### If you pay for a plan\n\n' +
                'The figures above are each provider\u2019s **free tier**. Raise them ' +
                'so a paid plan is not throttled to free speed:\n\n' +
                '- `CIGAR_BUTT_BUDGET_<PROVIDER>_<PERIOD>` — call budget, e.g. ' +
                '`CIGAR_BUTT_BUDGET_POLYGON_MINUTE=0`. **0 means unlimited.**\n' +
                '- `CIGAR_BUTT_RATE_<PROVIDER>` — requests per second, e.g. ' +
                '`CIGAR_BUTT_RATE_POLYGON=100`.\n' +
                '- `CIGAR_BUTT_PROVIDER_ORDER=polygon,tiingo` — try what you pay ' +
                'for first; anything unlisted keeps its default order behind it.'
            )
          );
        })
      )
  );
}
