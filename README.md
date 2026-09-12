# cigar-butt

An MCP server that screens stocks against Benjamin Graham and Walter Schloss
deep-value criteria, computing every figure from primary filings rather than
from a commercial screener or from a language model's memory.

It reads SEC EDGAR XBRL to build tangible book value, NCAV, NNWC and net cash;
scans the filing index for restatements, bankruptcies and delistings _before_
doing any valuation work; and turns whatever survives into equal-weight
whole-share allocations and rebalance orders.

The distinguishing claim is **provenance**. Every figure carries the filing it
came from, the accession number and the date it was filed. A figure that could
not be retrieved is reported as missing, never estimated. The failure mode this
exists to prevent is the obvious one: a plausible list of tickers with
plausible-looking ratios attached, assembled from training data rather than
from current filings. Valuations move — a name that traded at 0.7× tangible
book six months ago may trade at 2× today — and a list built from memory is
confidently wrong in exactly the way that costs money.

> **This is not investment advice, and no advisory relationship is created by
> using it.** The software is provided as is, without warranty, and the author
> accepts no liability for any loss arising from its use. Data comes from
> third-party sources and may be inaccurate, delayed or incomplete. Past
> performance does not indicate future results. You are solely responsible for
> your own investment decisions; consult a licensed professional.
> **[Read the full disclaimer →](DISCLAIMER.md)**

## Contents

- [Why "cigar-butt"](#why-cigar-butt)
- [The method, honestly](#the-method-honestly)
- [Getting started](#getting-started)
- [Credentials](#credentials)
- [What you can do with it](#what-you-can-do-with-it)
- [How it gets its data](#how-it-gets-its-data)
- [Price providers and free-tier caps](#price-providers-and-free-tier-caps)
- [Caching](#caching)
- [Scheduled monitoring](#scheduled-monitoring)
- [What it will not do](#what-it-will-not-do)
- [Configuration reference](#configuration-reference)
- [Development](#development)
- [Disclaimer and licence](#disclaimer-and-licence)

## Why "cigar-butt"

The name is Warren Buffett's, for the style of investing he learned from
Benjamin Graham. From the 1989 Berkshire Hathaway
[shareholder letter](https://www.berkshirehathaway.com/letters/1989.html):

> If you buy a stock at a sufficiently low price, there will usually be some
> hiccup in the fortunes of the business that gives you a chance to unload at a
> decent profit, even though the long-term performance of the business may be
> terrible. I call this the "cigar butt" approach to investing. A cigar butt
> found on the street that has only one puff left in it may not offer much of a
> smoke, but the "bargain purchase" will make that puff all profit.

That is the strategy this server implements: buy the discarded business nobody
wants, below what its assets alone are worth, for the one puff left in it.

Buffett wrote that passage to explain why he had moved away from it. In the
same letter, under the heading _Mistakes of the First Twenty-Five Years_, he
calls the approach foolish "unless you are a liquidator", notes that "the
original 'bargain' price probably will not turn out to be such a steal after
all", and concludes:

> Time is the friend of the wonderful business, the enemy of the mediocre.

Both halves are true and the second one is the important one here. The
objections are real: at Berkshire's size the strategy stopped scaling, cheap
businesses are usually cheap for a reason, and a mediocre business gets worse
while you wait. Schloss ran it successfully for decades on a small book and
extreme diversification — his record is commonly cited as roughly 15% a year
over 45 years against about 10% for the index — which is the honest evidence
for the method, and it is evidence about one manager, not a promise about
yours.

A tool whose entire discipline is refusing to overstate a number should not
open by overstating its strategy.

## The method, honestly

The whole thesis is that **the reported balance sheet is true**. Everything
follows from that, including the order the tools run in.

Schloss's rules, as filters:

| Criterion           | Filter                        | Note                                                                                              |
| ------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------- |
| Below tangible book | P/TBV < 1.0                   | Schloss wanted 0.6–0.8. Goodwill and intangibles are stripped out; most screeners offer plain P/B |
| No real debt        | Debt/Equity < 0.2             | Or long-term debt near zero                                                                       |
| Solvency            | Current ratio > 2             | Graham's own threshold                                                                            |
| Diversify           | 15–20 positions, equal weight | Schloss ran 60 to 100. The method distrusts per-name conviction by design                         |

Graham's stricter net-net variant:

- **NCAV** = current assets − total liabilities − preferred stock. Buy below
  two-thirds of NCAV.
- **NNWC** = cash + 75% of receivables + 50% of inventory − total liabilities.

Six things this does that a stock screener will not.

**1. Disqualifiers run before valuation, not after.** If anything undermines
the filings, the name is dead regardless of how cheap it looks, and no ratio
catches that. `check_disqualifiers` reads the `submissions` filing index in one
request and reports 8-K item 4.02 (non-reliance on previously issued
financials), 4.01 (auditor change), 1.03 (bankruptcy), 3.01 (listing
deficiency), 2.06 (material impairment), Form 25 and 25-NSE (delisting),
NT 10-K/NT 10-Q (late filing), and gaps where a periodic report should be. A
full balance sheet is twelve requests; the scan is one, so it goes first.

**2. "Could not compute" is not "failed".** A check reads `n/a` when a line
item is missing, and that is deliberately distinct from `false`. A filer that
never tagged `Liabilities` gets no NCAV — a gap in the evidence, not a failed
test. Collapsing the two is how a screen ends up confidently wrong.

**3. Every line item comes from the same reporting period.** Filers change
which concepts they tag, so taking "the latest fact for each concept
independently" can silently build NNWC from a years-old receivable. Items that
do not reach the balance sheet's own period end are reported as stale and
excluded from the arithmetic.

**4. Enterprise value and net cash are meaningless for financials.** For
SIC 6000–6799 the deposits and the securities book are not spare cash, so the
net-cash check returns `n/a` and says why, and debt/equity is reported without
being allowed to veto — leverage is the business model. Use `bank_call_report`
on those names instead: tangible common equity, noncurrent loans and the
allowance held against them are the tests that do work on a bank.

**5. The debt rule and the book rule fight each other.** Most persistent
sub-tangible-book names are banks and insurers, whose balance sheets are debt
by construction. Apply "no real debt" literally and the universe collapses to
industrials, metals, shippers and foreign micro caps. Schloss owned financials
anyway. The server surfaces the conflict rather than resolving it silently.

**6. Net-nets are rare.** A screen of the whole US market routinely returns a
handful. If you want twenty strict names, the universe may not contain twenty —
and loosening the filters until it does means you are no longer running this
strategy. An empty US screen is a real finding; say so, or look at Japan, where
they have been considerably less scarce.

## Getting started

Requires **Node 24.21.0 or later** (see `.nvmrc`). The cache uses `node:sqlite`,
which needs no flag on Node 24.

### Claude Code

```bash
claude mcp add cigar-butt -- npx -y cigar-butt
```

### Claude Desktop, Cursor and other MCP clients

```json
{
  "mcpServers": {
    "cigar-butt": {
      "command": "npx",
      "args": ["-y", "cigar-butt"],
      "env": {
        "SEC_USER_AGENT": "Your Name your-email@example.com"
      }
    }
  }
}
```

The `env` block is optional. With no credentials at all, a large part of the
server still works, and the tools that need one say exactly which one and how
to get it.

Once connected, ask the model to run `setup_status`, or open the
**Set up cigar-butt** prompt the server registers, which lists every credential
and how to obtain it.

### From source

```bash
git clone https://github.com/mainfraame/cigar-butt.git
cd cigar-butt
pnpm install
pnpm build
node dist/index.js
```

## Credentials

**Credentials are optional and checked per tool.** Nothing is globally blocked:
a tool asks only for what it actually uses, so the rest of the server keeps
working while you fill things in.

| Tier                       | What you get                                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No credential at all**   | Congressional disclosures, FINRA short interest, FDIC call reports, UK Companies House status, ECB exchange rates, and all the allocation and rebalance arithmetic                 |
| **`SEC_USER_AGENT`**       | `check_disqualifiers`, `analyze_ticker`, `screen_market` — the core. There is no API key: EDGAR wants a real name and email in the User-Agent, and returns 403 without one         |
| **Any one price provider** | `get_quotes`, and the P/TBV and price-to-NCAV verdicts. Without one, `analyze_ticker` still reports the whole balance sheet and says the price is unavailable rather than refusing |
| **Optional extras**        | FRED for the macro context, E\*TRADE for reading your real book, Companies House and EDINET for the UK and Japan                                                                   |

Every tier listed is free.

To set them up, call `setup_credentials`. On a client that supports
elicitation the server prompts for each value directly; otherwise it returns
the registration links for the model to relay, and you pass the values back.
They are written to a `0600` JSON file under your config directory, never into
a project. Environment variables win over the stored file, so you can override
one value for a single run.

> **[Full credentials reference →](docs/credentials.md)** — every integration,
> sign-up links, step-by-step instructions (including how to obtain E\*TRADE
> sandbox and production keys), the `credentials.json` shape and every
> environment variable. Generated from the provider registry, so it cannot
> drift from what the server actually reads.

Two things worth knowing before you get there:

- **SEC EDGAR has no API key.** A fake User-Agent is worse than none: EDGAR may
  block your IP.
- **E\*TRADE issues two independent key pairs**, sandbox and production, and
  they are not interchangeable. Both pairs and both access tokens are stored
  separately, so switching with `broker_environment` can never sign a
  production request with sandbox material. Sandbox returns canned data that
  does not match what you asked for — request GOOG, get AAPL — so use it to
  prove the connection works, never to read real numbers.

## What you can do with it

Thirty-eight tools, grouped by what you are trying to do. The order below is
roughly the order they are meant to run in; the server ships the same order of
operations to the model as its instructions.

### Set the server up

| Tool                | What it does                                                                                |
| ------------------- | ------------------------------------------------------------------------------------------- |
| `setup_status`      | Which credentials are configured, where each value came from, sign-up URLs for what is not  |
| `setup_credentials` | Prompt for and store credentials in the `0600` file                                         |
| `provider_status`   | Every price provider: key, rate, budget consumed, and whether it is sitting out a cap       |
| `cache_status`      | What the local response cache holds, by source, and where the database lives                |
| `cache_clear`       | Drop cached responses so the next call refetches. `expiredOnly` never discards a live entry |

### Screen the market

| Tool            | What it does                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `screen_market` | Every SEC filer that reported in a quarter, via the XBRL `frames` endpoint — five requests regardless of universe size. Ranked by NCAV as a share of tangible book |

`screen_market` attaches **no prices**, on purpose: pairing a stale quote with
a filing figure is the mistake this server exists to prevent. Its output is a
candidate list for `analyze_ticker`, not a verdict.

### Check the name is not already dead

| Tool                  | What it does                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `check_disqualifiers` | One request against the SEC filing index: restatements, auditor changes, bankruptcy, delisting, late filings                                           |
| `uk_company_status`   | The UK analogue, from the Companies House register: liquidation, administration, strike-off, overdue accounts, insolvency history, charges over assets |

Run these before any valuation work.

### Verify one name

| Tool                      | What it does                                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `analyze_ticker`          | The full workup: disqualifier scan, then tangible book, NCAV, NNWC and net cash from XBRL line items, then a dated price, then the Schloss and Graham verdicts. Stops before valuation if the name is disqualified |
| `get_quotes`              | Current prices for a list of tickers, each with its as-of date and the provider it came from                                                                                                                       |
| `check_corporate_actions` | Listing status, splits and dividends. A split between the balance-sheet date and today makes every per-share figure wrong by the split factor                                                                      |
| `short_interest`          | FINRA consolidated short interest — the market's own answer to "why is this cheap?". Context, not a veto                                                                                                           |
| `bank_call_report`        | FDIC call reports: tangible common equity, noncurrent loans, allowance coverage. The asset tests that work on a financial                                                                                          |

### Look outside the US

| Tool                | What it does                                                                                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `edinet_search`     | Japanese filings by company name, TSE ticker or EDINET code, from the FSA's EDINET. Indexed by date, not by company, so it walks back a day per request — annual reports cluster in late June |
| `edinet_financials` | Balance-sheet line items and the Graham tests for a Japanese filer, from its EDINET XBRL, converted at a dated ECB rate                                                                       |
| `uk_company_search` | Find a UK company on the Companies House register and get its company number                                                                                                                  |
| `fx_rate`           | Exchange rates from the ECB, current or historical. A balance sheet in yen cannot be compared against a dollar cash balance without one                                                       |

`uk_company_status` returns no financials: UK accounts are filed as iXBRL or
PDF documents rather than structured data, so the UK path is a disqualifier
check, not a valuation.

### Size a book and rebalance it

| Tool               | What it does                                                                                                                                                                                             |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build_allocation` | Verified candidates plus a cash balance into whole-share targets. Equal weight, per-name cap, always rounds down so the plan cannot exceed the balance                                                   |
| `plan_rebalance`   | Current holdings against target weights into buys, sells and full exits. Compares market value rather than share count, reports sells before the buys they fund, and says when the buys are not fundable |

Only pass names you have actually verified. A weighting implies a level of
diligence a screen does not provide.

### Read your actual portfolio

Read-only. This server never places, modifies or cancels an order.

Every tool here reads **all connected brokerages as one book**. Two hundred
shares at one broker and a hundred at another is a three-hundred-share
position, and weighting it per broker would be wrong at the only level that
matters. What the combined view never loses is where the shares actually sit:
a sale happens at a broker, and which one decides its tax consequence.

| Tool                  | What it does                                                                                                                                                     |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `broker_connect`      | Authorize a broker that needs it. E\*TRADE returns a URL and shows a short code out of band, which you pass back as `verifier`; Alpaca needs no handshake at all |
| `broker_accounts`     | Every account at every connected broker, with the `ref` the other tools take and the tax treatment of each                                                       |
| `broker_positions`    | The whole book, combined per ticker and marked at each broker's last trade with that trade's date, emitted in exactly the shape `plan_rebalance` takes           |
| `broker_balances`     | Cash available to invest, settled versus unsettled, total value and open margin calls, per account and summed                                                    |
| `broker_transactions` | Trades, dividends, transfers and fees for **one** account — history is where basis is reconstructed, and interleaving two ledgers would obscure it               |
| `broker_environment`  | Show or switch which book each broker is pointed at, without mixing credentials                                                                                  |
| `broker_disconnect`   | Revoke and delete a stored session token, leaving the API keys in place                                                                                          |

Supported today: **E\*TRADE** and **Alpaca**. Adding a third is an adapter
against `BrokerAdapter` plus one line in the registry — no tool changes.

Four things the combined view does that a per-broker one cannot.

**It never sums a simulated book into a real one.** If one broker is live and
another is in its paper or sandbox book, the live side is used and the other is
excluded by name. Synthetic cash folded into a real balance is a figure someone
could size an allocation against, and E\*TRADE's sandbox in particular answers a
request for GOOG with AAPL. Pass `broker` to read a simulated book on its own.

**A broker that is down does not hide the rest.** Its accounts are reported as
missing and every affected total says it is short — a plan built from a book
that quietly lost a broker is worse than one that admits a gap.

**Tax treatment does not combine.** The same ticker in a Roth and a taxable
account has no single answer to "does selling realise a gain?". That reads
`mixed`, the handoff to `plan_rebalance` says `unknown`, and no gain figure is
offered for those names. Which account a sale comes out of is your decision.

**Disagreeing marks are reported, not averaged.** Two brokers can quote the same
security differently, usually because one is showing a last trade from an
earlier session. The newest mark is used and the gap is named.

**E\*TRADE tokens die at midnight US Eastern.** They also go idle after two
hours, which the server renews automatically; midnight it cannot. There is no
refresh token, so re-authorising needs a human to read a verifier code back.
Alpaca uses static API keys and has no such expiry, which makes it the better
choice for anything scheduled.

### Monitor positions between sessions

| Tool                 | What it does                                                                                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `watch_status`       | Recent runs, snapshot age, rules armed, file locations. Check this before trusting that anything is being watched    |
| `watch_alerts`       | Alerts fired, each with the reference price and its date, the observed price and its date, and the rule that tripped |
| `watch_rules`        | The armed rules and their thresholds                                                                                 |
| `watch_rule_set`     | Create or update a price-move alarm. Local state only; never touches the broker                                      |
| `watch_rule_remove`  | Delete a rule and its recorded reference prices                                                                      |
| `watch_snapshot_set` | Record the holdings to monitor, in the shape `broker_positions` emits                                                |

See [Scheduled monitoring](#scheduled-monitoring) for how this runs when no
session is open, and what it genuinely cannot do.

### Understand the context

| Tool                      | What it does                                                                                                                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `macro_context`           | Moody's Aaa yield, the 10-year, CPI, and the P/E ceiling they imply. Graham wanted an earnings yield of at least twice the Aaa yield, so the hurdle moves with the bond market. Needs a FRED key |
| `price_history_stats`     | Liquidity, days to sell a position of a given size, distance below the 52-week high, normal daily move                                                                                           |
| `congress_trades`         | Disclosed Senate transactions searchable **by ticker** or member, with each member's committee seats                                                                                             |
| `congress_index`          | How much Senate disclosure history is indexed locally, and backfill further                                                                                                                      |
| `congress_member_profile` | A senator's committees, board seats and outside positions, plus every employer paying the household                                                                                              |
| `congress_house_filings`  | House transaction-report filings with PDF links — the filing record, not the transactions inside it                                                                                              |

Two warnings the tools repeat in their own output.

**`price_history_stats` is not part of the screen.** This is an asset test; no
statistic in that tool bears on whether a balance sheet is cheap, and none of
it may be used to time a purchase. Its one legitimate veto is liquidity — deep
value lives in micro caps where the discount is often just the illiquidity, and
a name you cannot exit is a name you cannot own. RSI, MACD and every other
timing construct are deliberately absent.

**Congressional disclosures sit outside the method.** Amounts are bands
reported weeks late, so nothing there can be a figure the screen acts on. The
committee cross-reference is the part carrying real information. eFD cannot be
searched by ticker — its form takes a filer name, a state and a filing-date
window and nothing else — so transactions are parsed into a local SQLite index
and queried there; `congress_index` reports how deep that index reaches, and a
search finds only what has been indexed.

## How it gets its data

**SEC EDGAR is authoritative and everything else is a cross-check.** EDGAR is
the filing itself: exact line items, each carrying its accession number, form
type, period end and filing date. A vendor's normalisation of a filing loses to
the filing, and derived "net cash" figures from screeners have been wrong in
testing.

| Endpoint                  | Used for                                                                                                                         |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `api/xbrl/companyconcept` | One concept, full history, small payload. The workhorse for balance-sheet work                                                   |
| `api/xbrl/frames`         | One concept across every filer in a period. This is the market-wide screen                                                       |
| `submissions`             | The filing index, including the 8-K `items` array that makes the disqualifier checks a structured lookup rather than a news read |

**Every price carries its date.** In testing, two fetches of one ticker minutes
apart returned $18.42 dated Sep 4 and $15.50 dated Jul 10 — a 19% spread on the
same security, hours apart, both presented as "the price". A number without its
date is arbitrary, which is why `Quote.asOf` is not optional, why a computed
metric reports the date of its _oldest_ input rather than its newest, and why a
rebalance plan flags any order whose price is undated.

Sources that need no credential at all: SEC EDGAR (a contact string, not a
key), FINRA, FDIC BankFind, Senate eFD, the House Clerk's index, the
`unitedstates/congress-legislators` rosters, and Frankfurter for ECB reference
rates.

## Price providers and free-tier caps

Quote providers are a **failover pool**, not a fixed chain. A request tries them
in order and skips any that has no key, is cooling down, or has spent its
budget. Any one of them is enough; more simply buys headroom.

| Provider                | Free tier                                 | Notes                                                                                     |
| ----------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------- |
| Tiingo                  | ~50 unique tickers/hour, 500 requests/day | Split- and dividend-adjusted. The preferred source                                        |
| Polygon.io              | 5/minute, end-of-day, ~2 years of history | Also the reference data behind `check_corporate_actions`                                  |
| Finnhub                 | 60/minute, no daily cap                   | The most generous free quote tier here                                                    |
| Twelve Data             | 8/minute, 800/day                         | Carries an explicit trade date                                                            |
| Alpaca                  | 200/minute on the free plan               | Most headroom of any tier here. IEX feed, so a thin micro cap may not have printed at all |
| Financial Modeling Prep | 250/day                                   | Free tier restricted to large caps                                                        |
| Alpha Vantage           | 5/minute, **25/day**                      | Effectively a spot-check                                                                  |
| EOD Historical Data     | 20/day                                    | The only **non-US** coverage. Pass `7203.TSE`                                             |

**Usage is counted locally and checked before a request goes out**, against
each service's documented limits, rather than inferred from a 429 afterwards.
On a daily cap that distinction matters: a rejected call still counts against
you, so learning reactively spends a request that was never going to work. A
429 is still honoured as a backstop, since the same key may be in use
elsewhere. Counters live in SQLite and survive a restart, because a daily quota
does not reset just because the process did.

Tiingo meters **unique symbols per month**, not only requests, so a single
large screen can spend a substantial share of the month while the request
counters still look healthy. Distinct symbols are tracked separately;
re-reading one already counted this month is free.

### If you pay for a plan

The defaults above are free-tier limits, so without overriding them a paid plan
runs at free speed.

| Variable                                | Effect                                                                                            |
| --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `CIGAR_BUTT_BUDGET_<PROVIDER>_<PERIOD>` | Call budget, e.g. `CIGAR_BUTT_BUDGET_POLYGON_MINUTE=0`. **0 means unlimited**                     |
| `CIGAR_BUTT_RATE_<PROVIDER>`            | Requests per second, e.g. `CIGAR_BUTT_RATE_POLYGON=100`                                           |
| `CIGAR_BUTT_PROVIDER_ORDER`             | Preference order, e.g. `polygon,tiingo`. Unlisted providers keep their default order behind these |

## Caching

Responses are cached in SQLite (`node:sqlite`, built into Node 24, so it costs
no dependency). The free tiers are the binding constraint: a full per-name
balance sheet is twelve `companyconcept` calls plus a `submissions` fetch. MCP
servers also restart whenever a client reconnects, so an in-memory cache would
throw the expensive work away at every session boundary.

TTLs are set by how fast the underlying fact can actually change.

| Source                     | TTL      | Why                                                                                |
| -------------------------- | -------- | ---------------------------------------------------------------------------------- |
| Quotes                     | 1 hour   | Short on purpose. A stale price is the single largest source of wrong answers here |
| SEC balance-sheet concepts | 24 hours | These change only when a filing lands                                              |
| SEC filing index           | 6 hours  | Gains rows continuously; a new 8-K must not be missed                              |
| SEC frames                 | 7 days   | A quarter's data is fixed once filed                                               |
| Ticker index               | 7 days   | A ~1MB payload that changes at the margins                                         |

Quotes are cached per provider, because two providers can legitimately disagree
and blending them under one key would hide it. `cache_status` shows what is
held, `cache_clear` drops it, and `CIGAR_BUTT_NO_CACHE=1` bypasses it entirely.

## Scheduled monitoring

`cigar-butt watch` polls your holdings on a timer and alerts on moves beyond a
threshold you set. Bare `cigar-butt` is still the MCP server; only the explicit
`watch` subcommand branches away.

```bash
cigar-butt watch rule add drawdown '*' 10   # alert on any held name moving 10%
cigar-butt watch install                    # write a launchd agent (macOS)
launchctl load -w ~/Library/LaunchAgents/dev.cigar-butt.watch.plist
cigar-butt watch status
```

`cigar-butt watch` with no arguments prints the full subcommand list. The
`watch_*` tools do the same work over the same database from inside a session.
Nothing here places, modifies or cancels an order.

**The MCP server cannot schedule anything.** A stdio server is a subprocess and
dies with its client, and the protocol gives a server no way to reach an absent
user, on any transport. So the OS scheduler runs a short-lived `watch run`, and
the server reads what it recorded. See
[`docs/scheduling-research.md`](docs/scheduling-research.md) for why this shape
and not a daemon, and what is genuinely impossible.

Three limits worth knowing before relying on it:

- **Alarm latency is the poll interval.** That is what free price tiers buy:
  Alpha Vantage allows 25 requests a day, Tiingo about 50 an hour, and a
  20-name book polled every 15 minutes would exhaust them by lunchtime. This is
  a check, not a tripwire.
- **Price alarms need no broker.** They run against a stored holdings snapshot
  using only a price key, so they work overnight, at weekends, and
  indefinitely.
- **Broker refresh does not survive midnight.** E\*TRADE tokens expire at
  midnight US Eastern with no refresh token. Refresh the snapshot while you are
  authorised; every alert states the snapshot's age rather than pretending it
  is current.

Alerts go to stderr, a log file, a macOS notification, or a Slack/Discord
webhook (`CIGAR_BUTT_WATCH_WEBHOOK`). Test one before you need it:
`cigar-butt watch test macos`. A cooldown, a hysteresis latch, optional
re-baselining and one notification per cycle keep alerts from storming.

## What it will not do

**It will not place a trade.** Every brokerage tool is read-only, and that is a
design decision rather than an unfinished feature.

**It will not backtest.** A backtest assembled from a list picked with
present-day knowledge is survivorship-biased by construction: you chose those
names partly because they still exist, so any return figure flatters the
strategy. Free price sources are neither survivorship-bias-free nor
point-in-time correct, which is exactly what a research database like CRSP buys
you. For a real backtest, use point-in-time data with delistings included.

**It will not estimate what a trade costs.** For a micro-cap book the published
fee is a rounding error and the bid-ask spread is the trade cost, and the ratio
between them is roughly two orders of magnitude: about $0.41 of statutory
charges on a $10,000 sale, against a plausible several hundred dollars of
round-trip spread. Spread and market impact are not observable from anything
here, so they are not estimated — printing a precise figure for the $0.41 while
saying nothing about the rest would be read as _the_ cost. Fee figures in the
output are statutory charges only. See
[`docs/trading-costs-research.md`](docs/trading-costs-research.md).

**It will not compute a tax liability.** It reports the account classification
and cost basis a broker records, and will do arithmetic on two figures it was
given, but holding period, wash sales and basis adjustments are not modelled,
and a number that looked like a tax bill would be believed as one. An account
whose tax treatment reads `unknown` is undetermined and is never assumed
taxable. See
[`docs/tax-treatment-research.md`](docs/tax-treatment-research.md).

**It will not name a stock it has not fetched this session.** A name reaches
the output only with a dated figure behind it.

## Configuration reference

| Variable                   | Default                                        | Purpose                                |
| -------------------------- | ---------------------------------------------- | -------------------------------------- |
| `CIGAR_BUTT_ENV_FILE`      | unset                                          | Load credentials from this dotenv file |
| `CIGAR_BUTT_CONFIG`        | `$XDG_CONFIG_HOME/cigar-butt/credentials.json` | Where credentials are stored           |
| `CIGAR_BUTT_CACHE`         | `$XDG_CACHE_HOME/cigar-butt/cache.sqlite`      | Cache database location                |
| `CIGAR_BUTT_NO_CACHE`      | unset                                          | Set to `1` to bypass the cache         |
| `CIGAR_BUTT_CONGRESS_DB`   | under the cache directory                      | Senate disclosure index location       |
| `CIGAR_BUTT_WATCH_DB`      | under the cache directory                      | Watch state: snapshot, rules, alerts   |
| `CIGAR_BUTT_WATCH_LOG`     | unset                                          | Write watch alerts to this file        |
| `CIGAR_BUTT_WATCH_WEBHOOK` | unset                                          | Slack or Discord webhook for alerts    |
| `CIGAR_BUTT_SETTINGS_DB`   | under the cache directory                      | Remembered tool preferences            |

Provider budgets and rates are in
[Price providers](#price-providers-and-free-tier-caps); every credential
variable is in [`docs/credentials.md`](docs/credentials.md), and
[`.env.template`](.env.template) is a complete annotated file.

## Development

```bash
pnpm install
pnpm check        # lint, format:check, typecheck, knip, test
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

**All arithmetic goes through decimal.js.** `number` appears at the I/O
boundary — JSON in from an API, JSON out to the MCP client — and nowhere in
between. Partly for pennies, mostly because these figures are compared against
hard thresholds: binary floating point puts a name on the wrong side of "P/TBV
below 1.0" often enough to matter when the whole method is _buy below the
line_.

**Nothing may write to stdout.** That stream is the MCP protocol. A stray
`console.log` corrupts it and the client drops the connection, which is why
`no-console` is an error across `src/` and why the watch CLI prints to stderr.

[`CLAUDE.md`](CLAUDE.md) has the full architecture and the hard rules;
[`STYLEGUIDE.md`](STYLEGUIDE.md) has the TypeScript conventions.
`docs/credentials.md` is generated from `src/config/providers.ts` by
`pnpm docs:credentials` — do not edit it by hand.

## Disclaimer and licence

This software is not investment, financial, tax or legal advice, creates no
advisory or fiduciary relationship, comes with no warranty of any kind, and its
author accepts no liability for any loss arising from its use. Read
[DISCLAIMER.md](DISCLAIMER.md) in full before using it for anything involving
real money.

Licensed under Apache-2.0. See [LICENSE](LICENSE), whose sections 7 and 8 carry
the warranty disclaimer and limitation of liability that govern.
