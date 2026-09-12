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

/**
 * Research tools refuse to run before setup, the way an unauthenticated Jira
 * plugin refuses. Returning the setup page rather than a bare error means the
 * calling model can fix the problem in one turn.
 */
export function requireSetup(): ToolResult | undefined {
  const report = setupReport();
  if (report.ready) return undefined;
  return failure(
    `This server is not configured yet.\n\n${renderSetup(report)}\n\n` +
      'Call `setup_credentials` once the user has the keys above.'
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
