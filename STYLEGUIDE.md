# cigar-butt Code Style Guide

This guide governs all TypeScript in this repository. It is committed verbatim
and every file must follow it. Where it and `.claude/skills/code-style/SKILL.md`
overlap, they agree; where this guide is silent, the skill applies.

## General

- **Node 24.21.0 (see `.nvmrc`), TypeScript `strict` everywhere.** No `any`
  unless justified with a comment. Prefer `unknown` and narrow.
- **ES modules only.** `import`/`export`, never `require`. `verbatimModuleSyntax`
  is on: a type-only import must say `import type` (or use an inline
  `type` specifier), and oxlint's `typescript/consistent-type-imports` enforces it.
- **Relative imports carry the `.ts` extension** —
  `import { dec } from '../math/decimal.ts'`. `allowImportingTsExtensions` +
  `rewriteRelativeImportExtensions` make this the correct form here; tsdown
  rewrites it at build time.
- **2-space indentation, 80 columns, LF, trailing newline.** oxfmt owns all of
  it — never hand-format against it.
- **Single quotes**, backticks for interpolation, semicolons always, no trailing
  commas, `arrowParens: avoid`.
- **Named exports only.** There is no framework here that requires a default.
- **No dead code.** Delete rather than comment out; `pnpm knip` will find it
  anyway.
- **Layers flow one way**: `config` → `http` → `data` → `analysis` →
  `portfolio` → `tools`. `import/no-cycle` is an error.

## Naming

- `camelCase` for variables, functions, methods.
- `PascalCase` for types, interfaces, classes, zod schema constants.
- `SCREAMING_SNAKE_CASE` for module-level constants that are true constants
  (`CONCEPTS`, `TTL`, `PROVIDERS`, `EIGHT_K_ITEMS`, `MAX_ATTEMPTS`).
- Filenames are `kebab-case.ts`. Directory names are the layer.
- Boolean names read as predicates: `isFinancial`, `clear`, `configured`,
  `allowFractionalShares`.
- Domain terms keep their domain spelling: `ncav`, `nnwc`, `tangibleBook`,
  `cik`, `accn`, `asOf`. Do not expand them into prose names.

## Ordering

`eslint-plugin-perfectionist` runs inside oxlint (the `jsPlugins` field in
`.oxlintrc.json`) and enforces `natural`, ascending, case-sensitive ordering of:
object literal keys, interface and object-type members, union and intersection
members, enum members, class members, array `includes` literals, and exports.
Import ordering is oxfmt's (`sortImports`: scoped packages, then
builtin/external, then internal, then relative, then types).

This is why object literals throughout the codebase read alphabetically rather
than logically. Don't fight it — run `pnpm lint:fix`. If a literal genuinely
reads better grouped, that's a sign it wants to be two objects.

## Numbers — the decimal.js rule

**`number` appears at the I/O boundary and nowhere in between.** Untrusted JSON
arrives as `number`, tool responses leave as `number`, and everything between is
`Decimal`.

- Coerce with `dec()`. It returns `undefined` for null, empty string, non-finite
  values and anything that fails to parse.
- Divide with `div()`. It returns `undefined` rather than `Infinity` or `NaN`
  on a zero or absent denominator.
- Sum optional values with `sum()`.
- Serialise only at the boundary: `out(value, places)` for ratios and share
  counts, `money(value)` for currency (always two places).
- Compare with Decimal's own predicates: `.lt`, `.gt`, `.gte`, `.isPositive()`,
  `.isZero()`, `.isNegative()`. Never `Number(a) < Number(b)`.
- Pass decimal literals as strings: `metrics.debtToEquity?.lt('0.2')`, not
  `.lt(0.2)`. The string never goes through a float.
- Precision and rounding are set once in `src/math/decimal.ts` (34 significant
  digits, `ROUND_HALF_EVEN`). Do not call `Decimal.set` anywhere else.
- Share counts round **down** — `.floor()` or
  `.toDecimalPlaces(n, Decimal.ROUND_DOWN)` — so a plan can never exceed the
  cash balance. The leftover is reported as `residualCash`, never spread around.

The reason is not pennies. These figures are compared against hard thresholds
(P/TBV < 1.0, price < ⅔ NCAV, debt/equity < 0.2), and binary floating point puts
a name on the wrong side of a threshold often enough to matter when the whole
method is "buy below the line".

## Collections — the lodash-es rule

Use `lodash-es` for collection work: `sortBy`, `groupBy`, `keyBy`, `sumBy`,
`maxBy`. It is a declared dependency, tree-shakes under tsdown, and is used
consistently across `analysis/`, `portfolio/` and `setup/`.

```typescript
/* Bad */
const ordered = [...flags].sort((a, b) => a.date.localeCompare(b.date));
const total = lines.reduce((sum, line) => sum + line.cost, 0);

/* Good */
const ordered = sortBy(flags, flag => flag.date);
const total = sumBy(lines, line => line.cost);
```

`sortBy` takes an array of key functions for a multi-key sort and is stable,
which is what deterministic tool output depends on. Native methods are still
correct for `map`/`filter`/`some`/`find` and for `toSorted` on a plain
comparator where no key function helps — the rule is about `sortBy`, `groupBy`,
`keyBy`, `sumBy` and `maxBy` specifically, not about banning array methods.

## Types & validation

- **zod v4 (`import * as z from 'zod/v4'`) is the source of truth** for anything
  crossing the MCP boundary. Derive types with `z.infer`; do not hand-write a
  parallel interface.
- Upstream API responses get a hand-written `interface` describing the _raw_
  shape with everything optional (`SubmissionsResponse`, `TiingoPriceRow`,
  `PolygonPrevClose`). Upstreams lie, and the optionality is the documentation.
  Narrow into the internal shape immediately; do not let a raw response type
  escape its `data/` module.
- Exported data shapes are `readonly` throughout — `readonly Flag[]`,
  `Readonly<Record<string, string>>`. Nothing downstream should be mutating a
  report.
- **`undefined` means "could not be computed"; `false` means "failed the test".**
  Never collapse them. No `?? false`, no `!!`, no truthiness check where a
  three-state value is in play. Compare explicitly: `check.pass === true`.
- Prefer discriminated unions over optional-field grab-bags. `Severity` and
  `Quote['source']` are string-literal unions for exactly this reason.
- Lean on inference. Annotate a return type only at an exported boundary where
  the contract matters, or where TS can't infer it.

## Functions

- Small and single-purpose. If a function needs a section comment, it wants to
  be two functions.
- Pure by default. `computeMetrics`, `judge`, `scanDisqualifiers`, `allocate`
  and `planRebalance` take plain structures and touch nothing — that is what
  makes them testable, and it is the property to preserve.
- Isolate I/O at the edges: network in `http/` and `data/`, disk in `cache/` and
  `config/`.
- **Inject the clock.** Anything that reasons about dates takes `now` as an
  option (`scanDisqualifiers`, `insiderFilingActivity`). Never read
  `new Date()` inside logic you want to test.
- More than two arguments becomes a single options object. Optional behaviour
  goes in a defaulted destructured options parameter, as in
  `{ lookbackDays = 730, now = new Date() } = {}`.
- Async/await over promise chains. Never leave a promise unawaited without an
  explicit `void` and a reason.
- **Sequential `await` in a loop is correct here.** Every upstream is rate
  limited and the throttle in `http/client.ts` serialises per host;
  `eslint/no-await-in-loop` is off on purpose. Do not "optimise" a fetch loop
  into `Promise.all`.

## Dates and provenance

- Every figure that leaves this server carries the date it is as of. `Quote.asOf`
  is non-optional; `DatedValue` carries `asOf`, `filed`, `form` and `accn`.
- Dates are ISO `YYYY-MM-DD` strings, sliced from whatever the upstream gave
  (`row.date.slice(0, 10)`). They compare correctly as strings — do not
  round-trip through `Date` to compare them.
- When a derived figure has several inputs, report the **oldest** date. A metric
  is only as current as its stalest input.
- Sort filings by `filed`, not `end`, when you want "currently true": a restated
  prior period is filed after a later one, and the restatement is the number
  that holds.

## Errors

- Throw `Error` with an actionable message. Never throw strings.
- Error messages are aimed at the calling model, and should name the fix:
  which credential is missing, which env var sets it, where to register.
- Report every failure in a fallback chain, not just the last. `quote()`
  collects one line per provider — a single "no price" message hides which of
  "bad ticker", "no key" and "rate limited" actually happened.
- Distinguish "absent" from "broken". A 404 from `companyconcept` means the
  filer never tagged that concept, which is a valid reading, so it returns `[]`.
  A 500 throws.
- Swallow an error only where absence is a legitimate state, and say why in a
  comment — a missing credential file on first run, a corrupt cache row that is
  indistinguishable from a miss.
- Never log or throw a credential. URLs that may carry a key go through
  `redactUrl` first.

## Output and logging

- **No `console` in `src/`** (`eslint/no-console` is an error). This is a stdio
  MCP server: stdout is the protocol channel and a stray write corrupts the
  frame stream. Diagnostics belong in the tool result, where the calling model
  can act on them, or on stderr.
- Tool output is markdown aimed at a model that will summarise it. Lead with the
  verdict, then the evidence, then the caveats — `DisqualifierReport.summary`
  is the model to copy.
- Format through the shared helpers: `cell` for a possibly-absent value (renders
  `—`), `pct` for fractions, `usd` for currency. An absent figure renders as
  `—`, never as `0`.
- Append `DISCLAIMER` to any output that produces or implies a portfolio
  decision.
- Never echo a stored credential back, not even partially.

## Comments

- Comment _why_, not _what_. Assume the reader knows the language.
- Module-level doc comments are the exception to "keep comments short": each
  module opens with a block explaining what it is for and which failure it
  exists to prevent. That is the house style here — the domain reasoning is the
  part that cannot be recovered from the code.
- Inside a function, comments are rare and short. Use them for a non-obvious
  invariant (why 25-NSE is deduplicated, why the oldest date is reported, why
  Polygon takes a header instead of a query key), not narration.
- A deliberately-disabled rule or an intentionally-empty catch always carries a
  comment saying why.

## Security posture

- Credentials never enter the repository. Environment first, then a 0600 file
  under the user's config dir. `.gitignore` covers `.env`, `.env.local` and
  `*.key`.
- Prefer an `Authorization` header to a query-string key. Where an upstream
  gives no choice, redaction in `http/client.ts` is the backstop.
- Treat every upstream payload as untrusted: parse defensively, tolerate missing
  fields, and never `as` a raw response into an internal type without narrowing.
- Adding a dependency has to clear the supply-chain gate: pnpm blocks install
  scripts except the allowlist in `pnpm-workspace.yaml`, and
  `pnpm audit --audit-level moderate` runs in the pre-commit hook whenever the
  lockfile is staged. Prefer a Node 24 builtin (`node:sqlite`,
  `process.loadEnvFile`) over a package.
