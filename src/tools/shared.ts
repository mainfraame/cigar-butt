import type { CallToolResult } from '@modelcontextprotocol/server';

import { setupReport } from '../config/store.ts';
import { renderSetup } from '../setup/report.ts';

/** The shape `registerTool` handlers return. */
export type ToolResult = CallToolResult;

export const text = (body: string): ToolResult => ({
  content: [{ text: body, type: 'text' }]
});

const failure = (body: string): ToolResult => ({
  content: [{ text: body, type: 'text' }],
  isError: true
});

/** What a tool needs to do its job. Checked per tool, never globally. */
export type Capability = 'prices' | 'sec';

const CAPABILITY_NEED: Record<Capability, string> = {
  prices:
    'a price provider (`TIINGO_API_KEY`, `POLYGON_API_KEY` or ' +
    '`ALPHAVANTAGE_API_KEY` — any one will do, and all three are free)',
  sec:
    '`SEC_USER_AGENT` — a real name and email, e.g. "Jane Doe jane@example.com". ' +
    'There is nothing to register for; EDGAR just wants to know who is calling'
};

/**
 * Guards one tool on the credentials it actually uses.
 *
 * Deliberately per-tool rather than a single global gate. Most of this server
 * needs no credential at all — SEC EDGAR wants only a contact string, and
 * FINRA, FDIC and the congressional sources want nothing — so refusing every
 * tool until a price key exists would hide work the user can already do. A
 * tool that never touches prices should never mention them.
 */
export function requireCapabilities(
  ...needed: readonly Capability[]
): ToolResult | undefined {
  const report = setupReport();

  const has = (capability: Capability): boolean =>
    capability === 'sec'
      ? report.statuses.some(
          status => status.spec.id === 'sec' && status.configured
        )
      : !report.unsatisfiedGroups.includes('prices');

  const missing = needed.filter(capability => !has(capability));
  if (missing.length === 0) return undefined;

  return failure(
    `This tool needs ${missing.map(capability => CAPABILITY_NEED[capability]).join(', and ')}.\n\n` +
      'Run `setup_credentials` to provide it, or `setup_status` for every ' +
      'sign-up link.\n\n' +
      `${renderSetup(report)}`
  );
}

/** Wraps a handler so an upstream failure becomes a readable tool error. */
export async function attempt<T>(
  run: () => Promise<T | ToolResult>
): Promise<T | ToolResult> {
  try {
    return await run();
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

/** Formats an optional number for a markdown cell. */
export const cell = (
  value: number | string | undefined,
  suffix = ''
): string => (value === undefined ? '—' : `${value}${suffix}`);

/** Formats a fraction as a percentage string. */
export const pct = (value: number | undefined): string =>
  value === undefined ? '—' : `${(value * 100).toFixed(1)}%`;

/** Formats a dollar figure with thousands separators. */
export const usd = (value: number | undefined): string =>
  value === undefined
    ? '—'
    : value.toLocaleString('en-US', {
        currency: 'USD',
        maximumFractionDigits: 2,
        style: 'currency'
      });

/**
 * Appended to every tool that produces or implies a portfolio decision.
 *
 * This is a screen, not advice. Stating it once per response rather than once
 * per session matters because a model may surface a single tool result to the
 * user without the surrounding conversation.
 */
export const DISCLAIMER =
  '\n\n---\n*Not investment advice. This tool reports figures from public ' +
  'filings and market data; it does not know your circumstances, and a screen ' +
  'is not diligence. Verify every figure against the filing before acting.*';

/**
 * Appended above `DISCLAIMER` on any tool that prints a tax classification or a
 * gain figure.
 *
 * The boundary is the same as the investment one and drawn for the same reason:
 * this server may state what a broker records, and may do arithmetic on two
 * figures it was given, but it may not compute a liability. Holding period,
 * wash sales and basis adjustments are not modelled, and a number that looks
 * like a tax bill would be believed as one.
 */
export const TAX_NOTE =
  '\n\n*Not tax advice. Account classification and cost basis are reported as ' +
  'your broker records them, not computed here, and may differ from the basis ' +
  'on your 1099-B. Gain figures are arithmetic, not a tax liability: holding ' +
  'period, wash sales, basis adjustments and your own circumstances are not ' +
  'modelled. Confirm against your broker\u2019s records and a tax professional ' +
  'before acting.*';

/**
 * Appended where an execution cost or a participation figure appears.
 *
 * The proportion is the whole point. Selling $10,000 costs about $0.41 in
 * statutory fees, while spread and market impact on a micro cap run to a
 * hundred times that — and the spread is not observable from any provider this
 * server can reach. A penny-exact fee printed without this reads as *the* cost
 * of trading, which would be wrong by two orders of magnitude in exactly the
 * illiquid names this method selects for.
 */
export const COST_NOTE =
  '\n\n*Fee figures are statutory charges and commission only — not the cost ' +
  'of trading. Bid-ask spread and market impact are typically far larger on a ' +
  'thinly-traded name, are not observable from any data source here, and are ' +
  'not estimated. Read participation (the order as a share of a normal ' +
  'session) as the cost signal. Statutory rates change without much notice; ' +
  'the effective dates are reported so a stale figure is visible.*';
