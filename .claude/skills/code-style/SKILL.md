---
name: code-style
description: Enforce TypeScript code style for cigar-butt. Use for control flow, decimal.js arithmetic, lodash-es collection work, three-state undefined handling, dated figures, error messages, and MCP tool output.
---

# Code Style Enforcement

Apply these patterns to all TypeScript in this repository. They sit on top of
`STYLEGUIDE.md`, which is authoritative — where the two overlap they agree;
where `STYLEGUIDE.md` is silent, these rules apply. Domain rules that are about
being _correct_ rather than _tidy_ live in `CLAUDE.md`; the ones repeated here
(rules 1, 2, 3, 4) are repeated because they are violated by ordinary-looking
code.

## When to Use

- Writing or refactoring anything under `src/`
- Reviewing a diff for style violations
- Cleaning up code before `pnpm check`

## Rules

### 1. All Arithmetic Through decimal.js

`number` at the I/O boundary, `Decimal` everywhere else. Coerce with `dec`,
divide with `div`, serialise with `out`/`money` from `src/math/decimal.ts`.

```typescript
/* Bad */
const ptbv = price / tangibleBookPerShare;
if (ptbv < 1.0) { ... }

/* Good */
const ptbv = div(price, metrics.tangibleBookPerShare);
if (ptbv?.lt(1)) { ... }
```

Decimal literals are passed as **strings**, so they never touch a float:

```typescript
/* Bad */
metrics.debtToEquity?.lt(0.2);
inventory.times(0.5);

/* Good */
metrics.debtToEquity?.lt('0.2');
inventory.times(INVENTORY_HAIRCUT); /* = '0.5' */
```

Never `Number()` mid-pipeline. Share counts round down (`.floor()`, or
`.toDecimalPlaces(n, Decimal.ROUND_DOWN)`) so a plan cannot exceed the balance.

### 2. lodash-es For Collection Work

`sortBy`, `groupBy`, `keyBy`, `sumBy`, `maxBy`. It is a declared dependency and
the codebase is consistent about it.

```typescript
/* Bad */
const total = lines.reduce((sum, line) => sum + line.cost, 0);
const byTicker = Object.fromEntries(holdings.map(h => [h.ticker, h]));
const newest = items.sort((a, b) => (a.filed > b.filed ? -1 : 1))[0];

/* Good */
const total = sumBy(lines, line => line.cost);
const byTicker = keyBy(holdings, holding => holding.ticker);
const newest = maxBy(items, item => item.filed);
```

`map`/`filter`/`find`/`some` stay native — the rule is about the five helpers
above, not about banning array methods.

### 3. `undefined` Is Not `false`

`undefined` means "could not be computed"; `false` means "failed the test". Any
rewrite that merges them is a bug, not a simplification.

```typescript
/* Bad — a missing line item now reads as a failed check */
pass: metrics.netCash?.isPositive() ?? false;
pass: Boolean(priceToNcav?.lt(NET_NET_DISCOUNT));
if (!check.pass) reject(name);

/* Good */
pass: metrics.netCash?.isPositive();
if (check.pass === false) reject(name);
if (check.pass === undefined) reportAsUncomputable(name);
```

This is the one place the general "lean on falsiness" instinct is wrong. An
optional chain feeding a three-state value is the tell.

### 4. Every Figure Carries Its Date

No value leaves this server undated, and nothing is ever filled in from memory.

```typescript
/* Bad */
return { price: row.close, ticker };

/* Good */
return { asOf: row.date.slice(0, 10), price, source: 'tiingo', ticker };
```

When a derived figure has several inputs, report the **oldest** date — a metric
is only as current as its stalest input. Dates are ISO `YYYY-MM-DD` strings and
compare correctly as strings; don't round-trip through `Date` to compare.

### 5. Inject The Clock

Anything reasoning about dates takes `now` as a defaulted option. A test that
depends on the wall clock is a test that fails in December.

```typescript
/* Bad */
function scan(summary: SubmissionsSummary) {
  const cutoff = new Date(Date.now() - 730 * DAY_MS);
}

/* Good */
function scan(
  summary: SubmissionsSummary,
  { lookbackDays = 730, now = new Date() }: { lookbackDays?: number; now?: Date } = {}
) { ... }
```

### 6. Flatten Control Flow

No nested `if`. Early returns and guard clauses first.

```typescript
/* Bad */
if (spec) {
  if (getCredential(spec.envVar)) {
    return true;
  }
}
return false;

/* Good */
if (!spec) return false;

return getCredential(spec.envVar) !== undefined;
```

### 7. Const Over Let

`let` only for a value genuinely assigned across branches or in a retry loop
(`lastError`, `response` in `http/client.ts`). Everything else is `const`.

### 8. Sequential Await In Fetch Loops Is Correct

Every upstream is rate limited (SEC 10/s, Polygon 5/min, Tiingo ~50/hr) and the
per-host throttle serialises anyway. `eslint/no-await-in-loop` is off on purpose.

```typescript
/* Bad — trips the rate limit and reorders the retry backoff */
const results = await Promise.all(tickers.map(quote));

/* Good */
for (const ticker of tickers) {
  found.push(await quote(ticker));
}
```

### 9. Report Every Failure In A Fallback Chain

A single "no price" message hides which of "bad ticker", "no key" and "rate
limited" happened. Collect one line per attempt and throw them all.

```typescript
/* Bad */
throw new Error(`No price available for ${ticker}.`);

/* Good */
throw new Error(
  `No price available for ${ticker}. Tried:\n${failures.map(f => `  - ${f}`).join('\n')}`
);
```

### 10. Error Messages Name The Fix

The reader is a model that can act. Say which credential, which env var, where
to register.

```typescript
/* Bad */
throw new Error('Missing credentials.');

/* Good */
throw new Error(
  `${spec.label} is not configured. Run the \`setup_credentials\` tool, or ` +
    `set ${spec.envVar}. Register at ${spec.signupUrl}`
);
```

Distinguish absent from broken: a 404 from `companyconcept` means the filer
never tagged that concept — return `[]`, don't throw.

### 11. No `console` In `src/`

Stdout is the MCP protocol channel; a stray write corrupts the frame stream.
`eslint/no-console` is an error. Diagnostics go into the tool result or stderr.

### 12. Never Echo A Credential

Not even partially, not even a length or a prefix. Tool output lands in a
transcript that may be logged or shared. URLs that can carry a key go through
`redactUrl` before appearing in any message.

### 13. Absent Renders As `—`, Never As `0`

Use the shared formatters in `src/tools/shared.ts`.

```typescript
/* Bad */
`| ${metrics.ncavPerShare ?? 0} |`
/* Good */
`| ${cell(out(metrics.ncavPerShare))} |``| ${usd(line.cost)} | ${pct(line.weight)} |`;
```

### 14. `readonly` On Exported Data Shapes

Reports, plans and specs are read downstream, never mutated.

```typescript
/* Bad */
export interface DisqualifierReport {
  flags: Flag[];
}

/* Good */
export interface DisqualifierReport {
  readonly flags: readonly Flag[];
}
```

### 15. Narrow Raw Upstream Types At The Module Edge

Give an upstream response a local `interface` with everything optional — the
optionality is the documentation that upstreams lie — and convert to the
internal shape before returning. A raw response type never escapes its `data/`
module.

### 16. Object Parameters Over Many Positional Args

More than two arguments becomes one options object, so call sites are
self-documenting and order-independent.

### 17. Named Exports, Type-Only Imports Marked

`verbatimModuleSyntax` is on. Use `import type` (or an inline `type` specifier)
for anything used only as a type — `typescript/consistent-type-imports` is an
error. Relative imports carry the `.ts` extension.

### 18. Lean On Inference

Annotate a return type at an exported boundary where the contract matters, or
where TS cannot infer it. Not on internal helpers, and not on variables.

```typescript
/* Bad */
const failures: string[] = []; /* fine — TS can't infer from [] */
const spec: ProviderSpec | undefined = providerById(id); /* redundant */

/* Good */
const spec = providerById(id);
```

### 19. Minimal In-Function Comments, Substantial Module Headers

Inside a function, comments are rare and short: a non-obvious invariant, never
narration. At the top of a module, a block comment explaining what the module is
for and which failure it prevents is the house style — that reasoning cannot be
recovered from the code. Any disabled rule or empty `catch` carries a why.

### 20. Prefer A Node 24 Builtin To A Dependency

`node:sqlite` for the cache, `process.loadEnvFile` for dotenv, `fetch` for HTTP.
Adding a package has to clear the supply-chain gate in `pnpm-workspace.yaml` and
`pnpm audit --audit-level moderate` in the pre-commit hook.

### 21. Let The Formatter And Perfectionist Win

oxfmt owns whitespace and import order; `eslint-plugin-perfectionist` (running
inside oxlint via `jsPlugins`) owns object-key, interface-member, union and
export ordering, alphabetically. Run `pnpm lint:fix` and `pnpm format` rather
than arguing with either. If a literal genuinely reads better grouped, that is a
sign it wants to be two objects.
