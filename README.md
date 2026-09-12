# cigar-butt

An MCP server for Benjamin Graham and Walter Schloss deep-value stock screening.

It computes tangible book value, NCAV, NNWC and net cash **from SEC EDGAR XBRL
filings**, runs the filing-index disqualifier checks that catch restatements and
delistings before any valuation work, and turns verified candidates into
equal-weight whole-share allocations and rebalance orders.

The failure mode it exists to prevent is the obvious one: a language model
producing a plausible list of tickers with plausible-looking ratios attached,
assembled from training data rather than current filings. Valuations move. A
name that traded at 0.7× tangible book six months ago may trade at 2× today, and
a list built from memory will be confidently wrong in exactly the way that costs
money. So every figure this server reports carries the filing it came from and
the date it was filed, and a figure it cannot retrieve is reported as missing
rather than estimated.

> **Not investment advice.** This is a screening tool. It reports figures from
> public filings and market data; it does not know your circumstances, and a
> screen is not diligence.

---

## Contents

- [Install](#install)
- [Credentials](#credentials)
- [Tools](#tools)
- [The method](#the-method)
- [How it gets its data](#how-it-gets-its-data)
- [Caching](#caching)
- [Configuration reference](#configuration-reference)
- [Development](#development)
- [License](#license)

---

## Install

Requires **Node 24.21.0 or later** (see `.nvmrc`). The cache uses `node:sqlite`,
which is a release candidate in Node 24 and needs no flag.

### Claude Code

```bash
claude mcp add cigar-butt -- npx -y cigar-butt
```

### Claude Desktop, Cursor, and other clients

Add to your MCP config:

```json
{
  "mcpServers": {
    "cigar-butt": {
      "command": "npx",
      "args": ["-y", "cigar-butt"],
      "env": {
        "SEC_USER_AGENT": "Your Name your-email@example.com",
        "TIINGO_API_KEY": "..."
      }
    }
  }
}
```

The `env` block is optional — the server can prompt for credentials on first
use and store them itself. See below.

### From source

```bash
git clone https://github.com/mainfraame/cigar-butt.git
cd cigar-butt
pnpm install
pnpm build
node dist/index.js
```

---

## Credentials

**Credentials are optional and checked per tool.** Nothing is globally
blocked — a tool asks only for what it actually uses, so the rest of the server
keeps working while you fill things in.

- **No credential, ever:** congressional disclosures, FINRA short interest,
  FDIC call reports, and the allocation and rebalance maths.
- **`SEC_USER_AGENT`:** `analyze_ticker`, `check_disqualifiers`,
  `screen_market`. This is the core of the server and needs no registration —
  just a real name and email — so it is the one thing worth setting first.
- **A price key:** `get_quotes`, and the P/TBV and price-to-NCAV verdicts.
  Without one, `analyze_ticker` still reports the whole balance sheet and says
  the price is unavailable rather than refusing.

**To set them up, just ask.** Call `setup_credentials` with no arguments and the
server prompts for each value (on clients that support elicitation) or returns
the registration links for the model to relay. Values are written to a `0600`
JSON file under your config directory — never into a project.

| Credential                        | Needed       | What it gives                                                  | Register                                                                                            |
| --------------------------------- | ------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `SEC_USER_AGENT`                  | **Required** | Balance-sheet line items and the filing index                  | No key. A real name and email: [SEC webmaster FAQ](https://www.sec.gov/os/webmaster-faq#developers) |
| `TIINGO_API_KEY`                  | One of three | Split- and dividend-adjusted daily closes. Best free option    | [tiingo.com](https://www.tiingo.com/account/api/token)                                              |
| `POLYGON_API_KEY`                 | One of three | Whole-market bars, delisting reference data, corporate actions | [polygon.io](https://polygon.io/dashboard/api-keys)                                                 |
| `ALPHAVANTAGE_API_KEY`            | One of three | Fundamentals cross-check, last-resort quote                    | [alphavantage.co](https://www.alphavantage.co/support/#api-key)                                     |
| `FRED_API_KEY`                    | Optional     | Moody's Aaa (Graham's earnings-yield hurdle), CPI, the 10-year | [fredaccount.stlouisfed.org](https://fredaccount.stlouisfed.org/apikeys)                            |
| `ETRADE_CONSUMER_KEY` / `_SECRET` | Optional     | Read your real holdings and cash                               | [developer.etrade.com](https://developer.etrade.com/getting-started)                                |

Every tier listed is free. **FINRA short interest and FDIC BankFind need no
credential at all** and always work.

### Getting an E*TRADE API key

E*TRADE issues two independent key pairs and they are **not interchangeable** — a
sandbox token is rejected by production even if sent to the right host.

**Sandbox** (instant, self-service): log in at `us.etrade.com`, then open
[us.etrade.com/etx/ris/apikey](https://us.etrade.com/etx/ris/apikey). The key and
secret appear on the page immediately. Sandbox returns canned data that does not
match what you ask for — request GOOG, get AAPL — so use it to prove the
connection works, never to read real numbers.

**Production** — three forms on `us.etrade.com`, in order:

1. [API User Intent Survey](https://us.etrade.com/etx/ris/apisurvey/#/questionnaire)
2. [API Developer Agreement](https://us.etrade.com/etx/ris/apisurvey/#/agreement)
3. [Annual market-data Attestation](https://us.etrade.com/etx/ris/apisurvey/#/attestation) — this one recurs yearly

An **individual** key is displayed on screen the moment those are done: no email,
no PDF, no phone call, no review. A **vendor** key (multi-user or redistributed)
is issued Inactive, and E*TRADE emails you to schedule a demo with Product and
Legal first. You need an E*TRADE account, but it does **not** have to be funded —
funding is only required to trade. An individual key is locked to the user ID
that created it.

Store both pairs at once as `ETRADE_SANDBOX_CONSUMER_KEY` /
`ETRADE_PROD_CONSUMER_KEY` (with matching `_SECRET`), and switch with the
`etrade_environment` tool. Access tokens are stored per environment too, so
connecting one does not disconnect the other and a sandbox token can never be
sent to production.

Prefer the server's own 0600 credential file over exporting these in a shell rc:
an export is inherited by every process you launch, and an exported `ETRADE_ENV`
overrides the stored setting, which makes the toggle look broken.
`setup_status` reports which source each value came from.

Then run `etrade_connect`. It returns a URL, E*TRADE shows a short verifier code,
and you paste it back. No browser redirect is involved, so nothing needs to
listen on a port. The request token expires **5 minutes** after issue. Access
tokens idle out after 2 hours — the server renews automatically inside that
window — and die at midnight US Eastern, which nothing can renew past.

**SEC EDGAR has no API key.** It identifies callers by a descriptive
`User-Agent` containing a real name and email address. Sending one is
mandatory — without it EDGAR returns 403 and may block your IP.

Resolution order is environment variables first, then the stored file, so you
can override one key for a single run without editing anything. To point the
server at an existing dotenv file instead, set `CIGAR_BUTT_ENV_FILE`. See
[`.env.template`](.env.template) for a complete annotated file.

---

## Tools

### Setup

| Tool                | What it does                                                                                 |
| ------------------- | -------------------------------------------------------------------------------------------- |
| `setup_status`      | Which credentials are configured, where each came from, and sign-up URLs for what is missing |
| `setup_credentials` | Prompt for and store credentials                                                             |

### Research

| Tool                      | What it does                                                                                                                         |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `screen_market`           | Screens every SEC filer that reported in a quarter, via the XBRL `frames` endpoint. Five requests total regardless of universe size  |
| `check_disqualifiers`     | Scans one company's filing index for restatements, auditor changes, bankruptcy, delisting and late filings. One request              |
| `analyze_ticker`          | Full workup: disqualifiers, then the asset tests from filing line items, then a dated price, then the Schloss and Graham verdicts    |
| `get_quotes`              | Current prices for a list of tickers, each with its as-of date and provider                                                          |
| `short_interest`          | FINRA consolidated short interest — the market's own answer to "why is this cheap?". No credential needed                            |
| `check_corporate_actions` | Listing status, splits and dividends. Run this before pairing a filing's share count with a price                                    |
| `bank_call_report`        | FDIC call reports: tangible common equity, noncurrent loans, allowance coverage. The tests that work on a bank. No credential needed |
| `macro_context`           | Moody's Aaa, the 10-year, CPI, and the implied Graham P/E ceiling. Needs a FRED key                                                  |

### Brokerage

Read-only. This server never places an order.

| Tool                  | What it does                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `etrade_connect`      | OAuth handshake with E*TRADE. Returns a URL to open; you paste back the verifier code                                                            |
| `etrade_accounts`     | List accounts and their account ID keys                                                                                                          |
| `etrade_positions`    | Holdings and cash for one account, emitted in exactly the shape `plan_rebalance` takes                                                           |
| `etrade_environment`  | Show or switch between sandbox and production. Both key pairs and both access tokens are stored separately, so switching never mixes credentials |
| `etrade_balances`     | Cash available, settled vs unsettled, buying power, margin balance, open margin calls                                                            |
| `etrade_transactions` | Trade, dividend, transfer and fee history as a table                                                                                             |
| `etrade_disconnect`   | Revoke and delete the stored access token                                                                                                        |

### Congressional disclosures

Outside the Graham/Schloss method, and the output says so: disclosures are
banded amounts reported weeks late, so they can never be a figure the screen
acts on. What they are good for is context — and the committee cross-reference
is the part carrying real information. No credential needed.

| Tool                      | What it does                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `congress_trades`         | Search disclosed Senate transactions **by ticker** or member, with each member's committee seats                              |
| `congress_index`          | Show how much disclosure history is indexed locally, and backfill further                                                     |
| `congress_member_profile` | A senator's committees, board seats and outside positions, plus every employer paying the household — self, spouse or child   |
| `congress_house_filings`  | House transaction-report filings with PDF links. Filing records only: House disclosures are PDFs, many of them scanned images |

**Why there is a local index.** eFD cannot be searched by ticker — its form
takes a filer name, a state, a report type and a filing-date window, and
nothing else. So transactions are parsed into a local SQLite index and queried
there. It refreshes its recent window automatically when a day stale, and
reports are immutable once filed, so staying current costs only the new
filings. Depth is up to you: a 12-month window is ~180 reports, five years
~690, the whole archive back to 2012 ~2,400, fetched at roughly one per second.
`congress_index` reports coverage and resumes where it stopped.

**On sources.** There is no bulk download of Senate disclosures and no export
endpoint — the Senate Ethics Committee names
[efdsearch.senate.gov](https://efdsearch.senate.gov/search/) as _the_ public
database, and `/search/report/export/`, `/search/download/` and
`/search/report/csv/` all 404. Its search endpoint is therefore the structured
feed, and it reaches the full archive: 2,426 periodic transaction reports back
to 2012. Every third-party mirror re-scrapes that same endpoint and puts an API
key in front of it; the ones tested either require a key (Financial Modeling
Prep, Finnhub, DisclosedCapitol), bot-block (CapitolTrades), or have gone stale
(senate-stock-watcher's aggregate stops in 2019). So this reads the primary
source, parsed structurally with `node-html-parser` — each part of a report
lives in its own `section.card`, so an empty part reads as empty instead of
adopting the next one's table.

### Portfolio

| Tool               | What it does                                                                      |
| ------------------ | --------------------------------------------------------------------------------- |
| `build_allocation` | Turns verified candidates and a cash balance into whole-share position targets    |
| `plan_rebalance`   | Compares current holdings against targets and produces buys, sells and full exits |

### Cache

| Tool           | What it does                                     |
| -------------- | ------------------------------------------------ |
| `cache_status` | What the local response cache holds, by source   |
| `cache_clear`  | Drop cached responses so the next call refetches |

---

## The method

Schloss's rules, as filters:

| Criterion           | Filter                        | Note                                                                                                                    |
| ------------------- | ----------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Below tangible book | P/TBV < 1.0                   | Schloss wanted 0.6–0.8. Goodwill and intangibles are stripped from book value here; most screeners only offer plain P/B |
| No real debt        | Debt/Equity < 0.2             | Or long-term debt near zero                                                                                             |
| Solvency            | Current ratio > 2             | Graham's own threshold                                                                                                  |
| Diversify           | 15–20 positions, equal weight | Schloss ran 60 to 100                                                                                                   |

Graham's stricter net-net variant:

- **NCAV** = current assets − total liabilities − preferred stock. Buy below
  two-thirds of NCAV.
- **NNWC** = cash + 75% of receivables + 50% of inventory − total liabilities.

Six things the server does that a screener will not:

**1. Disqualifiers run before valuation, not after.** The whole thesis is that
the reported balance sheet is true, so anything undermining the filings kills
the name outright regardless of how cheap it looks. `check_disqualifiers` reads
the `submissions` filing index — one request — and reports 8-K item 4.02
(non-reliance on prior financials), 4.01 (auditor change), 1.03 (bankruptcy),
3.01 (listing deficiency), 2.06 (impairment), Form 25 and 25-NSE (delisting),
`NT 10-Q`/`NT 10-K` (late filing), and gaps where a periodic report should be.

A small-cap in the source research screened well on net cash and no debt while
having retracted a quarterly earnings release, drawn a law-firm investigation,
and received an NYSE delinquency notice inside a two-month window. No valuation
ratio catches that. An 8-K item scan catches it in one fetch.

**2. "Could not compute" is not "failed".** A check reads `n/a` when a line item
is missing, which is deliberately distinct from `false`. Collapsing the two is
how a screen ends up confidently wrong.

**3. Every line item comes from the same reporting period.** Filers change which
concepts they tag. Astec stopped tagging `AccountsReceivableNetCurrent` in 2019
while still filing quarterly, so taking "the latest fact for each concept
independently" silently builds NNWC from a seven-year-old receivable. Items that
do not reach the sheet's own period end are reported as stale and excluded from
the arithmetic.

**4. Enterprise value is not a net-cash proxy for financials.** For a bank it is
meaningless: Citigroup has shown an enterprise value of −$18.46 billion and a
"net cash position" of $231 billion, which is deposits and the securities book,
not spare cash. For SIC 6000–6799 the server marks the net-cash check `n/a` and
says why.

**5. The debt rule and the book rule fight each other.** Most persistent
sub-tangible-book names are banks and insurers, whose balance sheets are debt by
construction. Apply "no real debt" literally and the universe collapses to
industrials, metals, shippers and foreign micro caps. Schloss owned financials
anyway. The server surfaces the conflict rather than resolving it silently.

**6. Net-nets are rare.** A recent screen of 9,000 companies surfaced 14. If you
want 20 strict names, the universe may not contain 20 — and loosening the
filters until it does means you are no longer running this strategy.

### What it will not do

It will not backtest. Backtests assembled from a list picked with present-day
knowledge are survivorship-biased by construction: you chose those names partly
because they still exist, so any return figure flatters the strategy. Free price
sources are neither survivorship-bias-free nor point-in-time correct, which is
exactly what a research database like CRSP buys you. For a real backtest, use
point-in-time data with delistings included.

Schloss's own record — roughly 15.3% annually over 45 years against about 10%
for the index — is the honest evidence for the method.

---

## How it gets its data

**SEC EDGAR is authoritative and everything else is a cross-check.** EDGAR is the
filing itself: exact line items, each carrying its accession number, form type,
period end and filing date. A vendor's normalisation of a filing loses to the
filing every time, and their derived "net cash" figures have been wrong in
testing.

| Endpoint                  | Used for                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `api/xbrl/companyconcept` | One concept, full history, small payload. The workhorse for balance-sheet work                                                   |
| `api/xbrl/frames`         | One concept across every filer in a period. This is the market-wide screen                                                       |
| `submissions`             | The filing index, including the 8-K `items` array that makes the disqualifier checks a structured lookup rather than a news read |

Prices come from Tiingo, then Polygon, then Alpha Vantage, in that order.
Every failure is reported when all three fail, so "no key", "bad ticker" and
"rate limited" stay distinguishable.

**Every price carries its date.** In testing, two fetches of one ticker minutes
apart returned $18.42 dated Sep 4 and $15.50 dated Jul 10 — a 19% spread on the
same security. A single search for one small-cap returned prices from $29.85 to
$47.86 across pages cached at different dates. Picking any one figure without
its date is arbitrary.

---

## Caching

Responses are cached in SQLite (`node:sqlite` — built into Node 24, no
dependency) under your cache directory. The free tiers this server runs on are
tight enough to be the binding constraint: Alpha Vantage allows ~25 requests a
day, Polygon 5 a minute, Tiingo ~50 tickers an hour. A full per-name balance
sheet is twelve `companyconcept` calls plus a `submissions` fetch, so a 200-name
screen is roughly 2,600 requests. MCP servers also restart whenever a client
reconnects, so an in-memory cache throws the expensive work away at every
session boundary.

TTLs are set by how fast the underlying fact can actually change:

| Source                     | TTL      | Why                                                                                |
| -------------------------- | -------- | ---------------------------------------------------------------------------------- |
| Quotes                     | 1 hour   | Short on purpose. A stale price is the single largest source of wrong answers here |
| SEC balance-sheet concepts | 24 hours | These change only when a filing lands                                              |
| SEC filing index           | 6 hours  | Gains rows continuously; a new 8-K must not be missed                              |
| SEC frames                 | 7 days   | A quarter's data is fixed once filed                                               |
| Ticker index               | 7 days   | A ~1MB payload that changes at the margins                                         |

`cache_status` shows what is held; `cache_clear` drops it. Set
`CIGAR_BUTT_NO_CACHE=1` to bypass it entirely.

---

## Configuration reference

| Variable              | Default                                        | Purpose                                |
| --------------------- | ---------------------------------------------- | -------------------------------------- |
| `CIGAR_BUTT_ENV_FILE` | unset                                          | Load credentials from this dotenv file |
| `CIGAR_BUTT_CONFIG`   | `$XDG_CONFIG_HOME/cigar-butt/credentials.json` | Where credentials are stored           |
| `CIGAR_BUTT_CACHE`    | `$XDG_CACHE_HOME/cigar-butt/cache.sqlite`      | Cache database location                |
| `CIGAR_BUTT_NO_CACHE` | unset                                          | Set to `1` to bypass the cache         |

---

## Development

```bash
pnpm install
pnpm check        # lint, format, typecheck, knip, test
pnpm test         # vitest
pnpm build        # tsdown → dist/index.js
pnpm dev          # tsx watch
```

| Concern            | Tool                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| Package manager    | pnpm                                                                                              |
| Bundler            | [tsdown](https://tsdown.dev) (rolldown)                                                           |
| Lint               | [oxlint](https://oxc.rs), with `eslint-plugin-perfectionist` loaded through its `jsPlugins` field |
| Format             | [oxfmt](https://oxc.rs), including its built-in import sorting                                    |
| Dead code and deps | [knip](https://knip.dev)                                                                          |
| Tests              | [vitest](https://vitest.dev)                                                                      |

Two rules that are not obvious from the code:

**All arithmetic goes through decimal.js.** `number` appears at the I/O boundary
— JSON in from an API, JSON out to the MCP client — and nowhere in between.
Partly for pennies, mostly because these figures are compared against hard
thresholds: binary floating point puts a name on the wrong side of "P/TBV below
1.0" often enough to matter when the whole method is _buy below the line_. Note
that `Decimal.isPositive()` is **not** `> 0` — decimal.js reads zero's sign as
positive — so use the `gtZero` helper.

**Nothing may write to stdout.** That stream is the MCP protocol. A stray
`console.log` corrupts it and the client drops the connection, which is why
`eslint/no-console` is an error.

See [`CLAUDE.md`](CLAUDE.md) for the full architecture and
[`STYLEGUIDE.md`](STYLEGUIDE.md) for the TypeScript conventions.

---

## License

Apache-2.0. See [LICENSE](LICENSE).
