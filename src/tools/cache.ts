import type { McpServer } from '@modelcontextprotocol/server';

import * as z from 'zod/v4';

import { purge, stats, TTL, vacuumExpired } from '../cache/store.ts';
import { attempt, text } from './shared.ts';

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
}
