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
    envVar: 'ETRADE_CONSUMER_KEY',
    id: 'etrade-key',
    label: 'E*TRADE consumer key',
    purpose:
      'Reads real holdings and cash from an E*TRADE brokerage account so a ' +
      'rebalance can be planned against the actual book. Read-only — this ' +
      'server never places an order. Sandbox and production issue separate ' +
      'keys and they are not interchangeable; set ETRADE_ENV to pick one. ' +
      'Environment-scoped names (ETRADE_SANDBOX_CONSUMER_KEY, ' +
      'ETRADE_PROD_CONSUMER_KEY) are read first, so both pairs can be held at ' +
      'once and switched with ETRADE_ENV alone.',
    rateLimit: '~2 requests/second and 7,000/hour on the accounts module',
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
    signupUrl: 'https://developer.etrade.com/getting-started'
  },
  {
    envVar: 'ETRADE_CONSUMER_SECRET',
    id: 'etrade-secret',
    label: 'E*TRADE consumer secret',
    purpose:
      'Signs every E*TRADE request. Issued on the same screen as the consumer ' +
      'key — see the walkthrough under that entry.',
    requirement: 'optional',
    signupUrl: 'https://developer.etrade.com/getting-started'
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
