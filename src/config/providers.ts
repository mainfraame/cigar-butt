/**
 * The credential registry. Every provider the server can talk to is described
 * here once: the env var it reads, where a user signs up, and whether the
 * server can function without it. The first-run setup flow, the
 * `setup_status` tool and the README's credential table are all generated
 * from this list, so adding a provider means editing exactly one place.
 */

/** How badly the server needs a given credential. */
type ProviderRequirement =
  /** Server refuses to run screens without it. */
  | 'one-of'
  /** Enriches output; everything works without it. */
  | 'optional'
  /** At least one provider in the same `group` must be present. */
  | 'required';

export interface ProviderSpec {
  /** Environment variable / credential-file key. */
  readonly envVar: string;
  /** Members of a `one-of` set share this tag. */
  readonly group?: string;
  readonly id: string;
  readonly label: string;
  /** Shown to the user during setup. */
  readonly purpose: string;
  /** Free-tier ceiling, stated plainly so callers can pace themselves. */
  readonly rateLimit?: string;
  readonly requirement: ProviderRequirement;
  /**
   * Step-by-step registration walkthrough, for providers where "go to this URL"
   * is not enough. Rendered as a numbered list during setup.
   */
  readonly setupSteps?: readonly string[];
  /** Where to register. Shown verbatim during setup. */
  readonly signupUrl: string;
  /** Rejects obviously-wrong values before they reach the network. */
  readonly validate?: (value: string) => string | undefined;
}

const EMAIL_IN_STRING = /[^\s@]+@[^\s@]+\.[^\s@]+/;

export const PROVIDERS: readonly ProviderSpec[] = [
  {
    envVar: 'SEC_USER_AGENT',
    id: 'sec',
    label: 'SEC EDGAR User-Agent',
    purpose:
      'Balance-sheet line items and the filing index. No API key exists — EDGAR ' +
      'identifies callers by a descriptive User-Agent containing a real name and ' +
      'email. Without one it returns 403 and may block the IP.',
    requirement: 'required',
    setupSteps: [
      'There is nothing to register for and no key to obtain.',
      'Set SEC_USER_AGENT to your real name and a working email address, in ' +
        'that order, e.g. "Jane Doe jane@example.com".',
      'EDGAR uses it to contact you if your traffic causes a problem. A fake ' +
        'value is worse than none: EDGAR returns 403 without a valid one and ' +
        'may block your IP for abuse.'
    ],
    signupUrl: 'https://www.sec.gov/os/webmaster-faq#developers',
    validate: value =>
      EMAIL_IN_STRING.test(value)
        ? undefined
        : 'Must contain a real contact email, e.g. "Jane Doe jane@example.com".'
  },
  {
    envVar: 'TIINGO_API_KEY',
    group: 'prices',
    id: 'tiingo',
    label: 'Tiingo',
    purpose:
      'Split- and dividend-adjusted daily closes. The preferred price source.',
    rateLimit: '~50 unique tickers/hour, 500 requests/day on the free tier',
    requirement: 'one-of',
    signupUrl: 'https://www.tiingo.com/account/api/token'
  },
  {
    envVar: 'POLYGON_API_KEY',
    group: 'prices',
    id: 'polygon',
    label: 'Polygon.io',
    purpose:
      'Whole-market daily bars in one call, delisted-ticker reference data, and ' +
      'corporate actions. The grouped-aggregates endpoint is what makes a ' +
      'market-wide screen affordable.',
    rateLimit: '5 calls/minute, end-of-day data, ~2 years of history on Basic',
    requirement: 'one-of',
    signupUrl: 'https://polygon.io/dashboard/api-keys'
  },
  {
    envVar: 'ALPHAVANTAGE_API_KEY',
    group: 'prices',
    id: 'alphavantage',
    label: 'Alpha Vantage',
    purpose:
      'Fundamentals cross-check (OVERVIEW, BALANCE_SHEET) and a last-resort quote. ' +
      'Too rate-limited to screen with; use it to sanity-check a finalist.',
    rateLimit: '~25 requests/day, 5 calls/minute',
    requirement: 'one-of',
    signupUrl: 'https://www.alphavantage.co/support/#api-key'
  },
  {
    envVar: 'ALPACA_API_KEY_ID',
    group: 'prices',
    id: 'alpaca',
    label: 'Alpaca (key ID)',
    purpose:
      'Quotes, with by far the most headroom of any free tier here. Needs a ' +
      'paper-trading account, which is free and takes no card. Requires ' +
      'ALPACA_API_SECRET_KEY alongside it.',
    rateLimit: '200 requests/minute on the free Basic plan; IEX feed',
    requirement: 'one-of',
    setupSteps: [
      'Sign up at https://alpaca.markets/ — a paper-trading account is free ' +
        'and needs no card or funding.',
      'Open the dashboard and generate an API key; you get a Key ID and a ' +
        'Secret Key, shown once.',
      'Set ALPACA_API_KEY_ID and ALPACA_API_SECRET_KEY. Both are required.',
      'The free plan carries the IEX feed rather than full SIP, so a quote is ' +
        'IEX-only. For a screen that is fine; for execution it is not.'
    ],
    signupUrl: 'https://alpaca.markets/'
  },
  {
    envVar: 'ALPACA_API_SECRET_KEY',
    group: 'prices',
    id: 'alpaca-secret',
    label: 'Alpaca (secret key)',
    purpose: 'Issued alongside the Alpaca key ID; both are needed.',
    requirement: 'one-of',
    signupUrl: 'https://alpaca.markets/'
  },
  {
    envVar: 'EODHD_API_KEY',
    group: 'prices',
    id: 'eodhd',
    label: 'EOD Historical Data',
    purpose:
      'Quotes for **non-US listings** — the one source here that covers them, ' +
      'which matters because net-nets have been scarcer in the US than in ' +
      'Japan and Korea for a decade. Pass an exchange-suffixed ticker such as ' +
      '7203.TSE. Its free tier is the tightest in the pool, so it is tried last.',
    rateLimit: '20 requests/day on the free tier',
    requirement: 'one-of',
    signupUrl: 'https://eodhd.com/register'
  },
  {
    envVar: 'FINNHUB_API_KEY',
    group: 'prices',
    id: 'finnhub',
    label: 'Finnhub',
    purpose:
      'Real-time quotes. The most generous free quote tier here by a wide ' +
      'margin, which makes it a good primary when screening many names. Its ' +
      'congressional-trading endpoint is premium and is not used.',
    rateLimit: '60 calls/minute, no daily cap',
    requirement: 'one-of',
    signupUrl: 'https://finnhub.io/register'
  },
  {
    envVar: 'TWELVEDATA_API_KEY',
    group: 'prices',
    id: 'twelvedata',
    label: 'Twelve Data',
    purpose: 'Quotes with an explicit trade date. A solid mid-tier fallback.',
    rateLimit: '800 requests/day, 8/minute',
    requirement: 'one-of',
    signupUrl: 'https://twelvedata.com/pricing'
  },
  {
    envVar: 'FMP_API_KEY',
    group: 'prices',
    id: 'fmp',
    label: 'Financial Modeling Prep',
    purpose:
      'Quotes. Included because one key covers a lot and it extends the pool ' +
      'when other free tiers are spent — not for its fundamentals, which are a ' +
      'vendor normalisation of the EDGAR filings this server reads directly.',
    rateLimit: '250 requests/day on the free tier',
    requirement: 'one-of',
    signupUrl: 'https://site.financialmodelingprep.com/developer/docs'
  },
  {
    envVar: 'ETRADE_SANDBOX_CONSUMER_KEY',
    group: 'etrade',
    id: 'etrade-sandbox-key',
    label: 'E*TRADE sandbox consumer key',
    purpose:
      'Proves the OAuth connection works against synthetic data. Instant and ' +
      'self-service. Sandbox returns canned figures that do NOT match what you ' +
      'ask for, so never read a real number from it.',
    requirement: 'optional',
    setupSteps: [
      'You need an E*TRADE account to get either key. It does NOT have to be ' +
        'funded — funding is only required to place trades. Open one at ' +
        'https://us.etrade.com if you have none.',
      'SANDBOX KEY (start here — instant, self-service, safe). Log in at ' +
        'https://us.etrade.com, then go to https://us.etrade.com/etx/ris/apikey ' +
        'and the generator shows a consumer key and secret on the page ' +
        'immediately. Sandbox returns canned data that does NOT match what you ' +
        'ask for — request GOOG and you may get AAPL — so use it to prove the ' +
        'connection works, never to read real numbers.',
      'PRODUCTION KEY, step 1 of 3: complete the API User Intent Survey at ' +
        'https://us.etrade.com/etx/ris/apisurvey/#/questionnaire',
      'PRODUCTION KEY, step 2 of 3: sign the API Developer Agreement at ' +
        'https://us.etrade.com/etx/ris/apisurvey/#/agreement — the terms are at ' +
        'https://us.etrade.com/l/f/agreement-library/api-developer-licensing-agreement',
      'PRODUCTION KEY, step 3 of 3: complete the annual market-data Attestation ' +
        'at https://us.etrade.com/etx/ris/apisurvey/#/attestation . This one ' +
        'recurs every year; letting it lapse costs you market-data access.',
      'An INDIVIDUAL production key is displayed on screen the moment those ' +
        'three are done — no email, no PDF, no phone call, no review. A VENDOR ' +
        'key (multi-user or redistributed) is issued Inactive and E*TRADE will ' +
        'email you to schedule a short demo with Product and Legal first.',
      'Also sign the Market Data Agreement inside your brokerage account, or ' +
        'quote data is refused.',
      'An individual key is locked to the user ID that created it. Using it ' +
        'under a different login fails with a deliberately vague error and no ' +
        'authorization screen. It does work across every account under your own ' +
        'login.',
      'Set ETRADE_ENV to "sandbox" or "production" to choose which pair is ' +
        'used. You can hold both at once: the server reads ' +
        'ETRADE_SANDBOX_CONSUMER_KEY / ETRADE_PROD_CONSUMER_KEY (and the ' +
        'matching _SECRET) before the unscoped names, so switching is one ' +
        'variable. The two pairs are NOT interchangeable — a sandbox token is ' +
        'rejected by production even if sent to the right host.',
      'Finally, run the `etrade_connect` tool. It returns a URL to open, ' +
        'E*TRADE shows you a short verifier code, and you paste that back. No ' +
        'browser redirect is involved, so nothing needs to listen on a port. ' +
        'The request token expires 5 minutes after issue, so do not wander off ' +
        'mid-flow.',
      'Token lifecycle, so nothing surprises you: the access token idles out ' +
        'after 2 hours (the server renews automatically inside that window) and ' +
        'dies at midnight US Eastern, which nothing can renew past. After ' +
        'midnight, run `etrade_connect` again.'
    ],
    signupUrl: 'https://us.etrade.com/etx/ris/apikey'
  },
  {
    envVar: 'ETRADE_SANDBOX_CONSUMER_SECRET',
    group: 'etrade',
    id: 'etrade-sandbox-secret',
    label: 'E*TRADE sandbox consumer secret',
    purpose: 'Issued on the same page as the sandbox key.',
    requirement: 'optional',
    signupUrl: 'https://us.etrade.com/etx/ris/apikey'
  },
  {
    envVar: 'ETRADE_PROD_CONSUMER_KEY',
    group: 'etrade',
    id: 'etrade-prod-key',
    label: 'E*TRADE production consumer key',
    purpose:
      'Reads real holdings, balances and transactions from your E*TRADE ' +
      'account so a rebalance can be planned against the actual book. ' +
      'Read-only — this server never places an order. Not interchangeable with ' +
      'the sandbox key; both can be stored at once and switched with the ' +
      '`etrade_environment` tool.',
    rateLimit: '~2 requests/second and 7,000/hour on the accounts module',
    requirement: 'optional',
    setupSteps: [
      'Three forms on us.etrade.com, in order, while logged in.',
      'Step 1 — API User Intent Survey: https://us.etrade.com/etx/ris/apisurvey/#/questionnaire',
      'Step 2 — API Developer Agreement: https://us.etrade.com/etx/ris/apisurvey/#/agreement',
      'Step 3 — annual market-data Attestation: https://us.etrade.com/etx/ris/apisurvey/#/attestation . ' +
        'This one recurs yearly; letting it lapse costs market-data access.',
      'An INDIVIDUAL key is then displayed on screen immediately — no email, no ' +
        'PDF, no phone call, no review. A VENDOR key (multi-user or ' +
        'redistributed) is issued Inactive and E*TRADE emails you to schedule a ' +
        'short demo with Product and Legal first.',
      'Your E*TRADE account does NOT need to be funded to get a key; funding is ' +
        'only required to place trades. An individual key is locked to the user ' +
        'ID that created it, and works across every account under that login.',
      'Also sign the Market Data Agreement inside the brokerage account, or ' +
        'quote data is refused.'
    ],
    signupUrl: 'https://developer.etrade.com/getting-started'
  },
  {
    envVar: 'ETRADE_PROD_CONSUMER_SECRET',
    group: 'etrade',
    id: 'etrade-prod-secret',
    label: 'E*TRADE production consumer secret',
    purpose: 'Issued on the same screen as the production key.',
    requirement: 'optional',
    signupUrl: 'https://developer.etrade.com/getting-started'
  },
  {
    envVar: 'EDINET_API_KEY',
    id: 'edinet',
    label: 'EDINET (Japan FSA)',
    purpose:
      "Japanese regulatory filings — the FSA's equivalent of SEC EDGAR, with " +
      'XBRL accounts since 2008. This is the one that matters for the method: ' +
      'net-nets have been far scarcer in the US than in Japan for a decade, so ' +
      'a Graham screen without it is looking in the wrong market. Free, and ' +
      'issued instantly.',
    rateLimit: 'No published cap; treated as 2 requests/second here',
    requirement: 'optional',
    setupSteps: [
      'Create an EDINET account at ' +
        'https://api.edinet-fsa.go.jp/api/auth/index.aspx?mode=1 and confirm the ' +
        'link emailed to you. This is a Microsoft identity login.',
      'THEN GO STRAIGHT TO THE KEY PAGE: ' +
        'https://api.edinet-fsa.go.jp/WEEE0090.aspx — this is the ' +
        '「ＡＰＩキー発行画面」(API key issuance screen), and it is a different ' +
        'page from the account page above.',
      'Why that matters: after logging in you land back on the account page, ' +
        'which renders BLANK. It is not broken. Its only job is to call a ' +
        'window.open() popup pointing at WEEE0090.aspx, so any popup blocker ' +
        'leaves you staring at an empty page with no error. Brave blocks it ' +
        'even with Shields disabled, because popup permission is a separate ' +
        'setting. Navigating to WEEE0090.aspx directly sidesteps the popup ' +
        'entirely.',
      'If the key page itself is blank too, the site is a 2008-era ASP.NET ' +
        'WebForms app and privacy browsers break its postbacks. Use Safari or ' +
        'Chrome for this one-time step.',
      'Ignore the browser console warning about an unrecognized ' +
        'Content-Security-Policy directive. It refers to a deprecated ' +
        'directive and is unrelated to the blank page.',
      'Copy the issued key into EDINET_API_KEY.'
    ],
    signupUrl: 'https://api.edinet-fsa.go.jp/WEEE0090.aspx'
  },
  {
    envVar: 'FRED_API_KEY',
    id: 'fred',
    label: 'FRED (St. Louis Fed)',
    purpose:
      "Moody's Aaa corporate bond yield, which sets Graham's earnings-yield " +
      'hurdle, plus CPI for real-return adjustment and the 10-year Treasury. ' +
      'Without it `macro_context` cannot run; nothing else is affected.',
    rateLimit: '120 requests/minute, no daily cap',
    requirement: 'optional',
    setupSteps: [
      'Create a free FRED account at https://fredaccount.stlouisfed.org/login/secure/',
      'Go to https://fredaccount.stlouisfed.org/apikeys and click "Request API Key".',
      'State any brief purpose — the key is issued immediately, with no review.'
    ],
    signupUrl: 'https://fredaccount.stlouisfed.org/apikeys'
  }
];

export function providerById(id: string): ProviderSpec | undefined {
  return PROVIDERS.find(spec => spec.id === id);
}
