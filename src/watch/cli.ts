import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { loadEnvFile } from '../config/store.ts';
import { dec } from '../math/decimal.ts';
import { channelAvailability, deliver, logPath } from './channels.ts';
import { runCycle } from './run.ts';
import {
  listRules,
  recentAlerts,
  recentRuns,
  removeRule,
  upsertRule,
  watchDbPath
} from './store.ts';

/**
 * The `cigar-butt watch` command tree.
 *
 * A short-lived process invoked by the OS scheduler, not a resident daemon:
 * launchd already solves restart-on-crash, run-after-wake, survive-logout and
 * run-on-a-calendar, and a hand-rolled daemon with a pidfile solves none of
 * them as well.
 *
 * Everything here writes to **stderr**. The watch shares modules with the stdio
 * server, where stdout is the protocol stream, so no code reachable from both
 * may ever print to it.
 */

const say = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const LABEL = 'dev.cigar-butt.watch';

function plistPath(): string {
  return join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
}

/**
 * Hourly by default, aligned with the price cache TTL.
 *
 * Shorter is allowed but costly: free tiers are the binding constraint — Alpha
 * Vantage allows 25 requests a day — and a 20-name book polled every 15 minutes
 * is 80 quotes an hour. An hourly alarm is what a free tier buys, and saying so
 * beats shipping a five-minute default that quietly 429s.
 */
const DEFAULT_INTERVAL_MINUTES = 60;

/**
 * Absolute path to the script launchd should run.
 *
 * `process.argv[1]`, not anything derived from `import.meta.url`. The published
 * artifact is a single bundled file, so a path computed from this module's own
 * location is correct in the source tree and one directory too shallow once
 * bundled. That produced a plist pointing at a file that does not exist — the
 * worst failure available here, because the timer then fails silently while
 * `watch status` still reports it installed.
 */
function entryPoint(): string {
  const argv = process.argv[1];
  if (!argv) throw new Error('Cannot determine which script to schedule.');
  return resolve(argv);
}

function plist(intervalMinutes: number): string {
  const node = process.execPath;
  const entry = entryPoint();
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${node}</string>
    <string>${entry}</string>
    <string>watch</string>
    <string>run</string>
  </array>
  <key>StartInterval</key><integer>${intervalMinutes * 60}</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardErrorPath</key><string>${logPath()}.launchd</string>
  <key>StandardOutPath</key><string>${logPath()}.launchd</string>
</dict>
</plist>
`;
}

function usage(): void {
  say(`cigar-butt watch — scheduled portfolio monitoring

  run [--force]        One poll cycle. What the timer calls.
                       --force ignores the market-hours gate.
  status               Last runs, rules, alerts, database location.
  rules                List armed rules.
  rule add <id> <ticker|*> <pct>   Arm a move rule, e.g. "rule add drop AAPL 10".
  rule rm <id>         Remove a rule.
  alerts [n]           Recent fired alerts.
  channels             Which delivery channels work on this machine.
  test [channel]       Send one dummy alert. Default: stderr.
  install [minutes]    Write a launchd agent (macOS). Default ${DEFAULT_INTERVAL_MINUTES} minutes.
  uninstall            Remove it.

This never places, modifies or cancels an order. It reads prices and tells you.`);
}

async function main(argv: readonly string[]): Promise<number> {
  loadEnvFile();
  const [command = 'status', ...rest] = argv;

  switch (command) {
    case 'alerts': {
      const alerts = recentAlerts(Number(rest[0] ?? 20));
      if (alerts.length === 0) say('No alerts fired yet.');
      for (const alert of alerts) {
        say(`${new Date(alert.firedAt * 1000).toISOString()}  ${alert.body}`);
      }
      return 0;
    }

    case 'channels': {
      for (const entry of channelAvailability()) {
        say(`  ${entry.channel.padEnd(8)} ${entry.reason}`);
      }
      return 0;
    }

    case 'install': {
      if (process.platform !== 'darwin') {
        say(
          'launchd is macOS-only. On Linux, run this on a systemd user timer or cron:'
        );
        say(
          `  */${DEFAULT_INTERVAL_MINUTES} * * * * ${process.execPath} $(command -v cigar-butt) watch run`
        );
        return 1;
      }
      const minutes = Number(rest[0] ?? DEFAULT_INTERVAL_MINUTES);
      if (!Number.isFinite(minutes) || minutes < 5) {
        say(
          'Interval must be at least 5 minutes; free price tiers cannot sustain less.'
        );
        return 1;
      }
      if (minutes < DEFAULT_INTERVAL_MINUTES) {
        say(
          `Warning: a ${minutes}-minute interval will out-pace the price cache ` +
            '(1 hour) and burn free-tier quota. Check `provider_status` after a day.'
        );
      }
      const entry = entryPoint();
      if (!existsSync(entry)) {
        say(`Refusing to install: ${entry} does not exist.`);
        say('Run `pnpm build` first, or install the package globally.');
        return 1;
      }

      const path = plistPath();
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, plist(minutes));
      say(`Wrote ${path}`);
      say(`  runs: ${process.execPath} ${entry} watch run`);
      say('Load it with:  launchctl load -w ' + path);
      say(
        `Alarm latency will be about ${minutes} minutes. That is what free price tiers buy.`
      );
      return 0;
    }

    case 'rule': {
      const [action, id, ticker, pct] = rest;
      if (action === 'rm' && id) {
        say(removeRule(id) ? `Removed ${id}.` : `No rule "${id}".`);
        return 0;
      }
      if (action === 'add' && id && ticker && pct) {
        const threshold = dec(Number(pct) / 100);
        if (!threshold) {
          say('Percentage must be a number, e.g. 10 for 10%.');
          return 1;
        }
        upsertRule({
          baseline: 'reference',
          channels: ['stderr', 'file'],
          cooldownSeconds: 6 * 60 * 60,
          downPct: threshold,
          enabled: true,
          id,
          kind: 'move',
          rebaseline: false,
          ticker: ticker === '*' ? undefined : ticker.toUpperCase(),
          upPct: threshold
        });
        say(`Armed "${id}": ${ticker} at ±${pct}%.`);
        return 0;
      }
      usage();
      return 1;
    }

    case 'rules': {
      const rules = listRules(true);
      if (rules.length === 0)
        say('No rules. Add one: cigar-butt watch rule add drop AAPL 10');
      for (const rule of rules) {
        say(
          `  ${rule.id.padEnd(14)} ${(rule.ticker ?? '*').padEnd(8)} ` +
            `up ${rule.upPct?.times(100).toString() ?? '—'}%  ` +
            `down ${rule.downPct?.times(100).toString() ?? '—'}%  ` +
            `${rule.enabled ? 'enabled' : 'disabled'}  → ${rule.channels.join(',')}`
        );
      }
      return 0;
    }

    case 'run': {
      const result = await runCycle({ force: rest.includes('--force') });
      say(`${result.outcome}: ${result.detail}`);
      // Non-zero on a degraded run so launchd's log shows it rather than
      // reporting a clean exit for a watch that saw nothing.
      return result.outcome === 'ok' ? 0 : 1;
    }

    case 'status': {
      say(`database   ${watchDbPath()}`);
      say(`alert log  ${logPath()}`);
      say(
        `agent      ${process.platform === 'darwin' ? plistPath() : 'n/a (macOS only)'}`
      );
      const runs = recentRuns(5);
      say(runs.length === 0 ? 'No runs yet.' : 'Recent runs:');
      for (const entry of runs) {
        say(
          `  ${new Date(entry.startedAt * 1000).toISOString()}  ` +
            `${entry.outcome.padEnd(8)} ${entry.detail ?? ''}`
        );
      }
      say(
        `${listRules(true).length} rule(s), ${recentAlerts(1000).length} alert(s) on record.`
      );
      return 0;
    }

    case 'test': {
      const channel = rest[0] ?? 'stderr';
      const results = await deliver(
        [channel],
        'cigar-butt: test alert',
        'This is a test. Nobody should discover a broken webhook during a drawdown.'
      );
      for (const result of results) {
        say(
          `  ${result.channel}: ${result.ok ? 'ok' : `FAILED — ${result.error}`}`
        );
      }
      return results.every(result => result.ok) ? 0 : 1;
    }

    case 'uninstall': {
      try {
        unlinkSync(plistPath());
        say(
          `Removed ${plistPath()}. Unload it with: launchctl unload ${plistPath()}`
        );
      } catch {
        say('No launchd agent installed.');
      }
      return 0;
    }

    default: {
      usage();
      return command === 'help' || command === '--help' ? 0 : 1;
    }
  }
}

export async function runWatchCli(argv: readonly string[]): Promise<void> {
  process.exitCode = await main(argv);
}
