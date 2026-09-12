# CLAUDE.md

Guidance for AI agents working in this repository. Keep it current when
build/test workflows or conventions change.

## What this is

`cigar-butt` is a published npm package: an MCP (Model Context Protocol) stdio
server that screens stocks against Benjamin Graham and Walter Schloss deep-value
criteria. It computes tangible book value, NCAV (net current asset value), NNWC
and net cash directly from SEC EDGAR XBRL filings, runs filing-index
disqualifier checks before any valuation work, and turns the survivors into
equal-weight whole-share allocations and rebalance orders.

The distinguishing claim is _provenance_. Every figure comes from a primary
filing or a dated quote fetched this session, and carries the accession number
and period end it came from. A screener's derived numbers are a cross-check,
never the input.

`STYLEGUIDE.md` governs all TypeScript here and is authoritative — read it
before writing code.

## Layout

Single package. **Not** a monorepo: `pnpm-workspace.yaml` exists only because
pnpm 11+ reads its supply-chain settings from there rather than `.npmrc`.

- `src/index.ts` — the stdio entry point (`serveStdio(createServer)`, shebanged).
  It is what `tsdown.config.ts`, `knip.json` and the `bin`/`exports` fields in
  `package.json` all point at. Keep it this thin.
- `src/server.ts` — `createServer()`: loads the env file, constructs the
  `McpServer`, registers every tool module, and carries `INSTRUCTIONS`, the
  order-of-operations text the client shows the model. That text is the domain
  discipline in its user-facing form; it and the hard rules below must stay in
  agreement.
- `src/math/decimal.ts` — the decimal.js configuration and the only helpers
  (`dec`, `div`, `sum`, `out`, `money`) that convert between `number` and
  `Decimal`. Read this file before writing any arithmetic.
- `src/http/client.ts` — one `fetchJson` for every upstream, so per-host rate
  limiting, retry/backoff and URL redaction live in one place. `redactUrl`
  scrubs `apikey`/`api_key`/`apiKey`/`token` query parameters out of anything
  that might be logged or thrown.
- `src/cache/store.ts` — the `node:sqlite` response cache and the `TTL` table.
- `src/config/providers.ts` — the provider registry (`PROVIDERS`). One entry per
  credential the server can read.
- `src/config/store.ts` — credential resolution (environment first, then the
  0600 JSON file) and the `SetupReport` shape.
- `src/data/sec.ts` — EDGAR: `resolveTicker`, `companyConcept`, `latestFact`,
  `submissions`, `frame`, plus the `CONCEPTS` map of us-gaap tags the asset
  tests read.
- `src/data/prices.ts` — quotes, falling through Tiingo → Polygon → Alpha
  Vantage. Every `Quote` carries `asOf`.
- `src/analysis/metrics.ts` — `fetchBalanceSheet`, `computeMetrics`, `judge`,
  `isFinancial`. The asset tests.
- `src/analysis/disqualifiers.ts` — `scanDisqualifiers` and
  `insiderFilingActivity`, both reading the filing index only.
- `src/analysis/screen.ts` — the market-wide screen, built from SEC `frames`:
  one concept for every filer in a period, joined on CIK. It deliberately
  attaches **no price** — frames give the balance sheet, and pairing a stale
  quote with a filing figure is the mistake this codebase exists to avoid. Its
  output is a candidate list for `analyze_ticker`, not a verdict.
- `src/portfolio/allocate.ts` — equal-weight whole-share sizing against a cash
  balance.
- `src/portfolio/rebalance.ts` — target weights vs. current holdings → buys,
  sells and exits.
- `src/data/finra.ts` — FINRA consolidated short interest. No credential. The
  only POST caller in the codebase: per-symbol filtering is POST-only, and
  `compareFilters` sent as a GET query parameter is _silently ignored_, which
  returns the whole market and looks like success.
- `src/data/fdic.ts` — FDIC BankFind call reports. No credential. Tangible
  common equity, noncurrent loans and allowance coverage: the asset tests that
  actually work on a bank, where EV and net cash do not.
- `src/data/fred.ts` — Moody's Aaa, the 10-year, and CPI. Feeds Graham's
  earnings-yield hurdle.
- `src/data/reference.ts` — Polygon listing status, splits and dividends.
  Catches a split between the balance-sheet date and today, which silently makes
  every per-share figure wrong by the split factor.
- `src/broker/` — the broker-neutral layer. `contract.ts` is the only shape the
  tools know: `Position`, `Balances`, `BrokerAccount`, `Transaction`,
  `BrokerAdapter`. Capabilities are optional methods — `authorize` exists on
  E*TRADE, which needs an OAuth grant, and is absent on Alpaca, whose static
  key pair *is* the session; `isConnected()` is deliberately distinct from
  `isConfigured()`, because an E*TRADE consumer key outlives the token that
  died at midnight. `registry.ts` maps id → adapter, `aggregate.ts` reads
  every connected broker as one book, and `tax.ts` maps each vendor's account
  type onto `TaxTreatment`.
- `src/broker/aggregate.ts` — `openBook` decides scope, `readBook` fetches and
  combines. Three invariants live here: a combined price is the newest leg's
  mark carrying _that leg's_ date; a live book never absorbs a paper one; and
  one broker failing never removes another's positions from the total, it only
  adds a note saying the total is short.
- `src/data/etrade.ts` — E*TRADE OAuth 1.0a (hand-signed on `node:crypto`, no
  dependency), accounts, balances, positions and transactions. Read-only; this
  server never places an order. **Every credential is stored per environment**
  (`ETRADE_SANDBOX_*` / `ETRADE_PROD_*`), tokens included — the two sides are
  not interchangeable, and sharing one slot means a toggle silently signs
  production requests with sandbox material.
- `src/data/congress.ts` — Senate eFD periodic and annual disclosures (HTML
  tables, session-cookie flow), the House Clerk's filing index (XML), and
  committee rosters from `unitedstates/congress-legislators`. No credential.
  Sits outside the Graham/Schloss method: amounts are bands reported weeks
  late, so nothing here feeds the screen.
- `src/setup/report.ts` — renders the credential picture as text, generated from
  the provider registry so it cannot drift from what the code reads. Includes
  `startupBanner`, written to **stderr** at boot — stdout is the protocol, and
  stderr is where a client's install output surfaces.
- `src/tools/*.ts` — MCP tool registration, one `register*Tools(server)` per
  module: `setup.ts` (`setup_status`, `setup_credentials`), `research.ts`
  (`check_disqualifiers`, `analyze_ticker`, `get_quotes`), `market.ts`
  (`macro_context`, `bank_call_report`, `check_corporate_actions`,
  `short_interest`), `portfolio.ts` (`build_allocation`, `plan_rebalance`,
  `screen_market`), `broker.ts` (`broker_connect`, `broker_environment`,
  `broker_accounts`, `broker_balances`, `broker_positions`,
  `broker_transactions`, `broker_disconnect`), `congress.ts`
  (`congress_trades`, `congress_member_profile`, `congress_house_filings`),
  `cache.ts` (`cache_status`, `cache_clear`), `technical.ts`
  (`price_history_stats`), `uk.ts`, `japan.ts`, `watch.ts`. `shared.ts` holds
  `text`, `failure`, `requireCapabilities`, `attempt`, the cell formatters,
  `DISCLAIMER`, `TAX_NOTE` and `COST_NOTE`.

Data flows one way: `config` → `http` → `data` → `analysis` → `portfolio` →
`tools`. `import/no-cycle` is an error in `.oxlintrc.json`; keep it that way.

## Commands

This is a **pnpm** repo (see `packageManager` in `package.json`) — always use
`pnpm`, never `npm`/`yarn`. Where you'd reach for `npx`, use `pnpm exec <bin>`
for a workspace binary and `pnpm dlx <pkg>` for a one-off, so what runs matches
what the lockfile actually installed.

- `pnpm build` — tsdown. Single ESM bundle plus declarations into `dist/`.
- `pnpm dev` — `tsx watch src/index.ts`.
- `pnpm start` — run the built server (`node dist/index.js`).
- `pnpm typecheck` — `tsc --noEmit`. The real type check; nothing else does one.
- `pnpm lint` / `pnpm lint:fix` — oxlint.
- `pnpm format` / `pnpm format:check` — oxfmt write / verify.
- `pnpm knip` — unused files, exports and dependencies.
- `pnpm test` / `pnpm test:watch` — vitest.
- `pnpm check` — lint, format:check, typecheck, knip, test, in that order. Run
  this before you call a change done.

Husky runs `lint-staged` (oxlint --fix then oxfmt) on commit, commitlint on the
message (Conventional Commits), and `pnpm audit --audit-level moderate` when
`pnpm-lock.yaml` is staged.

## Tooling, and why it differs from the reference setup

These conventions came from a sibling repo that uses ESLint + Prettier. This one
does not, deliberately:

- **oxlint, not ESLint.** `.oxlintrc.json`. Rust-based, no type-aware pass, and
  fast enough that there is no excuse for not running it. Categories:
  `correctness`, `perf` and `suspicious` are errors; `pedantic`, `restriction`
  and `style` are off.
- **oxfmt, not Prettier.** `.oxfmtrc.json`. Same settings you'd recognise
  (single quotes, semicolons, 80 columns, 2-space, no trailing commas,
  `arrowParens: avoid`), plus oxfmt's own `sortImports` and `sortPackageJson`.
  Import ordering is oxfmt's job; member and key ordering is Perfectionist's.
  The two do not overlap.
- **`eslint-plugin-perfectionist` runs _inside_ oxlint**, via the `jsPlugins`
  field in `.oxlintrc.json`. That is how the member-ordering rules
  (`sort-objects`, `sort-interfaces`, `sort-union-types`, `sort-enums`,
  `sort-exports`, …) carried over. They are all `type: natural`, `order: asc`,
  `ignoreCase: false` — so object literals, interface members and union arms are
  alphabetical, which is why the source looks the way it does. `pnpm lint:fix`
  applies them. Knip is told to ignore the dependency (`ignoreDependencies` in
  `knip.json`) because nothing imports it directly.
- **knip** for dead code and unused deps; **vitest** for tests; **tsdown**
  (rolldown) for the build.
- `eslint/no-await-in-loop` is **off on purpose**. Every upstream is rate
  limited (SEC 10/s, Polygon 5/min, Tiingo ~50 tickers/hr), the retry loops must
  serialise, and `Promise.all` would trip the limits rather than speed anything
  up. Sequential `await` in a loop is the correct shape here — do not "fix" it.
- `eslint/no-console` is an **error** in `src/`. This is a **stdio** MCP server:
  stdout is the protocol channel, and a stray `console.log` corrupts the frame
  stream. Diagnostics go to stderr, or into the tool result where the calling
  model can act on them.

Node is pinned to 24.21.0 (`.nvmrc`, and `engines.node >=24.21.0`). TypeScript 7,
ESM only, `verbatimModuleSyntax` on. Relative imports carry the `.ts` extension
(`allowImportingTsExtensions` + `rewriteRelativeImportExtensions`) — match the
existing files, do not write extensionless imports.

## Hard rules

These are not style preferences. Each one is a class of wrong answer that this
project exists to avoid.

### 1. All arithmetic goes through decimal.js

`number` appears at the I/O boundary — JSON in from an upstream API, JSON out to
the MCP client — and **nowhere in between**. Everything between is `Decimal`.

Two reasons, and only the second is about pennies:

- The figures are compared against hard thresholds: P/TBV against 1.0, price
  against two-thirds of NCAV, debt/equity against 0.2. Binary floating point
  puts a name on the wrong side of a threshold often enough to matter when the
  entire method is "buy below the line".
- `allocate` sizes **whole shares** against a cash balance. A float's worth of
  rounding error is the difference between a plan that fits the balance and one
  that overdraws it.

Practically: parse with `dec()`, divide with `div()` (which yields `undefined`
rather than `Infinity`/`NaN`), and serialise only at the edge with `out()` or
`money()`. Never `Number(x)` a Decimal mid-pipeline, never `+`/`*` on values
that came off a balance sheet.

### 2. Collection work uses lodash-es

`sortBy`, `groupBy`, `keyBy`, `sumBy`, `maxBy` — not hand-rolled reduces and not
`Object.groupBy`. It is a declared dependency and it is used throughout
(`analysis/`, `portfolio/`, `setup/`). `sortBy` in particular gives a stable
sort with a plain key function, which is what the deterministic output ordering
depends on. Consistency here is worth more than saving an import.

### 3. A name goes in output only with a dated figure retrieved this session

Never a figure from model memory. If a price or a line item could not be
fetched, say so — do not fill the gap.

Every figure carries its "as of" date. Undated numbers are the single largest
source of wrong answers in this domain: the same ticker has come back 60% apart
from two caches minutes apart, and a number without its date is arbitrary.
`Quote.asOf` is non-optional. `DatedValue` carries `asOf`, `filed`, `form` and
`accn`. `ValueMetrics.asOf` reports the **oldest** line item used, not the
newest, because a metric is only as current as its stalest input.
`planRebalance` adds a note when any order carries `asOf: 'unknown'`.

### 4. `undefined` means "could not be computed", `false` means "failed the test"

`ScreenCheck.pass` is `boolean | undefined` and the distinction is load-bearing.
A filer that never tagged `Liabilities` gets no NCAV; that is a gap in the
evidence, not a failed test. Collapsing the two is how a screen ends up
confidently wrong. Never change code in a way that erases the distinction —
no `?? false`, no `!!pass`, no truthiness check that treats a missing line item
as a rejection. `judge` deliberately reads `check.pass === true`.

The same applies upstream: `computeMetrics` returns optional fields and reports
what it could not find in `missing`, and `dec()`/`div()` return `undefined`
rather than a sentinel number.

### 5. Disqualifier checks run BEFORE valuation work

`scanDisqualifiers` reads the filing index and costs one HTTP request. A full
balance sheet is twelve `companyconcept` calls plus a `submissions` fetch.
Running the disqualifiers last wastes the valuation effort on names that were
already dead.

What kills a name outright (`severity: 'disqualify'`): 8-K item 4.02
(non-reliance on previously issued financials), item 1.03 (bankruptcy), Form 25
and 25-NSE (issuer- and exchange-filed delisting), Form 15-12B
(deregistration). What demands reading the filing (`'investigate'`): 8-K 4.01
(auditor change), 3.01 (listing-rule failure), 2.06 (material impairment),
NT 10-K / NT 10-Q (late filing), and a periodic report older than 135 days. The
whole thesis is that the reported balance sheet is true, so anything undermining
the filings ends the analysis regardless of how cheap the name looks.

### 6. Enterprise value and net cash are meaningless for financials

SIC 6000–6799 (`isFinancial`). Deposits and the securities book are not spare
cash. `judge` returns `undefined` — not `false` — for the net-cash check on a
financial, and reports debt/equity without letting it veto, because leverage is
the business model. Go to tangible common equity instead.

### 7. Not investment advice

`DISCLAIMER` in `src/tools/shared.ts` is appended to every tool that produces or
implies a portfolio decision — once per response, not once per session, because
a client may surface a single tool result without the surrounding conversation.
Do not remove it, do not soften it, and do not write documentation that
undercuts it.

## Credentials

Never in the repo. Resolution order is environment first, then a JSON file under
the user's config dir (`XDG_CONFIG_HOME` or `~/.config`, overridable with
`CIGAR_BUTT_CONFIG`), written `0600` and `chmod`ed on every write because
`writeFileSync`'s mode only applies at creation. The environment wins so an
operator can override a stored key for one run.

`src/config/providers.ts` is the registry, and it is the _only_ place a provider
is described. The first-run flow, the `setup_status` tool and the setup report
are all generated from it. SEC is `required` (a User-Agent with a real contact
email — EDGAR has no API key and returns 403 without one). Tiingo, Polygon and
Alpha Vantage, Alpaca, EODHD, Finnhub, Twelve Data and FMP form the `one-of`
group `prices`. FRED, EDINET, Companies House and the E*TRADE key pairs are
`optional`.

Rules: never echo a credential back into tool output, not even partially — the
transcript may be logged or shared. Prefer an `Authorization` header over a
query parameter (Polygon takes a header for exactly this reason); where a
provider only supports a query key (Alpha Vantage, FRED), `redactUrl` in the
HTTP client keeps it out of errors.

## Caching

`node:sqlite`, built into Node 24, so the cache costs zero dependencies. WAL
journal, `synchronous = NORMAL`, one `entries` table keyed `namespace:key`.

TTLs are set per source in the `TTL` table, by how often the underlying fact can
actually change:

| Namespace      | TTL | Why                                                                    |
| -------------- | --- | ---------------------------------------------------------------------- |
| `fundamentals` | 24h | Balance-sheet concepts change when a filing lands                      |
| `submissions`  | 6h  | The filing index gains rows continuously; a new 8-K must not be missed |
| `prices`       | 1h  | **Deliberately short** — see below                                     |
| `frames`       | 7d  | A quarter's data is fixed once filed                                   |
| `tickerIndex`  | 7d  | ~1MB payload that changes at the margins                               |

The short price TTL is not a tuning oversight. Stale prices are the core failure
mode this project exists to prevent: the same ticker has come back 60% apart
from two caches minutes apart, and a cheerfully-cached quote is precisely the
wrong answer. Do not raise it to "save quota" — the fundamentals TTL is where
the quota savings actually are. Quotes are cached under
`quote:<provider>/<ticker>`, per provider, because two providers can
legitimately disagree and blending them under one key would hide it.

Caching is also not optional: the free tiers are the binding constraint (Alpha
Vantage ~25 requests/day, Polygon 5/minute, Tiingo ~50 tickers/hour), and MCP
servers restart whenever a client reconnects, so an in-memory cache throws away
the expensive work at every session boundary. `CIGAR_BUTT_NO_CACHE=1` bypasses
reads and writes; `CIGAR_BUTT_CACHE` overrides the path; `:memory:` is honoured
for tests via `openCacheForTest`.

## MCP surface

MCP SDK v2 (`@modelcontextprotocol/server` 2.x), zod v4 (imported as
`zod/v4`) for input schemas. Tools are registered with `server.registerTool`,
taking a schema object, `annotations` (`readOnlyHint`, `openWorldHint`,
`idempotentHint`, `destructiveHint`) and a handler returning a `CallToolResult`.

First-run auth uses the 2026-07-28 protocol's `input_required` result:
`inputRequired({ inputRequests: { credentials: inputRequired.elicit({...}) } })`
asks a capable client for a real form, and `acceptedContent(ctx.mcpReq.inputResponses,
'credentials', schema)` reads the answers back on the next round. A client
without elicitation gets the registration links as text and re-calls the tool
with the values as arguments. Both paths land in the same 0600 file.

### Adding a tool

1. Register it in a module under `src/tools/`, and wire that module's
   `register*Tools(server)` into `createServer()` in `src/server.ts`. If the
   tool changes the order of operations, update `INSTRUCTIONS` there too.
2. Guard it with `requireCapabilities('sec')` / `('prices')` — naming only what
   the tool actually uses. Returning the setup page instead of a bare error
   lets the calling model fix the problem in one turn, and a tool that never
   touches prices must never demand a price key.
3. Wrap the handler body in `attempt()` so an upstream failure becomes a
   readable tool error rather than a protocol-level crash.
4. Return `text()` / `failure()`. Format numbers with `cell`, `pct`, `usd`.
   Append `DISCLAIMER` if the output implies a portfolio decision.
5. Write an `annotations` block. `readOnlyHint: true` for anything that only
   reads; `openWorldHint: false` for anything that does not hit the network.

### Adding a provider

Edit `src/config/providers.ts` and nothing else. Add a `ProviderSpec` with
`envVar`, `id`, `label`, `purpose`, `requirement` (`required` / `one-of` +
`group` / `optional`), `signupUrl`, optionally `rateLimit` and a `validate`
function. The setup report, `setup_status` and the blocking-credential logic
pick it up automatically.

Two things do **not** follow automatically and must be edited too: the
`credentialForm` zod schema in `src/tools/setup.ts` (one optional string field
per credential, so the elicitation form has a field for it), and — for a price
provider — the fallback chain in `quote()` in `src/data/prices.ts`.

## Testing

vitest, node environment, specs co-located as `src/**/*.test.ts`
(`vitest.config.ts`; `knip.json` knows the same pattern). Coverage includes
`src/**/*.ts` and excludes `src/index.ts`.

`pnpm test` does **not** type-check — vitest transpiles. `pnpm typecheck` is the
only real type check; `pnpm check` runs both.

What to test, given the domain:

- **Pure functions first.** `computeMetrics`, `judge`, `scanDisqualifiers`,
  `allocate` and `planRebalance` are all pure and take their inputs as plain
  structures. That is deliberate — they are the parts where a bug is a wrong
  answer rather than a crash.
- **Test the `undefined` paths explicitly.** A balance sheet missing
  `Liabilities` must produce `pass: undefined`, not `false`. A financial must
  get `undefined` on the net-cash check. These are the assertions that stop rule
  4 from being quietly reverted.
- **Inject time.** `scanDisqualifiers` and `insiderFilingActivity` both take
  `now` as an option for exactly this reason. Never let a test depend on the
  wall clock.
- **Never hit the network.** Use the test seams: `openCacheForTest(':memory:')`,
  `resetCredentialCache()`, `resetTickerCache()`. Fixtures should be trimmed
  real EDGAR payloads — the parallel-array shape of `filings.recent` and the
  `units` keying in `companyconcept` are both easy to get wrong from memory.
- Tests may relax two lint rules (see `overrides` in `.oxlintrc.json`):
  `perfectionist/sort-objects` and `typescript/no-explicit-any`.

## Before you finish

Run `pnpm check`. If you changed provider behaviour, credential handling or a
TTL, update this file and `README.md` in the same change — a stale doc here is a
bug, not a follow-up. Commit messages are Conventional Commits (commitlint
enforces it; the body and footer line-length caps are disabled).
