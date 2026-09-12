import { writeFileSync } from 'node:fs';

import { PROVIDERS, type ProviderSpec } from '../src/config/providers.ts';

/**
 * Generates `docs/credentials.md` from the provider registry.
 *
 * Generated rather than written because the registry already carries every
 * signup URL, rate limit and walkthrough — it is what `setup_status` renders at
 * runtime. A hand-maintained copy would drift from what the server actually
 * reads, and a credentials page that is subtly wrong is worse than none. CI
 * regenerates and fails on any diff.
 *
 * Run: `pnpm docs:credentials`
 */

const OUT = new URL('../docs/credentials.md', import.meta.url);

/** Sources that need no credential at all. Not in the registry, by definition. */
const KEYLESS = [
  [
    'SEC EDGAR',
    '`analyze_ticker`, `check_disqualifiers`, `screen_market`',
    'Needs a contact string, not a key — see `SEC_USER_AGENT` below'
  ],
  ['FINRA', '`short_interest`', 'Consolidated short interest'],
  ['FDIC BankFind', '`bank_call_report`', 'Bank call reports'],
  [
    'Senate eFD',
    '`congress_trades`, `congress_member_profile`',
    'Official disclosures'
  ],
  ['House Clerk', '`congress_house_filings`', 'Official filing index'],
  [
    'congress-legislators',
    'committee cross-reference',
    'Committee and subcommittee rosters'
  ],
  ['Frankfurter (ECB)', '`fx_rate`', 'Daily reference exchange rates']
] as const;

const TUNING = [
  ['`CIGAR_BUTT_ENV_FILE`', 'Load credentials from a dotenv file at this path'],
  ['`CIGAR_BUTT_CONFIG`', 'Override the credential file location'],
  ['`CIGAR_BUTT_CACHE`', 'Override the response-cache database'],
  ['`CIGAR_BUTT_CONGRESS_DB`', 'Override the congressional index database'],
  ['`CIGAR_BUTT_NO_CACHE`', 'Set to `1` to bypass the cache entirely'],
  [
    '`CIGAR_BUTT_PROVIDER_ORDER`',
    'Preferred provider order, e.g. `polygon,tiingo`'
  ],
  [
    '`CIGAR_BUTT_RATE_<PROVIDER>`',
    'Requests per second, e.g. `CIGAR_BUTT_RATE_POLYGON=100`'
  ],
  [
    '`CIGAR_BUTT_BUDGET_<PROVIDER>_<PERIOD>`',
    'Call budget, e.g. `..._POLYGON_MINUTE=0`. **0 means unlimited**'
  ]
] as const;

function need(spec: ProviderSpec): string {
  if (spec.requirement === 'required') return '**Required**';
  return spec.requirement === 'one-of' ? 'Price pool' : 'Optional';
}

function section(spec: ProviderSpec): string {
  const lines = [
    `### ${spec.label}`,
    '',
    `\`${spec.envVar}\` — ${need(spec)}`,
    ''
  ];
  lines.push(spec.purpose, '');
  if (spec.rateLimit) lines.push(`**Free tier:** ${spec.rateLimit}`, '');
  lines.push(`**Sign up:** ${spec.signupUrl}`, '');
  if (spec.setupSteps) {
    lines.push('**How to get one:**', '');
    lines.push(...spec.setupSteps.map((step, i) => `${i + 1}. ${step}`), '');
  }
  return lines.join('\n');
}

const byRequirement = (want: ProviderSpec['requirement']): ProviderSpec[] =>
  PROVIDERS.filter(spec => spec.requirement === want);

const doc = `<!--
  GENERATED FILE — do not edit by hand.
  Written from src/config/providers.ts by scripts/generate-credentials-doc.ts.
  Run \`pnpm docs:credentials\` after changing the registry; CI fails on drift.
-->

# Credentials

Every integration cigar-butt can use, what it unlocks, and where to sign up.

**Credentials are optional and checked per tool.** Nothing is globally blocked —
a tool asks only for what it actually uses, so the rest of the server keeps
working while you fill things in. Start with \`SEC_USER_AGENT\` (no registration,
just a name and email) and one price provider; add the rest when you need them.

## Contents

- [Where credentials live](#where-credentials-live)
- [Works with no credential at all](#works-with-no-credential-at-all)
- [Required](#required)
- [Price providers](#price-providers)
- [Optional integrations](#optional-integrations)
- [Tuning](#tuning)

## Where credentials live

Resolution order is **environment variables first, then the credential file**, so
you can override one value for a single run without editing anything.

The file is written by the \`setup_credentials\` tool at mode \`0600\`:

\`\`\`
$XDG_CONFIG_HOME/cigar-butt/credentials.json
~/.config/cigar-butt/credentials.json          # fallback
\`\`\`

It is a flat JSON object keyed by the environment-variable names below:

\`\`\`json
{
${PROVIDERS.map(spec => `  "${spec.envVar}": "…"`).join(',\n')},
  "ETRADE_ENVIRONMENT": "production"
}
\`\`\`

Nothing is ever written into a project directory. To point the server at an
existing dotenv file instead, set \`CIGAR_BUTT_ENV_FILE\`. See
[\`.env.template\`](../.env.template) for an annotated example.

> **Do not commit a filled-in copy anywhere.** If a credential has been pasted
> into a chat, an issue or a log, rotate it — brokerage keys first.

## Works with no credential at all

| Source | Used by | Notes |
|---|---|---|
${KEYLESS.map(([source, used, note]) => `| ${source} | ${used} | ${note} |`).join('\n')}

## Required

${byRequirement('required')
  .map(spec => section(spec))
  .join('\n')}
## Price providers

Quote providers are a **failover pool**. A request tries them in order and skips
any that has no key, is cooling down, or has spent its budget — so **any one of
these is enough**, and more simply buys headroom. Usage is counted locally
against the documented limits below and checked before a request goes out.

\`provider_status\` shows consumption and can clear recorded caps.

| Provider | Variable | Free tier |
|---|---|---|
${byRequirement('one-of')
  .map(
    spec => `| ${spec.label} | \`${spec.envVar}\` | ${spec.rateLimit ?? '—'} |`
  )
  .join('\n')}

${byRequirement('one-of')
  .map(spec => section(spec))
  .join('\n')}
## Optional integrations

${byRequirement('optional')
  .map(spec => section(spec))
  .join('\n')}
## Tuning

All optional. The rate and budget defaults are each provider's **free tier**, so
raise them if you pay for more — otherwise a paid plan is throttled to free speed.

| Variable | Effect |
|---|---|
${TUNING.map(([name, effect]) => `| ${name} | ${effect} |`).join('\n')}
`;

writeFileSync(OUT, doc);
// eslint-disable-next-line no-console -- a build script, not the stdio server
console.log(`wrote ${OUT.pathname} (${PROVIDERS.length} providers)`);
