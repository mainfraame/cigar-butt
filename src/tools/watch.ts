import type { McpServer } from '@modelcontextprotocol/server';

import { sortBy } from 'lodash-es';
import * as z from 'zod/v4';

import { dec, out, ZERO } from '../math/decimal.ts';
import { channelAvailability, logPath } from '../watch/channels.ts';
import {
  latestSnapshot,
  listRules,
  putSnapshot,
  recentAlerts,
  recentRuns,
  removeRule,
  upsertRule,
  watchDbPath
} from '../watch/store.ts';
import { attempt, cell, DISCLAIMER, pct, text, usd } from './shared.ts';

/**
 * Read and manage the portfolio watch from a session.
 *
 * The MCP server never schedules anything — a stdio server is a subprocess and
 * dies with its client, so it cannot poll. The OS scheduler runs
 * `cigar-butt watch run`; these tools read and edit the same database.
 *
 * Two of them write local state, so `readOnlyHint` is honestly false. That is
 * not a breach of the read-only posture: the rule is that this server never
 * places an order and never mutates anything at the broker, and these do
 * neither.
 */

const DAY = 86_400;

/** The armed directions, in words rather than an em-dash in a slash pair. */
function describeThresholds(
  upPct: number | undefined,
  downPct: number | undefined
): string {
  if (upPct !== undefined && downPct !== undefined) {
    return `a rise of ${upPct}% or a fall of ${downPct}%`;
  }
  if (upPct !== undefined) return `a rise of ${upPct}%; falls ignored`;
  if (downPct !== undefined) return `a fall of ${downPct}%; rises ignored`;
  // The schema should stop this, so say plainly that it will never fire
  // rather than print an empty threshold pair that looks armed.
  return 'no threshold set, so it can never fire';
}

export function registerWatchTools(server: McpServer): void {
  server.registerTool(
    'watch_status',
    {
      annotations: { openWorldHint: false, readOnlyHint: true },
      description:
        'Whether the scheduled portfolio watch is working: recent runs and their ' +
        'outcomes, how old the holdings snapshot is, how many rules are armed, ' +
        'and where its files live. Check this before trusting that anything is ' +
        'being watched — a watch that quietly stopped is worse than none.',
      inputSchema: z.object({}).meta({ title: 'No arguments' }),
      title: 'Portfolio watch status'
    },
    () =>
      Promise.resolve(
        attempt(() => {
          const runs = recentRuns(5);
          const snapshot = latestSnapshot();
          const rules = listRules(true);
          const ageDays = snapshot
            ? Math.floor((Date.now() / 1000 - snapshot.takenAt) / DAY)
            : undefined;

          const runRows = runs
            .map(
              entry =>
                `| ${new Date(entry.startedAt * 1000).toISOString().slice(0, 16)} | ` +
                `${entry.outcome} | ${cell(entry.detail)} |`
            )
            .join('\n');

          return Promise.resolve(
            text(
              '## Portfolio watch\n\n' +
                (runs.length === 0
                  ? '**Never run.** Nothing is being watched yet. Install the ' +
                    'timer with `cigar-butt watch install`, then load it with ' +
                    '`launchctl load -w ~/Library/LaunchAgents/dev.cigar-butt.watch.plist`.\n\n'
                  : `| Started | Outcome | Detail |\n|---|---|---|\n${runRows}\n\n`) +
                `${rules.length} rule(s) armed.\n\n` +
                (snapshot
                  ? `Holdings snapshot: ${snapshot.holdings.length} position(s) from ` +
                    `${snapshot.source}, taken ${ageDays} day(s) ago.` +
                    (ageDays !== undefined && ageDays >= 1
                      ? ' **Share counts may have moved since.**'
                      : '') +
                    '\n\n'
                  : '**No holdings snapshot**, so price rules have nothing to watch. ' +
                    'Call `watch_snapshot_set`, or run `broker_positions` while ' +
                    'authorised and pass its holdings here.\n\n') +
                '### Channels\n\n' +
                channelAvailability()
                  .map(entry => `- \`${entry.channel}\` — ${entry.reason}`)
                  .join('\n') +
                `\n\nDatabase \`${watchDbPath()}\`, alert log \`${logPath()}\`.\n\n` +
                '**Alarm latency is the poll interval**, one hour by default. That ' +
                'is what free price tiers buy: Alpha Vantage allows 25 requests a ' +
                'day and Tiingo 50 an hour, so a tighter loop would exhaust them. ' +
                'This is a check, not a tripwire.' +
                DISCLAIMER
            )
          );
        })
      )
  );

  server.registerTool(
    'watch_alerts',
    {
      annotations: { openWorldHint: false, readOnlyHint: true },
      description:
        'Alerts the scheduled watch has fired: which name, the reference price ' +
        'and its date, the observed price and its date, the move, and which rule ' +
        'tripped. Every figure carries the date it is as of, so an alert can be ' +
        'checked rather than taken on faith.',
      inputSchema: z.object({
        limit: z.number().int().min(1).max(200).default(25)
      }),
      title: 'Fired alerts'
    },
    ({ limit }) =>
      Promise.resolve(
        attempt(() => {
          const alerts = recentAlerts(limit);
          if (alerts.length === 0) {
            return Promise.resolve(text('No alerts have fired.' + DISCLAIMER));
          }

          const rows = alerts
            .map(
              alert =>
                `| ${new Date(alert.firedAt * 1000).toISOString().slice(0, 16)} | ` +
                `${cell(alert.ticker)} | ${pct(out(alert.moveFraction))} | ` +
                `${usd(out(alert.referencePrice, 2))} | ` +
                `${usd(out(alert.observedPrice, 2))} | ${alert.observedAsOf} | ` +
                `${alert.ruleId} |`
            )
            .join('\n');

          return Promise.resolve(
            text(
              `## Fired alerts\n\n` +
                '| Fired | Ticker | Move | Reference | Observed | As of | Rule |\n' +
                `|---|---|---|---|---|---|---|\n${rows}\n\n` +
                'An alert is a prompt to look, not a plan. Re-check the name with ' +
                '`analyze_ticker` before acting: a price move against an unchanged ' +
                'balance sheet is the situation this whole method is built for, ' +
                'and it cuts both ways.' +
                DISCLAIMER
            )
          );
        })
      )
  );

  server.registerTool(
    'watch_rules',
    {
      annotations: { openWorldHint: false, readOnlyHint: true },
      description: 'List the armed watch rules and their thresholds.',
      inputSchema: z.object({}).meta({ title: 'No arguments' }),
      title: 'List watch rules'
    },
    () =>
      Promise.resolve(
        attempt(() => {
          const rules = sortBy(listRules(true), rule => rule.id);
          if (rules.length === 0) {
            return Promise.resolve(
              text(
                'No watch rules. Add one with `watch_rule_set` — for example, ' +
                  'alert on any held name moving 10% in either direction.' +
                  DISCLAIMER
              )
            );
          }

          const rows = rules
            .map(
              rule =>
                `| ${rule.id} | ${rule.ticker ?? 'every held name'} | ` +
                `${rule.upPct ? pct(out(rule.upPct)) : '—'} | ` +
                `${rule.downPct ? pct(out(rule.downPct)) : '—'} | ` +
                `${rule.cooldownSeconds / 3600}h | ${rule.rebaseline ? 'yes' : 'no'} | ` +
                `${rule.channels.join(', ')} | ${rule.enabled ? 'on' : 'off'} |`
            )
            .join('\n');

          return Promise.resolve(
            text(
              '## Watch rules\n\n' +
                '| Rule | Applies to | Up | Down | Cooldown | Re-baseline | Channels | State |\n' +
                `|---|---|---|---|---|---|---|---|\n${rows}\n\n` +
                'A rule fires once, then latches until the price comes back inside ' +
                'half its threshold — otherwise a name parked on the line re-fires ' +
                'every cycle. Re-baselining makes a name sliding 30% alert at 10, ' +
                '20 and 30 rather than only once.' +
                DISCLAIMER
            )
          );
        })
      )
  );

  server.registerTool(
    'watch_rule_set',
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false
      },
      description:
        'Create or update a price-move alarm. Writes local state only — this ' +
        'never touches the broker and never places an order. A rule with no ' +
        'ticker watches every name in the holdings snapshot.',
      inputSchema: z.object({
        channels: z
          .array(z.enum(['file', 'macos', 'stderr', 'webhook']))
          .min(1)
          .default(['stderr', 'file'])
          .describe('Where to deliver. `watch_status` lists what works here.'),
        cooldownHours: z
          .number()
          .min(0.25)
          .max(168)
          .default(6)
          .describe('Minimum gap between firings for the same name.'),
        downPct: z
          .number()
          .min(0.1)
          .max(99)
          .optional()
          .describe(
            'Alert on a fall of this many percent. Omit to ignore falls.'
          ),
        id: z.string().min(1).max(40).describe('Rule name, e.g. "drawdown".'),
        rebaseline: z
          .boolean()
          .default(false)
          .describe(
            'Reset the reference to the observed price after firing, so a long ' +
              'slide alerts repeatedly rather than once.'
          ),
        ticker: z
          .string()
          .max(10)
          .optional()
          .describe('Omit to watch every held name.'),
        upPct: z
          .number()
          .min(0.1)
          .max(999)
          .optional()
          .describe('Alert on a rise of this many percent.')
      }),
      title: 'Set a watch rule'
    },
    args =>
      Promise.resolve(
        attempt(() => {
          if (args.upPct === undefined && args.downPct === undefined) {
            return Promise.resolve(
              text(
                'A rule needs `upPct`, `downPct`, or both — otherwise it can never fire.'
              )
            );
          }

          upsertRule({
            baseline: 'reference',
            channels: args.channels,
            cooldownSeconds: Math.round(args.cooldownHours * 3600),
            downPct:
              args.downPct === undefined ? undefined : dec(args.downPct / 100),
            enabled: true,
            id: args.id,
            kind: 'move',
            rebaseline: args.rebaseline,
            ticker: args.ticker?.toUpperCase(),
            upPct: args.upPct === undefined ? undefined : dec(args.upPct / 100)
          });

          return Promise.resolve(
            text(
              `Armed **${args.id}** on ${args.ticker?.toUpperCase() ?? 'every held name'}: ` +
                // A bare "—" belongs in a table cell under a column heading
                // that explains it. In a sentence it reads as a rendering
                // fault, and a rule that ignores one direction should say so.
                `${describeThresholds(args.upPct, args.downPct)}, ` +
                `${args.cooldownHours}h cooldown, via ${args.channels.join(', ')}.\n\n` +
                'The first poll after arming records a reference price rather than ' +
                'firing — a rule must not alarm on a move it never watched.\n\n' +
                'Nothing polls until the timer is installed: `cigar-butt watch install`.' +
                DISCLAIMER
            )
          );
        })
      )
  );

  server.registerTool(
    'watch_rule_remove',
    {
      annotations: {
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false
      },
      description: 'Delete a watch rule and its recorded reference prices.',
      inputSchema: z.object({ id: z.string().min(1).max(40) }),
      title: 'Remove a watch rule'
    },
    ({ id }) =>
      Promise.resolve(
        attempt(() =>
          Promise.resolve(
            text(removeRule(id) ? `Removed "${id}".` : `No rule named "${id}".`)
          )
        )
      )
  );

  server.registerTool(
    'watch_snapshot_set',
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false
      },
      description:
        'Record the holdings the watch should monitor. Takes exactly the ' +
        '`holdings` shape `broker_positions` emits, so its output can be passed ' +
        'straight through.\n\n' +
        'This is what makes unattended monitoring possible at all: E*TRADE ' +
        'tokens die at midnight US Eastern with no refresh token, so no ' +
        'scheduled process can read your positions overnight. Snapshotting them ' +
        'while you are authorised lets the watch track prices indefinitely ' +
        'without the broker.',
      inputSchema: z.object({
        cash: z.number().nonnegative().default(0),
        holdings: z
          .array(
            z.object({
              asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
              price: z.number().positive(),
              shares: z.number().nonnegative(),
              ticker: z.string().min(1).max(10)
            })
          )
          .min(1)
          .max(300),
        source: z.enum(['etrade', 'manual']).default('manual')
      }),
      title: 'Record holdings for the watch'
    },
    ({ cash, holdings, source }) =>
      Promise.resolve(
        attempt(() => {
          putSnapshot({
            accountIdKey: undefined,
            cash: dec(cash) ?? ZERO,
            holdings: holdings.map(holding => ({
              ...holding,
              ticker: holding.ticker.toUpperCase()
            })),
            source
          });

          return Promise.resolve(
            text(
              `Recorded ${holdings.length} position(s) from ${source}.\n\n` +
                'Price rules will now watch these names. Refresh it whenever your ' +
                'positions change — every alert states the snapshot age, and one ' +
                'computed from a stale share count says so rather than pretending.' +
                DISCLAIMER
            )
          );
        })
      )
  );
}
