<!--
  GENERATED FILE — do not edit by hand.
  Written from src/config/providers.ts by scripts/generate-credentials-doc.ts.
  Run `pnpm docs:credentials` after changing the registry; CI fails on drift.
-->

# Credentials

Every integration cigar-butt can use, what it unlocks, and where to sign up.

**Credentials are optional and checked per tool.** Nothing is globally blocked —
a tool asks only for what it actually uses, so the rest of the server keeps
working while you fill things in. Start with `SEC_USER_AGENT` (no registration,
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

The file is written by the `setup_credentials` tool at mode `0600`:

```
$XDG_CONFIG_HOME/cigar-butt/credentials.json
~/.config/cigar-butt/credentials.json          # fallback
```

It is a flat JSON object keyed by the environment-variable names below:

```json
{
  "SEC_USER_AGENT": "…",
  "TIINGO_API_KEY": "…",
  "POLYGON_API_KEY": "…",
  "ALPHAVANTAGE_API_KEY": "…",
  "ALPACA_PAPER_API_KEY_ID": "…",
  "ALPACA_PAPER_API_SECRET_KEY": "…",
  "ALPACA_LIVE_API_KEY_ID": "…",
  "ALPACA_LIVE_API_SECRET_KEY": "…",
  "EODHD_API_KEY": "…",
  "FINNHUB_API_KEY": "…",
  "TWELVEDATA_API_KEY": "…",
  "FMP_API_KEY": "…",
  "ETRADE_SANDBOX_CONSUMER_KEY": "…",
  "ETRADE_SANDBOX_CONSUMER_SECRET": "…",
  "ETRADE_PROD_CONSUMER_KEY": "…",
  "ETRADE_PROD_CONSUMER_SECRET": "…",
  "COMPANIES_HOUSE_API_KEY": "…",
  "EDINET_API_KEY": "…",
  "FRED_API_KEY": "…",
  "ETRADE_ENVIRONMENT": "production"
}
```

Nothing is ever written into a project directory. To point the server at an
existing dotenv file instead, set `CIGAR_BUTT_ENV_FILE`. See
[`.env.template`](../.env.template) for an annotated example.

> **Do not commit a filled-in copy anywhere.** If a credential has been pasted
> into a chat, an issue or a log, rotate it — brokerage keys first.

## Works with no credential at all

| Source               | Used by                                                  | Notes                                                          |
| -------------------- | -------------------------------------------------------- | -------------------------------------------------------------- |
| SEC EDGAR            | `analyze_ticker`, `check_disqualifiers`, `screen_market` | Needs a contact string, not a key — see `SEC_USER_AGENT` below |
| FINRA                | `short_interest`                                         | Consolidated short interest                                    |
| FDIC BankFind        | `bank_call_report`                                       | Bank call reports                                              |
| Senate eFD           | `congress_trades`, `congress_member_profile`             | Official disclosures                                           |
| House Clerk          | `congress_house_filings`                                 | Official filing index                                          |
| congress-legislators | committee cross-reference                                | Committee and subcommittee rosters                             |
| Frankfurter (ECB)    | `fx_rate`                                                | Daily reference exchange rates                                 |

## Required

### SEC EDGAR User-Agent

`SEC_USER_AGENT` — **Required**

Balance-sheet line items and the filing index. No API key exists — EDGAR identifies callers by a descriptive User-Agent containing a real name and email. Without one it returns 403 and may block the IP.

**Sign up:** https://www.sec.gov/os/webmaster-faq#developers

**How to get one:**

1. There is nothing to register for and no key to obtain.
2. Set SEC_USER_AGENT to your real name and a working email address, in that order, e.g. "Jane Doe jane@example.com".
3. EDGAR uses it to contact you if your traffic causes a problem. A fake value is worse than none: EDGAR returns 403 without a valid one and may block your IP for abuse.

## Price providers

Quote providers are a **failover pool**. A request tries them in order and skips
any that has no key, is cooling down, or has spent its budget — so **any one of
these is enough**, and more simply buys headroom. Usage is counted locally
against the documented limits below and checked before a request goes out.

`provider_status` shows consumption and can clear recorded caps.

| Provider                  | Variable                      | Free tier                                                     |
| ------------------------- | ----------------------------- | ------------------------------------------------------------- |
| Tiingo                    | `TIINGO_API_KEY`              | ~50 unique tickers/hour, 500 requests/day on the free tier    |
| Polygon.io                | `POLYGON_API_KEY`             | 5 calls/minute, end-of-day data, ~2 years of history on Basic |
| Alpha Vantage             | `ALPHAVANTAGE_API_KEY`        | ~25 requests/day, 5 calls/minute                              |
| Alpaca paper (key ID)     | `ALPACA_PAPER_API_KEY_ID`     | 200 requests/minute on the free Basic plan                    |
| Alpaca paper (secret key) | `ALPACA_PAPER_API_SECRET_KEY` | —                                                             |
| EOD Historical Data       | `EODHD_API_KEY`               | 20 requests/day on the free tier                              |
| Finnhub                   | `FINNHUB_API_KEY`             | 60 calls/minute, no daily cap                                 |
| Twelve Data               | `TWELVEDATA_API_KEY`          | 800 requests/day, 8/minute                                    |
| Financial Modeling Prep   | `FMP_API_KEY`                 | 250 requests/day; free tier restricted to large caps          |

### Tiingo

`TIINGO_API_KEY` — Price pool

Split- and dividend-adjusted daily closes. The preferred price source.

**Free tier:** ~50 unique tickers/hour, 500 requests/day on the free tier

**Sign up:** https://www.tiingo.com/account/api/token

### Polygon.io

`POLYGON_API_KEY` — Price pool

Whole-market daily bars in one call, delisted-ticker reference data, and corporate actions. The grouped-aggregates endpoint is what makes a market-wide screen affordable.

**Free tier:** 5 calls/minute, end-of-day data, ~2 years of history on Basic

**Sign up:** https://polygon.io/dashboard/api-keys

### Alpha Vantage

`ALPHAVANTAGE_API_KEY` — Price pool

Fundamentals cross-check (OVERVIEW, BALANCE_SHEET) and a last-resort quote. Too rate-limited to screen with; use it to sanity-check a finalist.

**Free tier:** ~25 requests/day, 5 calls/minute

**Sign up:** https://www.alphavantage.co/support/#api-key

### Alpaca paper (key ID)

`ALPACA_PAPER_API_KEY_ID` — Price pool

Quotes, with by far the most headroom of any free tier here — 200 a minute against Tiingo’s 50 an hour — and a paper brokerage account the portfolio tools can read. Free, no card. Requires ALPACA_PAPER_API_SECRET_KEY alongside it. The free plan carries the IEX feed rather than the consolidated tape, so quotes differ slightly from other providers and a thin micro cap may not have printed on IEX at all.

**Free tier:** 200 requests/minute on the free Basic plan

**Sign up:** https://alpaca.markets/

**How to get one:**

1. Sign up at https://alpaca.markets/ — a paper-trading account is free and needs no card or funding.
2. Generate an API key in the dashboard. You get a Key ID (starting "PK" for paper) and a Secret Key, and the secret is shown ONCE — regenerate the pair rather than hunting for a lost one.
3. Set ALPACA_PAPER_API_KEY_ID and ALPACA_PAPER_API_SECRET_KEY. Both are required; half a pair is an error rather than a silent fallback.
4. For a funded account, use the ALPACA_LIVE_* pair instead and switch with ALPACA_ENVIRONMENT=live. A live key starts "AK", and pointing a paper key at the live host (or the reverse) is caught with a clear error.
5. The unscoped ALPACA_API_KEY_ID / ALPACA_API_SECRET_KEY still work as a fallback for either environment, so an existing setup keeps running.

### Alpaca paper (secret key)

`ALPACA_PAPER_API_SECRET_KEY` — Price pool

Issued with the paper key ID; both are needed.

**Sign up:** https://alpaca.markets/

### EOD Historical Data

`EODHD_API_KEY` — Price pool

Quotes for **non-US listings** — the one source here that covers them, which matters because net-nets have been scarcer in the US than in Japan and Korea for a decade. Pass an exchange-suffixed ticker such as 7203.TSE. Its free tier is the tightest in the pool, so it is tried last.

**Free tier:** 20 requests/day on the free tier

**Sign up:** https://eodhd.com/register

### Finnhub

`FINNHUB_API_KEY` — Price pool

Real-time quotes. The most generous free quote tier here by a wide margin, which makes it a good primary when screening many names. Its congressional-trading endpoint is premium and is not used.

**Free tier:** 60 calls/minute, no daily cap

**Sign up:** https://finnhub.io/register

### Twelve Data

`TWELVEDATA_API_KEY` — Price pool

Quotes with an explicit trade date. A solid mid-tier fallback.

**Free tier:** 800 requests/day, 8/minute

**Sign up:** https://twelvedata.com/pricing

### Financial Modeling Prep

`FMP_API_KEY` — Price pool

Quotes — but its free tier covers LARGE CAPS ONLY. Verified: AAPL and MSFT answer, while small caps are refused with HTTP 402. That is a poor fit for a small-cap deep-value screen, so expect it to serve almost nothing unless you pay. Kept in the pool because a paid key has full coverage and it costs nothing to leave configured.

**Free tier:** 250 requests/day; free tier restricted to large caps

**Sign up:** https://site.financialmodelingprep.com/developer/docs

## Optional integrations

### Alpaca live (key ID)

`ALPACA_LIVE_API_KEY_ID` — Optional

A funded Alpaca account. Read-only here — this server never places an order — but it reads a real book, so it is kept separate from the paper pair rather than sharing one slot.

**Sign up:** https://alpaca.markets/

### Alpaca live (secret key)

`ALPACA_LIVE_API_SECRET_KEY` — Optional

Issued with the live key ID; both are needed.

**Sign up:** https://alpaca.markets/

### E*TRADE sandbox consumer key

`ETRADE_SANDBOX_CONSUMER_KEY` — Optional

Proves the OAuth connection works against synthetic data. Instant and self-service. Sandbox returns canned figures that do NOT match what you ask for, so never read a real number from it.

**Sign up:** https://us.etrade.com/etx/ris/apikey

**How to get one:**

1. You need an E*TRADE account to get either key. It does NOT have to be funded — funding is only required to place trades. Open one at https://us.etrade.com if you have none.
2. SANDBOX KEY (start here — instant, self-service, safe). Log in at https://us.etrade.com, then go to https://us.etrade.com/etx/ris/apikey and the generator shows a consumer key and secret on the page immediately. Sandbox returns canned data that does NOT match what you ask for — request GOOG and you may get AAPL — so use it to prove the connection works, never to read real numbers.
3. PRODUCTION KEY, step 1 of 3: complete the API User Intent Survey at https://us.etrade.com/etx/ris/apisurvey/#/questionnaire
4. PRODUCTION KEY, step 2 of 3: sign the API Developer Agreement at https://us.etrade.com/etx/ris/apisurvey/#/agreement — the terms are at https://us.etrade.com/l/f/agreement-library/api-developer-licensing-agreement
5. PRODUCTION KEY, step 3 of 3: complete the annual market-data Attestation at https://us.etrade.com/etx/ris/apisurvey/#/attestation . This one recurs every year; letting it lapse costs you market-data access.
6. An INDIVIDUAL production key is displayed on screen the moment those three are done — no email, no PDF, no phone call, no review. A VENDOR key (multi-user or redistributed) is issued Inactive and E*TRADE will email you to schedule a short demo with Product and Legal first.
7. Also sign the Market Data Agreement inside your brokerage account, or quote data is refused.
8. An individual key is locked to the user ID that created it. Using it under a different login fails with a deliberately vague error and no authorization screen. It does work across every account under your own login.
9. Set ETRADE_ENV to "sandbox" or "production" to choose which pair is used. You can hold both at once: the server reads ETRADE_SANDBOX_CONSUMER_KEY / ETRADE_PROD_CONSUMER_KEY (and the matching _SECRET) before the unscoped names, so switching is one variable. The two pairs are NOT interchangeable — a sandbox token is rejected by production even if sent to the right host.
10. Finally, run the `broker_connect` tool. It returns a URL to open, E*TRADE shows you a short verifier code, and you paste that back. No browser redirect is involved, so nothing needs to listen on a port. The request token expires 5 minutes after issue, so do not wander off mid-flow.
11. Token lifecycle, so nothing surprises you: the access token idles out after 2 hours (the server renews automatically inside that window) and dies at midnight US Eastern, which nothing can renew past. After midnight, run `broker_connect` again.

### E*TRADE sandbox consumer secret

`ETRADE_SANDBOX_CONSUMER_SECRET` — Optional

Issued on the same page as the sandbox key.

**Sign up:** https://us.etrade.com/etx/ris/apikey

### E*TRADE production consumer key

`ETRADE_PROD_CONSUMER_KEY` — Optional

Reads real holdings, balances and transactions from your E*TRADE account so a rebalance can be planned against the actual book. Read-only — this server never places an order. Not interchangeable with the sandbox key; both can be stored at once and switched with the `broker_environment` tool.

**Free tier:** ~2 requests/second and 7,000/hour on the accounts module

**Sign up:** https://developer.etrade.com/getting-started

**How to get one:**

1. Three forms on us.etrade.com, in order, while logged in.
2. Step 1 — API User Intent Survey: https://us.etrade.com/etx/ris/apisurvey/#/questionnaire
3. Step 2 — API Developer Agreement: https://us.etrade.com/etx/ris/apisurvey/#/agreement
4. Step 3 — annual market-data Attestation: https://us.etrade.com/etx/ris/apisurvey/#/attestation . This one recurs yearly; letting it lapse costs market-data access.
5. An INDIVIDUAL key is then displayed on screen immediately — no email, no PDF, no phone call, no review. A VENDOR key (multi-user or redistributed) is issued Inactive and E*TRADE emails you to schedule a short demo with Product and Legal first.
6. Your E*TRADE account does NOT need to be funded to get a key; funding is only required to place trades. An individual key is locked to the user ID that created it, and works across every account under that login.
7. Also sign the Market Data Agreement inside the brokerage account, or quote data is refused.

### E*TRADE production consumer secret

`ETRADE_PROD_CONSUMER_SECRET` — Optional

Issued on the same screen as the production key.

**Sign up:** https://developer.etrade.com/getting-started

### UK Companies House

`COMPANIES_HOUSE_API_KEY` — Optional

The UK statutory register: company status, liquidation and administration, strike-off proposals, overdue accounts, insolvency history and registered charges. Powers the UK disqualifier check. It carries no financials — UK accounts are filed as documents, not data.

**Free tier:** 600 requests per 5 minutes

**Sign up:** https://developer.company-information.service.gov.uk/

**How to get one:**

1. Register at https://developer.company-information.service.gov.uk/
2. Create an application, then add a **REST API key** to it (not a streaming key — they are separate and not interchangeable).
3. Use the LIVE key rather than the sandbox one; the sandbox register is test data and will not describe real companies.
4. The key is sent as an HTTP Basic username with an empty password, which this server handles — paste the key alone into COMPANIES_HOUSE_API_KEY.

### EDINET (Japan FSA)

`EDINET_API_KEY` — Optional

Japanese regulatory filings — the FSA's equivalent of SEC EDGAR, with XBRL accounts since 2008. This is the one that matters for the method: net-nets have been far scarcer in the US than in Japan for a decade, so a Graham screen without it is looking in the wrong market. Free, and issued instantly.

**Free tier:** No published cap; treated as 2 requests/second here

**Sign up:** https://api.edinet-fsa.go.jp/WEEE0090.aspx

**How to get one:**

1. Create an EDINET account at https://api.edinet-fsa.go.jp/api/auth/index.aspx?mode=1 and confirm the link emailed to you. This is a Microsoft identity login.
2. THEN GO STRAIGHT TO THE KEY PAGE: https://api.edinet-fsa.go.jp/WEEE0090.aspx — this is the 「ＡＰＩキー発行画面」(API key issuance screen), and it is a different page from the account page above.
3. Why that matters: after logging in you land back on the account page, which renders BLANK. It is not broken. Its only job is to call a window.open() popup pointing at WEEE0090.aspx, so any popup blocker leaves you staring at an empty page with no error. Brave blocks it even with Shields disabled, because popup permission is a separate setting. Navigating to WEEE0090.aspx directly sidesteps the popup entirely.
4. If the key page itself is blank too, the site is a 2008-era ASP.NET WebForms app and privacy browsers break its postbacks. Use Safari or Chrome for this one-time step.
5. Ignore the browser console warning about an unrecognized Content-Security-Policy directive. It refers to a deprecated directive and is unrelated to the blank page.
6. Copy the issued key into EDINET_API_KEY.

### FRED (St. Louis Fed)

`FRED_API_KEY` — Optional

Moody's Aaa corporate bond yield, which sets Graham's earnings-yield hurdle, plus CPI for real-return adjustment and the 10-year Treasury. Without it `macro_context` cannot run; nothing else is affected.

**Free tier:** 120 requests/minute, no daily cap

**Sign up:** https://fredaccount.stlouisfed.org/apikeys

**How to get one:**

1. Create a free FRED account at https://fredaccount.stlouisfed.org/login/secure/
2. Go to https://fredaccount.stlouisfed.org/apikeys and click "Request API Key".
3. State any brief purpose — the key is issued immediately, with no review.

## Tuning

All optional. The rate and budget defaults are each provider's **free tier**, so
raise them if you pay for more — otherwise a paid plan is throttled to free speed.

| Variable                                | Effect                                                          |
| --------------------------------------- | --------------------------------------------------------------- |
| `CIGAR_BUTT_ENV_FILE`                   | Load credentials from a dotenv file at this path                |
| `CIGAR_BUTT_CONFIG`                     | Override the credential file location                           |
| `CIGAR_BUTT_CACHE`                      | Override the response-cache database                            |
| `CIGAR_BUTT_CONGRESS_DB`                | Override the congressional index database                       |
| `CIGAR_BUTT_NO_CACHE`                   | Set to `1` to bypass the cache entirely                         |
| `CIGAR_BUTT_PROVIDER_ORDER`             | Preferred provider order, e.g. `polygon,tiingo`                 |
| `CIGAR_BUTT_RATE_<PROVIDER>`            | Requests per second, e.g. `CIGAR_BUTT_RATE_POLYGON=100`         |
| `CIGAR_BUTT_BUDGET_<PROVIDER>_<PERIOD>` | Call budget, e.g. `..._POLYGON_MINUTE=0`. **0 means unlimited** |
