import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { fetchJson } from '../http/client.ts';

/**
 * Getting an alert in front of a person.
 *
 * An alarm nobody sees is worse than no alarm, because it buys the belief that
 * something is being watched. So delivery reports per-channel success and the
 * run records it — a webhook that has been 404ing for a week must be visible.
 *
 * Nothing here sends an account number, an account ID key or a cash balance. A
 * webhook is a third party, and a price move is all the information an alert
 * needs to be actionable.
 */

const run = promisify(execFile);

export type ChannelId = 'file' | 'macos' | 'stderr' | 'webhook';

export interface DeliveryResult {
  readonly channel: string;
  readonly error?: string;
  readonly ok: boolean;
}

export function logPath(): string {
  const override = process.env.CIGAR_BUTT_WATCH_LOG;
  if (override) return override;
  const xdg = process.env.XDG_STATE_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.local', 'state');
  return join(base, 'cigar-butt', 'alerts.log');
}

async function deliverMacos(title: string, body: string): Promise<void> {
  // osascript rather than a dependency. The body is passed as an argument, not
  // interpolated into the script, because an AppleScript string break would let
  // a ticker name run arbitrary script.
  await run('osascript', [
    '-e',
    'on run {t, b}\ndisplay notification b with title t\nend run',
    title,
    body
  ]);
}

function deliverFile(body: string): void {
  const path = logPath();
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${new Date().toISOString()}  ${body}\n`);
}

async function deliverWebhook(body: string): Promise<void> {
  const url = process.env.CIGAR_BUTT_WATCH_WEBHOOK;
  if (!url) throw new Error('CIGAR_BUTT_WATCH_WEBHOOK is not set.');

  // Slack and Discord both accept a JSON body with a text/content field, so one
  // shape covers the common cases without a per-service adapter.
  await fetchJson(url, {
    body: { content: body, text: body },
    rateKey: new URL(url).hostname,
    requestsPerSecond: 1
  });
}

/**
 * Sends one message to every requested channel.
 *
 * A failing channel never prevents the others: an alert that reached three of
 * four places is a success worth recording, and losing it because a webhook was
 * down would be the failure this whole feature exists to prevent.
 */
export async function deliver(
  channels: readonly string[],
  title: string,
  body: string
): Promise<DeliveryResult[]> {
  const results: DeliveryResult[] = [];

  for (const channel of channels) {
    try {
      switch (channel) {
        case 'file': {
          deliverFile(body);
          break;
        }
        case 'macos': {
          await deliverMacos(title, body);
          break;
        }
        case 'stderr': {
          // stdout is the MCP protocol stream even here, because the watch
          // shares modules with the server.
          process.stderr.write(`${title}\n${body}\n`);
          break;
        }
        case 'webhook': {
          await deliverWebhook(body);
          break;
        }
        default: {
          throw new Error(`Unknown channel "${channel}".`);
        }
      }
      results.push({ channel, ok: true });
    } catch (error) {
      results.push({
        channel,
        error: error instanceof Error ? error.message : String(error),
        ok: false
      });
    }
  }

  return results;
}

/** Channels usable on this machine right now, with why not when unavailable. */
export function channelAvailability(): {
  channel: ChannelId;
  reason: string;
}[] {
  return [
    {
      channel: 'stderr',
      reason: 'always available; visible in the launchd log'
    },
    { channel: 'file', reason: `appends to ${logPath()}` },
    {
      channel: 'macos',
      reason:
        process.platform === 'darwin'
          ? 'osascript notification'
          : 'unavailable: not macOS'
    },
    {
      channel: 'webhook',
      reason: process.env.CIGAR_BUTT_WATCH_WEBHOOK
        ? 'CIGAR_BUTT_WATCH_WEBHOOK is set'
        : 'unavailable: set CIGAR_BUTT_WATCH_WEBHOOK to a Slack or Discord URL'
    }
  ];
}
