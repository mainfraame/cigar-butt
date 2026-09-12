import { groupBy } from 'lodash-es';

import { PROVIDERS, type ProviderSpec } from '../config/providers.ts';
import { type SetupReport, setupReport } from '../config/store.ts';

/**
 * The human-readable side of first-run setup.
 *
 * This server behaves like the Jira plugin's auth step: until credentials
 * exist, every research tool refuses and points here, and this module renders
 * the "here is what you need and where to get it" page. The text is generated
 * from the provider registry so it can never drift from what the code reads.
 */

function line(
  spec: ProviderSpec,
  configured: boolean,
  source?: string
): string {
  const mark = configured ? '[x]' : '[ ]';
  const where = configured ? ` (from ${source})` : '';
  const limit = spec.rateLimit ? `\n      Free tier: ${spec.rateLimit}` : '';

  // The walkthrough is the bulk of this output, so it appears only while the
  // credential is still missing. Once it is set the reader wants the checkbox,
  // not the instructions again.
  const steps =
    !configured && spec.setupSteps
      ? `\n\n      How to get one:\n${spec.setupSteps
          .map((step, index) => `        ${index + 1}. ${step}`)
          .join('\n\n')}`
      : '';

  return (
    `  ${mark} ${spec.label} — \`${spec.envVar}\`${where}\n` +
    `      ${spec.purpose}${limit}\n` +
    `      Sign up: ${spec.signupUrl}${steps}`
  );
}

/** Renders the whole credential picture as text for the calling model. */
export function renderSetup(report: SetupReport = setupReport()): string {
  const byRequirement = groupBy(
    report.statuses,
    status => status.spec.requirement
  );

  const sections: string[] = [];

  const hasSec = report.statuses.some(
    status => status.spec.id === 'sec' && status.configured
  );
  const hasPrices = !report.unsatisfiedGroups.includes('prices');

  sections.push(
    report.ready
      ? '## Setup complete\n\nEvery credential is present; all tools are available.'
      : '## Setup\n\nCredentials are optional and checked per tool — nothing is ' +
          'globally blocked. Fill in what you want and the rest of the server ' +
          'keeps working. Call `setup_credentials` with the values, or set the ' +
          'environment variables in your MCP client config.'
  );

  // Say what already works before listing what is missing. Most of this server
  // needs no credential at all, and a page that opens with blockers implies
  // otherwise.
  sections.push(
    '### What works right now\n\n' +
      '**No credential needed, ever:**\n' +
      '- `congress_trades`, `congress_member_profile`, `congress_house_filings` ' +
      '— Senate and House disclosures, committee seats, board seats\n' +
      '- `short_interest` — FINRA consolidated short interest\n' +
      '- `bank_call_report` — FDIC call reports for banks\n' +
      '- `build_allocation`, `plan_rebalance` — sizing and order planning on ' +
      'figures you supply\n\n' +
      `**With \`SEC_USER_AGENT\`${hasSec ? ' — set' : ' — not set'}:** ` +
      '`analyze_ticker`, `check_disqualifiers`, `screen_market`. This is the ' +
      'core of the server, it needs no registration, and it is the single ' +
      'highest-value thing to fill in.\n\n' +
      `**With a price key${hasPrices ? ' — set' : ' — not set'}:** \`get_quotes\`, ` +
      'and the P/TBV and price-to-NCAV verdicts inside `analyze_ticker`. ' +
      'Without one, `analyze_ticker` still reports the full balance sheet and ' +
      'says the price is unavailable rather than refusing.\n\n' +
      '**With E*TRADE keys:** reading your real holdings, balances and ' +
      'transactions.\n\n' +
      '**With `FRED_API_KEY`:** `macro_context`.'
  );

  const required = byRequirement['required'] ?? [];
  if (required.length > 0) {
    sections.push(
      `### Required\n\n${required.map(s => line(s.spec, s.configured, s.source)).join('\n\n')}`
    );
  }

  const oneOf = byRequirement['one-of'] ?? [];
  if (oneOf.length > 0) {
    sections.push(
      '### Price data — at least one required\n\n' +
        'Screening needs current prices; the balance sheet alone cannot tell you ' +
        'whether a name is cheap. Any one of these is enough, and Tiingo is the ' +
        'best free option.\n\n' +
        oneOf.map(s => line(s.spec, s.configured, s.source)).join('\n\n')
    );
  }

  const optional = byRequirement['optional'] ?? [];
  if (optional.length > 0) {
    sections.push(
      `### Optional\n\n${optional.map(s => line(s.spec, s.configured, s.source)).join('\n\n')}`
    );
  }

  sections.push(
    '### Quick reference — every sign-up link\n\n' +
      '| Provider | Needed | Register |\n|---|---|---|\n' +
      PROVIDERS.map(spec => {
        const need =
          spec.requirement === 'required'
            ? '**Required**'
            : spec.requirement === 'one-of'
              ? 'One of three'
              : 'Optional';
        return `| ${spec.label} | ${need} | ${spec.signupUrl} |`;
      }).join('\n') +
      '\n\nAll of these have a free tier. SEC EDGAR and FINRA need no ' +
      'registration at all; FDIC BankFind is unauthenticated too.'
  );

  sections.push(
    '### Quick reference — every sign-up link\n\n' +
      '| Provider | Needed | Register |\n|---|---|---|\n' +
      PROVIDERS.map(spec => {
        const need =
          spec.requirement === 'required'
            ? '**Required**'
            : spec.requirement === 'one-of'
              ? 'One of three'
              : 'Optional';
        return `| ${spec.label} | ${need} | ${spec.signupUrl} |`;
      }).join('\n') +
      '\n\nEvery one of these has a free tier. SEC EDGAR needs no registration ' +
      'at all — just a real name and email. FINRA short interest and FDIC ' +
      'BankFind are unauthenticated and always work.'
  );

  sections.push(
    '### Where values are stored\n\n' +
      `Environment variables win over the credential file at \`${report.configPath}\`, ` +
      'which is written 0600. Nothing is ever written into a project directory. ' +
      'To point the server at an existing dotenv file instead, set `CIGAR_BUTT_ENV_FILE`.'
  );

  if (!report.ready) {
    const blockers: string[] = [
      ...report.missingRequired.map(spec => `${spec.label} (${spec.envVar})`),
      ...report.unsatisfiedGroups.map(group => `at least one ${group} provider`)
    ];
    sections.push(
      `### Not set\n\n${blockers.map(b => `- ${b}`).join('\n')}\n\n` +
        'Each of these limits specific tools, listed above. None of them stops ' +
        'the server running.'
    );
  }

  return sections.join('\n\n');
}

/** Applies each provider's own validator. Returns messages, empty when clean. */
export function validateValues(
  values: Readonly<Record<string, string>>
): string[] {
  const problems: string[] = [];
  for (const [envVar, value] of Object.entries(values)) {
    if (value.trim().length === 0) continue;
    const spec = PROVIDERS.find(p => p.envVar === envVar);
    if (!spec) {
      problems.push(`${envVar} is not a credential this server reads.`);
      continue;
    }
    const problem = spec.validate?.(value.trim());
    if (problem) problems.push(`${envVar}: ${problem}`);
  }
  return problems;
}

/**
 * A short banner for stderr at startup.
 *
 * stdout is the MCP protocol stream and cannot be written to, but stderr is
 * free and is exactly where a client's install output and logs end up. So the
 * first thing a user sees after `claude mcp add cigar-butt` is what is missing
 * and where to get it, rather than a silent server that refuses its first tool
 * call for reasons they have to go digging for.
 */
export function startupBanner(report: SetupReport = setupReport()): string {
  const configured = report.statuses.filter(status => status.configured);

  if (report.ready) {
    return (
      `cigar-butt ready — ${configured.length} credential(s) configured.\n` +
      'Run the `setup_status` tool to see what is set and what is optional.'
    );
  }

  const blockers = [
    ...report.missingRequired.map(
      spec => `  ${spec.label} (${spec.envVar}) — ${spec.signupUrl}`
    ),
    ...report.unsatisfiedGroups.map(
      () =>
        '  A price provider — any one of:\n' +
        PROVIDERS.filter(spec => spec.requirement === 'one-of')
          .map(spec => `    ${spec.label} (${spec.envVar}) — ${spec.signupUrl}`)
          .join('\n')
    )
  ];

  return [
    `cigar-butt started with ${configured.length} of ${report.statuses.length} credentials set.`,
    'Credentials are optional and checked per tool — congressional disclosures,',
    'FINRA short interest, FDIC call reports and the portfolio maths all work',
    'with none at all.',
    '',
    'Not set:',
    ...blockers,
    '',
    'Ask your assistant to run `setup_credentials` to fill any of these in — it',
    'walks through each, including the E*TRADE API key process. `setup_status`',
    'lists every sign-up link and what each unlocks.',
    '',
    `Credentials are stored at ${report.configPath} (mode 0600).`
  ].join('\n');
}
