import {
  acceptedContent,
  inputRequired,
  type CallToolResult,
  type InputRequiredResult,
  type McpServer
} from '@modelcontextprotocol/server';

import * as z from 'zod/v4';

import { PROVIDERS } from '../config/providers.ts';
import { saveCredentials, setupReport } from '../config/store.ts';
import { renderSetup, validateValues } from '../setup/report.ts';
import { attempt, text, type ToolResult } from './shared.ts';

/**
 * First-run authentication.
 *
 * Two paths, because MCP clients differ. A client that supports elicitation
 * gets a real form with one field per provider, requested through the
 * `input_required` result the 2026-07-28 protocol uses. A client that does not
 * gets the registration links back as text and re-calls the tool with the
 * values as arguments. Either way the values land in the same 0600 credential
 * file, and neither path ever echoes a secret back into the transcript.
 */

/** One optional string field per provider, built from the registry. */
const credentialForm = z.object({
  ALPHAVANTAGE_API_KEY: z
    .string()
    .optional()
    .meta({ title: 'Alpha Vantage API key (optional)' }),
  ETRADE_PROD_CONSUMER_KEY: z
    .string()
    .optional()
    .meta({
      description:
        'Reads your real holdings, balances and transactions. Read-only — this ' +
        'server never places an order. Obtain at ' +
        'https://developer.etrade.com/getting-started; `setup_status` spells out ' +
        'the three-form process.',
      title: 'E*TRADE production consumer key (optional)'
    }),
  ETRADE_PROD_CONSUMER_SECRET: z
    .string()
    .optional()
    .meta({ title: 'E*TRADE production consumer secret (optional)' }),
  ETRADE_SANDBOX_CONSUMER_KEY: z
    .string()
    .optional()
    .meta({
      description:
        'Synthetic data, for proving the connection works. Instant and ' +
        'self-service at https://us.etrade.com/etx/ris/apikey',
      title: 'E*TRADE sandbox consumer key (optional)'
    }),
  ETRADE_SANDBOX_CONSUMER_SECRET: z
    .string()
    .optional()
    .meta({ title: 'E*TRADE sandbox consumer secret (optional)' }),
  FRED_API_KEY: z
    .string()
    .optional()
    .meta({ title: 'FRED API key (optional)' }),
  POLYGON_API_KEY: z
    .string()
    .optional()
    .meta({ title: 'Polygon.io API key (optional)' }),
  SEC_USER_AGENT: z
    .string()
    .optional()
    .meta({
      description:
        'Required. A real name and email, e.g. "Jane Doe jane@example.com". ' +
        'EDGAR returns 403 without one and may block the IP. No registration needed.',
      title: 'SEC EDGAR User-Agent'
    }),
  TIINGO_API_KEY: z.string().optional().meta({
    description:
      'Recommended price source. Free key at https://www.tiingo.com/account/api/token',
    title: 'Tiingo API token'
  })
});

export function registerSetupTools(server: McpServer): void {
  server.registerTool(
    'setup_status',
    {
      annotations: { openWorldHint: false, readOnlyHint: true },
      description:
        'Report which API credentials are configured, where each value came from, ' +
        'and the sign-up URL for anything missing. Call this first in a new session, ' +
        'and whenever another tool reports that the server is not configured.',
      inputSchema: z.object({}).meta({ title: 'No arguments' }),
      title: 'Check credential setup'
    },
    () => Promise.resolve(text(renderSetup()))
  );

  server.registerTool(
    'setup_credentials',
    {
      annotations: {
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
        readOnlyHint: false
      },
      description:
        'Store API credentials for this server. Call with no arguments to prompt the ' +
        'user for them. Call with arguments to save values the user has already given ' +
        'you. Values are written to a 0600 file in the user config directory, never ' +
        'into a project. Pass an empty string to remove a credential.',
      inputSchema: credentialForm,
      title: 'Configure API credentials'
    },
    (args, ctx): Promise<CallToolResult | InputRequiredResult> =>
      attempt(async () => {
        const direct = pickSupplied(args as Record<string, unknown>);
        if (Object.keys(direct).length > 0) return save(direct);

        // A prior round of this same call may already carry the user's answers.
        const answered = acceptedContent(
          ctx.mcpReq.inputResponses,
          'credentials',
          credentialForm
        );
        if (answered) {
          const supplied = pickSupplied(answered as Record<string, unknown>);
          return Object.keys(supplied).length > 0
            ? save(supplied)
            : text(
                `Nothing was entered, so nothing was saved.\n\n${renderSetup()}`
              );
        }

        return inputRequired({
          inputRequests: {
            credentials: inputRequired.elicit({
              message:
                'cigar-butt needs API credentials before it can screen. The SEC ' +
                'User-Agent is mandatory and needs no registration — just a real ' +
                'name and email. At least one price provider is also needed; ' +
                'Tiingo is the best free option. Leave anything you do not have blank.',
              requestedSchema: credentialForm
            })
          }
        });
      })
  );
}

/** Keeps only non-undefined string values for keys the registry knows. */
function pickSupplied(source: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(source ?? {}).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' &&
        PROVIDERS.some(spec => spec.envVar === entry[0])
    )
  );
}

function save(values: Record<string, string>): ToolResult {
  const problems = validateValues(values);
  if (problems.length > 0) {
    return text(
      `Nothing was saved — these values did not validate:\n\n${problems
        .map(problem => `- ${problem}`)
        .join('\n')}`
    );
  }

  const written = saveCredentials(values);
  const report = setupReport();

  // Never echo a credential back, not even partially: tool output lands in a
  // transcript that may be logged or shared.
  return text(
    `Saved ${written.length} credential(s) to ${report.configPath}.\n\n${renderSetup(report)}`
  );
}
