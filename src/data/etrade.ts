import { sortBy } from 'lodash-es';
import { createHmac, randomBytes } from 'node:crypto';

import { cached } from '../cache/store.ts';
import { getCredential, saveCredentials } from '../config/store.ts';
import { fetchJson } from '../http/client.ts';
import { dec, sum, ZERO } from '../math/decimal.ts';

import type { Decimal } from '../math/decimal.ts';

/**
 * E*TRADE, over OAuth 1.0a with HMAC-SHA1. There is no OAuth 2 path and no
 * refresh token: the whole flow is request token → the user authorises in a
 * browser and is shown a five-character verifier → access token. The verifier
 * is typed back in, because E*TRADE's `oob` callback deliberately has nowhere
 * to redirect to. That suits an MCP server, which has no HTTP listener to
 * receive a callback on.
 *
 * Two expiries, and they are not the same thing. An access token is
 * inactivated after two hours with no requests against it — `renewAccessToken`
 * revives that one. Every token also dies at midnight US Eastern regardless of
 * activity, and no renewal survives it; the user must authorise again.
 *
 * Signing is done here with `node:crypto` rather than an OAuth library: the
 * whole of OAuth 1.0a that E*TRADE uses is one HMAC over a sorted parameter
 * string, and a dependency for that is not worth its supply chain.
 */

/** Sandbox and production issue separate consumer keys; they are not interchangeable. */
export type EtradeEnvironment = 'production' | 'sandbox';

export interface EtradeAccount {
  readonly accountDesc: string;
  readonly accountId: string;
  /** The opaque key every other endpoint is addressed by — not `accountId`. */
  readonly accountIdKey: string;
  readonly accountMode: string;
  readonly accountName: string;
  readonly accountStatus: string;
  readonly accountType: string;
  readonly institutionType: string;
}

interface EtradeBalance {
  /** Total equity plus cash, per E*TRADE's real-time valuation. */
  readonly accountBalance: Decimal | undefined;
  readonly accountDescription: string | undefined;
  readonly accountIdKey: string;
  readonly accountType: string | undefined;
  /** ISO date the figures are as of, from E*TRADE's own `asOfDate`. */
  readonly asOf: string;
  /** Cash available to deploy: settled and unencumbered. Not total cash. */
  readonly cash: Decimal;
  readonly cashBalance: Decimal | undefined;
  readonly cashBuyingPower: Decimal | undefined;
  readonly cashForWithdrawal: Decimal | undefined;
  readonly marginBalance: Decimal | undefined;
  readonly marginBuyingPower: Decimal | undefined;
  readonly netCash: Decimal | undefined;
  /** Market value of long positions. */
  readonly netMarketValue: Decimal | undefined;
  /** Unmet margin calls, if any. Non-zero here outranks every other figure. */
  readonly openCalls: Decimal | undefined;
  readonly settledCash: Decimal | undefined;
  readonly totalValue: Decimal | undefined;
  readonly unsettledCash: Decimal | undefined;
}

export interface EtradeTransaction {
  readonly amount: Decimal | undefined;
  readonly description: string;
  readonly fee: Decimal | undefined;
  readonly postDate: string | undefined;
  readonly price: Decimal | undefined;
  readonly quantity: Decimal | undefined;
  readonly symbol: string | undefined;
  readonly transactionDate: string;
  readonly transactionId: string;
  readonly transactionType: string;
}

export interface EtradePortfolio {
  readonly accountIdKey: string;
  readonly asOf: string;
  readonly cash: Decimal;
  readonly positions: readonly EtradePosition[];
  readonly totalValue: Decimal | undefined;
}

/** Convertible to `Holding` by dropping everything but asOf/price/shares/ticker. */
interface EtradePosition {
  readonly asOf: string;
  readonly daysGain: Decimal | undefined;
  readonly marketValue: Decimal | undefined;
  readonly pctOfPortfolio: Decimal | undefined;
  readonly price: Decimal;
  readonly pricePaid: Decimal | undefined;
  readonly shares: Decimal;
  readonly ticker: string;
  readonly totalCost: Decimal | undefined;
  readonly totalGain: Decimal | undefined;
  readonly totalGainPct: Decimal | undefined;
}

/**
 * Credential names.
 *
 * Everything except the environment selector is stored twice, once per
 * environment. E*TRADE's two key pairs are not interchangeable and neither are
 * the access tokens minted from them — a sandbox token is rejected by
 * production even when sent to the right host. Sharing one slot between them
 * means a toggle silently signs production requests with sandbox material,
 * which fails in a way that reads like a bad key rather than a wrong mode.
 *
 * The unscoped names are still read as a fallback, so an existing single-pair
 * setup keeps working.
 */
const ENV_ENVIRONMENT = 'ETRADE_ENVIRONMENT';
const ENV_ENVIRONMENT_ALIAS = 'ETRADE_ENV';

const UNSCOPED = {
  accessSecret: 'ETRADE_ACCESS_TOKEN_SECRET',
  accessToken: 'ETRADE_ACCESS_TOKEN',
  consumerKey: 'ETRADE_CONSUMER_KEY',
  consumerSecret: 'ETRADE_CONSUMER_SECRET',
  requestSecret: 'ETRADE_REQUEST_TOKEN_SECRET',
  requestToken: 'ETRADE_REQUEST_TOKEN'
} as const;

const SUFFIX = {
  accessSecret: 'ACCESS_TOKEN_SECRET',
  accessToken: 'ACCESS_TOKEN',
  consumerKey: 'CONSUMER_KEY',
  consumerSecret: 'CONSUMER_SECRET',
  requestSecret: 'REQUEST_TOKEN_SECRET',
  requestToken: 'REQUEST_TOKEN'
} as const;

type CredentialSlot = keyof typeof SUFFIX;

/** The environment-scoped variable name for a slot, e.g. ETRADE_PROD_ACCESS_TOKEN. */
export function scopedName(
  slot: CredentialSlot,
  env: EtradeEnvironment = environment()
): string {
  return `ETRADE_${env === 'sandbox' ? 'SANDBOX' : 'PROD'}_${SUFFIX[slot]}`;
}

/** Scoped value if present, else the unscoped fallback. */
function slotValue(
  slot: CredentialSlot,
  env: EtradeEnvironment = environment()
): string | undefined {
  return getCredential(scopedName(slot, env)) ?? getCredential(UNSCOPED[slot]);
}

/**
 * Writes a slot under its scoped name. Tokens minted in one environment must
 * never leak into the other, so writes are always scoped even when the value
 * that produced them was read from an unscoped fallback.
 */
function writeSlot(values: Partial<Record<CredentialSlot, string>>): void {
  const payload: Record<string, string> = {};
  for (const [slot, value] of Object.entries(values)) {
    payload[scopedName(slot as CredentialSlot)] = value;
  }
  saveCredentials(payload);
}

/**
 * Balances and positions are marks, not filings: five minutes is long enough to
 * spare the API a second call inside one conversation and short enough that
 * nothing quoted here is stale in a way a user would notice. The account list
 * is cached at the same TTL because it costs nothing to refetch.
 */
const TTL_BROKER = 5 * 60;

const AUTHORIZE_URL = 'https://us.etrade.com/e/t/etws/authorize';
const RATE_KEY = 'api.etrade.com';
const REQUESTS_PER_SECOND = 2;

/**
 * Ninety minutes, inside the two-hour idle window with room for one missed
 * tick — a laptop that slept through a tick still wakes up inside the window.
 */
const KEEPALIVE_INTERVAL_MS = 90 * 60 * 1000;

/**
 * Two failures, not one. A single failed renewal is as likely to be a dropped
 * connection as a dead token, and giving up on the first one would leave a
 * perfectly good session to idle out.
 */
const KEEPALIVE_MAX_FAILURES = 2;

/** Consecutive keep-alive renewal failures; reset by any successful contact. */
let failures = 0;
let keepAlive: NodeJS.Timeout | undefined;
/** Epoch ms of the last request E*TRADE actually answered. */
let lastContact = 0;

function touch(): void {
  failures = 0;
  lastContact = Date.now();
}

interface OAuthIdentity {
  /** Only the request-token call sends one, and E*TRADE only accepts `oob`. */
  readonly callback?: string;
  readonly consumerKey: string;
  readonly consumerSecret: string;
  readonly token?: string;
  readonly tokenSecret?: string;
  readonly verifier?: string;
}

interface TokenPair {
  readonly secret: string;
  readonly token: string;
}

/**
 * RFC 3986 percent-encoding. `encodeURIComponent` leaves `!'()*` alone and
 * OAuth's signature base string does not, so an unescaped apostrophe in a
 * parameter silently produces a signature the server rejects as invalid.
 */
function percentEncode(value: string): string {
  return encodeURIComponent(value).replaceAll(
    /[!'()*]/g,
    character => `%${character.codePointAt(0)?.toString(16).toUpperCase()}`
  );
}

function signature(
  method: string,
  url: string,
  parameters: Readonly<Record<string, string>>,
  consumerSecret: string,
  tokenSecret: string
): string {
  const encoded = Object.entries(parameters).map(
    ([key, value]) => [percentEncode(key), percentEncode(value)] as const
  );
  const normalised = sortBy(encoded, [([key]) => key, ([, value]) => value])
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  const base = `${method}&${percentEncode(url)}&${percentEncode(normalised)}`;
  const key = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  return createHmac('sha1', key).update(base).digest('base64');
}

/**
 * Builds the `Authorization: OAuth …` header. Query parameters are signed but
 * never appear in the header — `realTimeNAV=true` on the balance endpoint is
 * part of the base string, and omitting it is the classic cause of a 401 that
 * looks like a bad key.
 */
function authorization(
  method: string,
  url: string,
  queryParameters: Readonly<Record<string, string>>,
  identity: OAuthIdentity
): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: identity.consumerKey,
    oauth_nonce: randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_version: '1.0'
  };
  if (identity.callback) oauth.oauth_callback = identity.callback;
  if (identity.token) oauth.oauth_token = identity.token;
  if (identity.verifier) oauth.oauth_verifier = identity.verifier;

  oauth.oauth_signature = signature(
    method,
    url,
    { ...oauth, ...queryParameters },
    identity.consumerSecret,
    identity.tokenSecret ?? ''
  );

  return `OAuth ${sortBy(Object.entries(oauth), ([key]) => key)
    .map(([key, value]) => `${percentEncode(key)}="${percentEncode(value)}"`)
    .join(', ')}`;
}

/**
 * The four `/oauth/*` endpoints answer `text/plain` form-encoded bodies, so
 * they cannot go through `fetchJson`. Everything else in this module does.
 * Nothing secret rides in these URLs — the credentials are all in the header —
 * so an error that names the URL leaks nothing.
 */
async function oauthRequest(
  url: string,
  identity: OAuthIdentity
): Promise<string> {
  const response = await fetch(url, {
    headers: {
      accept: 'application/x-www-form-urlencoded',
      authorization: authorization('GET', url, {}, identity)
    },
    method: 'GET'
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `E*TRADE returned HTTP ${response.status} from ${url}. ` +
        `${describeOauthFailure(response.status)} Response: ${body.slice(0, 300)}`
    );
  }
  return body;
}

function describeOauthFailure(status: number): string {
  if (status === 401) {
    return (
      'The consumer key/secret pair is wrong for this environment, the ' +
      'system clock is off by more than five minutes, or the token has expired ' +
      '(E*TRADE tokens die at midnight US Eastern).'
    );
  }
  if (status === 403)
    return 'The consumer key is not approved for this environment.';
  return '';
}

function parseTokenPair(body: string): TokenPair {
  const parameters = new URLSearchParams(body);
  const token = parameters.get('oauth_token');
  const secret = parameters.get('oauth_token_secret');
  if (!token || !secret) {
    throw new Error(
      `E*TRADE did not return a token pair. Body was: ${body.slice(0, 200)}`
    );
  }
  return { secret, token };
}

export function environment(): EtradeEnvironment {
  // `ETRADE_ENV` is accepted as an alias because it is the shorter name people
  // reach for in a shell rc, and getting this wrong silently signs production
  // requests with a sandbox key.
  const raw = (
    getCredential(ENV_ENVIRONMENT) ?? getCredential(ENV_ENVIRONMENT_ALIAS)
  )
    ?.trim()
    .toLowerCase();
  return raw === 'sandbox' ? 'sandbox' : 'production';
}

/**
 * Switches the active environment and persists the choice.
 *
 * Returns the name of a shell variable that will override the stored value, if
 * one is exported. Environment variables win over the credential file by
 * design, so an `ETRADE_ENV` left in a shell rc makes this call look like it
 * did nothing — the caller needs to be able to say so rather than report a
 * switch that will not survive the next process.
 */
export function setEnvironment(next: EtradeEnvironment): {
  shadowedBy?: string;
} {
  saveCredentials({ [ENV_ENVIRONMENT]: next });

  // Ask whether the switch actually took, rather than guessing which variable
  // might override it. Enumerating candidates got this wrong: once
  // ETRADE_ENVIRONMENT is stored it always satisfies the first lookup, so an
  // exported ETRADE_ENV can never shadow it — yet the old check reported it as
  // the culprit and sent the user chasing a variable with no effect.
  if (environment() === next) return {};

  const culprit = [ENV_ENVIRONMENT, ENV_ENVIRONMENT_ALIAS].find(
    name => process.env[name] !== undefined
  );
  return { shadowedBy: culprit ?? ENV_ENVIRONMENT };
}

/** Which environments have a usable consumer key pair. */
export function configuredEnvironments(): {
  env: EtradeEnvironment;
  hasConsumer: boolean;
  hasToken: boolean;
}[] {
  return (['sandbox', 'production'] as const).map(env => ({
    env,
    hasConsumer:
      slotValue('consumerKey', env) !== undefined &&
      slotValue('consumerSecret', env) !== undefined,
    hasToken:
      slotValue('accessToken', env) !== undefined &&
      slotValue('accessSecret', env) !== undefined
  }));
}

function apiBase(): string {
  return environment() === 'sandbox'
    ? 'https://apisb.etrade.com'
    : 'https://api.etrade.com';
}

function required(envVar: string, label: string): string {
  const value = getCredential(envVar);
  if (!value) {
    throw new Error(
      `${label} is not configured. Run \`setup_credentials\`, or set ${envVar}. ` +
        'Register an application at https://developer.etrade.com'
    );
  }
  return value;
}

/**
 * Resolves the consumer key pair for whichever environment is active.
 *
 * Half a pair is treated as an error rather than falling through to the other
 * environment's key: mixing a sandbox key with a production secret produces a
 * signature failure that looks exactly like a revoked key.
 */
function consumer(): { key: string; secret: string } {
  const key = slotValue('consumerKey');
  const secret = slotValue('consumerSecret');
  if (key && secret) return { key, secret };

  if (key || secret) {
    throw new Error(
      `Only half of the ${environment()} E*TRADE key pair is set. Both ` +
        `${scopedName('consumerKey')} and ${scopedName('consumerSecret')} are needed.`
    );
  }

  throw new Error(
    `No E*TRADE ${environment()} consumer key is configured. Set ` +
      `${scopedName('consumerKey')} and ${scopedName('consumerSecret')}, or run ` +
      '`setup_credentials`. Use `etrade_environment` to switch environments. ' +
      'Keys: https://developer.etrade.com/getting-started'
  );
}

/** Whether an access token is on hand. Says nothing about whether it still works. */
export function hasAccessToken(): boolean {
  return (
    slotValue('accessToken') !== undefined &&
    slotValue('accessSecret') !== undefined
  );
}

/** Consumer credentials present, whichever naming the operator used. */
export function hasConsumerCredentials(): boolean {
  try {
    consumer();
    return true;
  } catch {
    return false;
  }
}

function accessIdentity(): OAuthIdentity {
  const { key, secret } = consumer();
  return {
    consumerKey: key,
    consumerSecret: secret,
    token: required(scopedName('accessToken'), 'E*TRADE access token'),
    tokenSecret: required(
      scopedName('accessSecret'),
      'E*TRADE access token secret'
    )
  };
}

/**
 * Step one. Returns the URL the user opens; E*TRADE shows them a verifier code
 * there rather than redirecting anywhere. The request token and its secret are
 * persisted so the second half of the flow survives a server restart between
 * the two tool calls — they are short-lived and useless without the consumer
 * secret, but they still go into the same 0600 file as everything else.
 *
 * The request token itself expires five minutes after issue, so a user who
 * wanders off mid-flow has to start again rather than reuse the URL.
 */
export async function startAuthorization(): Promise<string> {
  const { key, secret } = consumer();
  const body = await oauthRequest(`${apiBase()}/oauth/request_token`, {
    callback: 'oob',
    consumerKey: key,
    consumerSecret: secret
  });

  const pair = parseTokenPair(body);
  writeSlot({ requestSecret: pair.secret, requestToken: pair.token });

  // E*TRADE's authorize page wants the raw consumer key and a percent-encoded
  // token; a token passed through unencoded breaks on its `+` characters.
  return `${AUTHORIZE_URL}?key=${percentEncode(key)}&token=${percentEncode(pair.token)}`;
}

/**
 * Step two. Exchanges the verifier for an access token and stores it, then
 * drops the request token — it is spent, and keeping a dead secret around is
 * only a liability.
 */
export async function completeAuthorization(verifier: string): Promise<void> {
  const { key, secret } = consumer();
  const requestToken = slotValue('requestToken');
  const requestSecret = slotValue('requestSecret');
  if (!requestToken || !requestSecret) {
    throw new Error(
      'No pending E*TRADE authorization. Call `etrade_connect` with no verifier ' +
        'first to get an authorization URL.'
    );
  }

  const body = await oauthRequest(`${apiBase()}/oauth/access_token`, {
    consumerKey: key,
    consumerSecret: secret,
    token: requestToken,
    tokenSecret: requestSecret,
    verifier: verifier.trim()
  });

  const pair = parseTokenPair(body);
  writeSlot({
    accessSecret: pair.secret,
    accessToken: pair.token,
    requestSecret: '',
    requestToken: ''
  });
  touch();
  startKeepAlive();
}

/**
 * Revives a token that has idled out. Returns false rather than throwing when
 * renewal fails, because the only sensible response is to authorise again and
 * the caller should say so rather than surface a 401.
 */
async function renewAccessToken(): Promise<boolean> {
  if (!hasAccessToken()) return false;
  try {
    await oauthRequest(
      `${apiBase()}/oauth/renew_access_token`,
      accessIdentity()
    );
    touch();
    return true;
  } catch {
    failures += 1;
    if (failures >= KEEPALIVE_MAX_FAILURES) stopKeepAlive();
    return false;
  }
}

/**
 * Renews only when the connection has gone quiet long enough to be at risk.
 * Called before each read so a session that has been idle for an hour and a
 * half does not spend its first tool call on a 401.
 */
export async function renewIfStale(): Promise<boolean> {
  if (!hasAccessToken()) return false;
  if (Date.now() - lastContact < KEEPALIVE_INTERVAL_MS) return true;
  return renewAccessToken();
}

/**
 * Holds the token open across a long conversation.
 *
 * E*TRADE inactivates an access token after two hours with no requests, which
 * is well inside the length of a session where someone screens in the morning
 * and rebalances after lunch. A timer that renews every ninety minutes costs
 * one request an hour and removes the most common reason a user is sent back
 * through the browser.
 *
 * It cannot beat the midnight US Eastern expiry — nothing can, there is no
 * refresh token — so the timer gives up after consecutive failures rather than
 * hammering a token that is simply dead.
 */
function startKeepAlive(): void {
  if (keepAlive || !hasAccessToken()) return;
  failures = 0;
  keepAlive = setInterval(() => void renewAccessToken(), KEEPALIVE_INTERVAL_MS);
  // An MCP server exits when its client disconnects; a live timer must not be
  // the thing that keeps the process alive after that.
  keepAlive.unref();
}

function stopKeepAlive(): void {
  if (!keepAlive) return;
  clearInterval(keepAlive);
  keepAlive = undefined;
}

export async function revokeAccessToken(): Promise<boolean> {
  if (!hasAccessToken()) return false;
  await oauthRequest(
    `${apiBase()}/oauth/revoke_access_token`,
    accessIdentity()
  );
  stopKeepAlive();
  writeSlot({ accessSecret: '', accessToken: '' });
  // The unscoped fallbacks would otherwise resurrect a token the user just
  // revoked, since slotValue reads them when the scoped slot is empty.
  saveCredentials({ [UNSCOPED.accessSecret]: '', [UNSCOPED.accessToken]: '' });
  return true;
}

/** A signed GET through the shared HTTP path, cached under the environment. */
async function get<T>(
  namespace: string,
  path: string,
  searchParams: Readonly<Record<string, string>> = {}
): Promise<T> {
  const url = `${apiBase()}${path}`;
  const identity = accessIdentity();
  startKeepAlive();
  const key = `${environment()}${path}?${new URLSearchParams(searchParams).toString()}`;
  return cached(namespace, key, TTL_BROKER, async () => {
    const payload = await fetchJson<T>(url, {
      headers: {
        authorization: authorization('GET', url, searchParams, identity)
      },
      rateKey: RATE_KEY,
      requestsPerSecond: REQUESTS_PER_SECOND,
      // E*TRADE intermittently answers a valid, correctly-signed request with
      // HTTP 404 and a Tomcat error page. Observed directly: the same balance
      // URL 404s once and then returns 200 four times in a row. A 404 normally
      // means "no such thing" and must not be retried, so this is opted into
      // here rather than loosened for every host.
      retryStatuses: [404, 408, 425, 429, 500, 502, 503, 504],
      searchParams
    });
    touch();
    return payload;
  });
}

interface AccountListResponse {
  AccountListResponse?: {
    Accounts?: {
      Account?: RawAccount | RawAccount[];
    };
  };
}

type Num = number | string | undefined;

interface RawComputed {
  accountBalance?: Num;
  cashAvailableForInvestment?: Num;
  cashAvailableForWithdrawal?: Num;
  cashBalance?: Num;
  cashBuyingPower?: Num;
  marginBalance?: Num;
  marginBuyingPower?: Num;
  netCash?: Num;
  OpenCalls?: {
    cashCall?: Num;
    fedCall?: Num;
    houseCall?: Num;
    minEquityCall?: Num;
  };
  openCalls?: RawComputed['OpenCalls'];
  RealTimeValues?: { netMvLong?: Num; totalAccountValue?: Num };
  realTimeValues?: { netMvLong?: Num; totalAccountValue?: Num };
  settledCashForInvestment?: Num;
  unSettledCashForInvestment?: Num;
}

interface BalanceResponse {
  BalanceResponse?: {
    accountDescription?: string;
    accountType?: string;
    asOfDate?: number;
    // E*TRADE returns the computed block as `Computed`; the schema calls it
    // `computedBalance`. Accept both rather than depend on which one ships.
    Computed?: RawComputed;
    computedBalance?: RawComputed;
  };
}

interface RawTransaction {
  amount?: Num;
  brokerage?: RawBrokerage;
  Brokerage?: RawBrokerage;
  description?: string;
  postDate?: number | string;
  transactionDate?: number | string;
  transactionId?: number | string;
  transactionType?: string;
}

interface RawBrokerage {
  displaySymbol?: string;
  fee?: Num;
  price?: Num;
  product?: { symbol?: string };
  Product?: { symbol?: string };
  quantity?: Num;
  settlementDate?: number | string;
}

interface TransactionListResponse {
  TransactionListResponse?: {
    moreTransactions?: boolean;
    totalCount?: number;
    Transaction?: RawTransaction | RawTransaction[];
  };
}

interface PortfolioResponse {
  PortfolioResponse?: {
    AccountPortfolio?: RawAccountPortfolio | RawAccountPortfolio[];
  };
}

interface RawAccount {
  accountDesc?: string;
  accountId?: string;
  accountIdKey?: string;
  /**
   * "IRA" or "CASH". The only field that reliably distinguishes retirement
   * money when `accountType` returns a settlement mode instead of a
   * registration — see `etradeTaxTreatment`.
   */
  accountMode?: string;
  accountName?: string;
  accountStatus?: string;
  accountType?: string;
  institutionType?: string;
}

interface RawAccountPortfolio {
  Position?: RawPosition | RawPosition[];
}

interface RawPosition {
  daysGain?: Num;
  marketValue?: Num;
  pctOfPortfolio?: Num;
  pricePaid?: Num;
  Product?: { securityType?: string; symbol?: string };
  quantity?: Num;
  Quick?: { lastTrade?: Num; lastTradeTime?: number };
  totalCost?: Num;
  totalGain?: Num;
  totalGainPct?: Num;
}

/** E*TRADE collapses one-element arrays into the object itself. */
function list<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * E*TRADE stamps times as epoch seconds on some endpoints and milliseconds on
 * others, with no flag distinguishing them. Anything past the year 2001 in
 * seconds is beyond plausible as a *second* count for a market timestamp, so
 * the magnitude is the discriminator. A value that is neither is not a usable
 * date, and today() is the honest fallback.
 */
const EPOCH_MS_THRESHOLD = 1e11;

function markDate(value: number | string | undefined): string {
  const numeric = typeof value === 'string' ? Number(value) : value;
  if (
    typeof numeric !== 'number' ||
    !Number.isFinite(numeric) ||
    numeric <= 0
  ) {
    return today();
  }
  const ms = numeric > EPOCH_MS_THRESHOLD ? numeric : numeric * 1000;
  return new Date(ms).toISOString().slice(0, 10);
}

export async function listAccounts(): Promise<EtradeAccount[]> {
  const data = await get<AccountListResponse>(
    'etrade-accounts',
    '/v1/accounts/list.json'
  );

  return list(data.AccountListResponse?.Accounts?.Account).map(account => ({
    accountDesc: account.accountDesc ?? '',
    accountId: account.accountId ?? '',
    accountIdKey: account.accountIdKey ?? '',
    accountMode: account.accountMode ?? '',
    accountName: account.accountName ?? '',
    accountStatus: account.accountStatus ?? '',
    accountType: account.accountType ?? '',
    institutionType: account.institutionType ?? ''
  }));
}

export async function accountBalance(
  accountIdKey: string
): Promise<EtradeBalance> {
  const data = await get<BalanceResponse>(
    'etrade-balance',
    `/v1/accounts/${encodeURIComponent(accountIdKey)}/balance.json`,
    { instType: 'BROKERAGE', realTimeNAV: 'true' }
  );

  const body = data.BalanceResponse;
  const computed = body?.Computed ?? body?.computedBalance;
  const realTime = computed?.RealTimeValues ?? computed?.realTimeValues;
  const calls = computed?.OpenCalls ?? computed?.openCalls;

  // Any unmet call outranks every other figure on the page, so collapse the
  // four kinds into one number the caller cannot miss.
  const openCalls = sum(
    dec(calls?.cashCall),
    dec(calls?.fedCall),
    dec(calls?.houseCall),
    dec(calls?.minEquityCall)
  );

  return {
    accountBalance: dec(computed?.accountBalance),
    accountDescription: body?.accountDescription,
    accountIdKey,
    accountType: body?.accountType,
    // E*TRADE stamps its own `asOfDate` (epoch seconds). Falling back to today
    // would claim a freshness the response never promised.
    asOf: body?.asOfDate ? markDate(body.asOfDate) : today(),
    cash: dec(computed?.cashAvailableForInvestment) ?? ZERO,
    cashBalance: dec(computed?.cashBalance),
    cashBuyingPower: dec(computed?.cashBuyingPower),
    cashForWithdrawal: dec(computed?.cashAvailableForWithdrawal),
    marginBalance: dec(computed?.marginBalance),
    marginBuyingPower: dec(computed?.marginBuyingPower),
    netCash: dec(computed?.netCash),
    netMarketValue: dec(realTime?.netMvLong),
    openCalls,
    settledCash: dec(computed?.settledCashForInvestment),
    totalValue: dec(realTime?.totalAccountValue),
    unsettledCash: dec(computed?.unSettledCashForInvestment)
  };
}

/** MMDDYYYY is the only date format the transactions endpoint accepts. */
function asEtradeDate(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const [year, month, day] = iso.split('-');
  return year && month && day ? `${month}${day}${year}` : undefined;
}

/**
 * Transactions for one account. E*TRADE keeps two years and pages at 50.
 *
 * Dates go out as MMDDYYYY, which is the only format the endpoint accepts, and
 * come back as epoch seconds. Both conversions live here so no caller has to
 * think about it.
 */
export async function listTransactions(
  accountIdKey: string,
  {
    count = 50,
    endDate,
    startDate
  }: { count?: number; endDate?: string; startDate?: string } = {}
): Promise<{ more: boolean; transactions: EtradeTransaction[] }> {
  const params: Record<string, string> = { count: String(count) };
  const from = asEtradeDate(startDate);
  const to = asEtradeDate(endDate);
  if (from) params['startDate'] = from;
  if (to) params['endDate'] = to;

  let data: TransactionListResponse;
  try {
    data = await get<TransactionListResponse>(
      'etrade-transactions',
      `/v1/accounts/${encodeURIComponent(accountIdKey)}/transactions.json`,
      params
    );
  } catch (error) {
    // No transactions in the window answers 204 with no body.
    if (!(error instanceof SyntaxError)) throw error;
    data = {};
  }

  const body = data.TransactionListResponse;
  const transactions = list(body?.Transaction).map(raw => {
    const brokerage = raw.Brokerage ?? raw.brokerage;
    return {
      amount: dec(raw.amount),
      description: raw.description?.trim() ?? '',
      fee: dec(brokerage?.fee),
      postDate: raw.postDate ? markDate(raw.postDate) : undefined,
      price: dec(brokerage?.price),
      quantity: dec(brokerage?.quantity),
      symbol:
        brokerage?.displaySymbol?.trim() ??
        (brokerage?.Product ?? brokerage?.product)?.symbol?.trim(),
      transactionDate: raw.transactionDate ? markDate(raw.transactionDate) : '',
      transactionId: String(raw.transactionId ?? ''),
      transactionType: raw.transactionType?.trim() ?? ''
    };
  });

  return {
    more: body?.moreTransactions === true,
    transactions: sortBy(
      transactions,
      item => item.transactionDate
    ).toReversed()
  };
}

/**
 * Positions plus the cash that funds them, because a rebalance needs both and
 * they come from two endpoints. A position with no symbol or no mark is
 * dropped: it cannot be sized against, and carrying it through as a zero would
 * quietly understate the portfolio.
 */
export async function portfolioPositions(
  accountIdKey: string
): Promise<EtradePortfolio> {
  const balance = await accountBalance(accountIdKey);

  let data: PortfolioResponse;
  try {
    data = await get<PortfolioResponse>(
      'etrade-portfolio',
      `/v1/accounts/${encodeURIComponent(accountIdKey)}/portfolio.json`
    );
  } catch (error) {
    // An empty portfolio answers 204 with no body, which the shared JSON client
    // has no representation for. Any other failure is a real one.
    if (!(error instanceof SyntaxError)) throw error;
    data = {};
  }

  const raw = list(data.PortfolioResponse?.AccountPortfolio).flatMap(
    portfolio => list(portfolio.Position)
  );

  const positions = raw.flatMap<EtradePosition>(position => {
    const ticker = position.Product?.symbol?.trim().toUpperCase();
    const price = dec(position.Quick?.lastTrade);
    const shares = dec(position.quantity);
    if (!ticker || !price || price.lte(ZERO) || !shares) return [];
    return [
      {
        asOf: markDate(position.Quick?.lastTradeTime),
        daysGain: dec(position.daysGain),
        marketValue: dec(position.marketValue),
        pctOfPortfolio: dec(position.pctOfPortfolio),
        price,
        pricePaid: dec(position.pricePaid),
        shares,
        ticker,
        totalCost: dec(position.totalCost),
        totalGain: dec(position.totalGain),
        totalGainPct: dec(position.totalGainPct)
      }
    ];
  });

  return {
    accountIdKey,
    asOf: balance.asOf,
    cash: balance.cash,
    positions: sortBy(positions, position => position.ticker),
    totalValue: balance.totalValue
  };
}

/* ------------------------------------------------------------------ orders */

/**
 * Order placement.
 *
 * Deliberately not routed through `get`, which caches: an order operation
 * served from cache would be either a phantom fill or a silently repeated
 * trade, and both are worse than an error.
 *
 * E*TRADE's own API is preview-then-place — the preview returns an id that
 * `place` must quote back — which is where the neutral contract's shape came
 * from. The two-step is not this server being cautious on top of the broker;
 * it is the broker's design, generalised to every broker.
 */

export interface EtradeOrderRequest {
  readonly accountIdKey: string;
  readonly clientOrderId: string;
  readonly limitPrice: string;
  readonly quantity: string;
  readonly side: 'buy' | 'sell';
  readonly symbol: string;
}

interface RawEtradeMessage {
  code?: number;
  description?: string;
}

interface RawEtradeOrderDetail {
  estimatedCommission?: Num;
  estimatedTotalAmount?: Num;
  messages?: { Message?: RawEtradeMessage | RawEtradeMessage[] };
  Messages?: { Message?: RawEtradeMessage | RawEtradeMessage[] };
  orderId?: Num;
  orderValue?: Num;
  status?: string;
}

interface PreviewResponse {
  PreviewOrderResponse?: {
    Order?: RawEtradeOrderDetail | RawEtradeOrderDetail[];
    PreviewIds?: { previewId?: Num } | { previewId?: Num }[];
  };
}

interface PlaceResponse {
  PlaceOrderResponse?: {
    Order?: RawEtradeOrderDetail | RawEtradeOrderDetail[];
    OrderIds?: { orderId?: Num } | { orderId?: Num }[];
  };
}

/** The order payload, identical between preview and place by E*TRADE's design. */
function orderPayload(request: EtradeOrderRequest): unknown {
  return [
    {
      allOrNone: 'false',
      Instrument: [
        {
          orderAction: request.side === 'buy' ? 'BUY' : 'SELL',
          Product: { securityType: 'EQ', symbol: request.symbol },
          quantity: request.quantity,
          quantityType: 'QUANTITY'
        }
      ],
      limitPrice: request.limitPrice,
      // Day only and regular session only. An order resting overnight or in
      // an extended session is one nobody is watching.
      marketSession: 'REGULAR',
      orderTerm: 'GOOD_FOR_DAY',
      priceType: 'LIMIT'
    }
  ];
}

/** Signs and sends without caching. Orders are never replayed from a cache. */
async function orderRequest<T>(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown
): Promise<T> {
  const url = `${apiBase()}${path}`;
  const identity = accessIdentity();
  startKeepAlive();

  const payload = await fetchJson<T>(url, {
    body,
    headers: {
      accept: 'application/json',
      authorization: authorization(method, url, {}, identity)
    },
    method,
    rateKey: RATE_KEY,
    requestsPerSecond: REQUESTS_PER_SECOND
  });
  touch();
  return payload;
}

const firstOf = <T>(value: T | T[] | undefined): T | undefined =>
  Array.isArray(value) ? value[0] : value;

function messagesOf(detail: RawEtradeOrderDetail | undefined): string[] {
  const raw = detail?.Messages?.Message ?? detail?.messages?.Message;
  const entries = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];
  return entries
    .map(message => message.description?.trim())
    .filter((text): text is string => text !== undefined && text.length > 0);
}

export interface EtradePreview {
  readonly estimatedCommission: Decimal | undefined;
  readonly estimatedTotal: Decimal | undefined;
  readonly previewId: string;
  readonly warnings: string[];
}

export async function previewOrder(
  request: EtradeOrderRequest
): Promise<EtradePreview> {
  const response = await orderRequest<PreviewResponse>(
    'POST',
    `/v1/accounts/${request.accountIdKey}/orders/preview.json`,
    {
      PreviewOrderRequest: {
        clientOrderId: request.clientOrderId,
        Order: orderPayload(request),
        orderType: 'EQ'
      }
    }
  );

  const detail = firstOf(response.PreviewOrderResponse?.Order);
  const previewId = firstOf(
    response.PreviewOrderResponse?.PreviewIds
  )?.previewId;
  if (previewId === undefined) {
    throw new Error(
      'E*TRADE previewed the order without returning a preview id, so it ' +
        'cannot be placed. Nothing was sent.'
    );
  }

  return {
    estimatedCommission: dec(detail?.estimatedCommission),
    estimatedTotal: dec(detail?.estimatedTotalAmount ?? detail?.orderValue),
    previewId: String(previewId),
    warnings: messagesOf(detail)
  };
}

export async function placeOrder(
  request: EtradeOrderRequest,
  previewId: string
): Promise<{ orderId: string; status: string }> {
  const response = await orderRequest<PlaceResponse>(
    'POST',
    `/v1/accounts/${request.accountIdKey}/orders/place.json`,
    {
      PlaceOrderRequest: {
        clientOrderId: request.clientOrderId,
        Order: orderPayload(request),
        orderType: 'EQ',
        PreviewIds: [{ previewId }]
      }
    }
  );

  const detail = firstOf(response.PlaceOrderResponse?.Order);
  const orderId =
    firstOf(response.PlaceOrderResponse?.OrderIds)?.orderId ?? detail?.orderId;

  if (orderId === undefined) {
    throw new Error(
      'E*TRADE accepted the request without returning an order id. Check ' +
        '`order_list` before retrying — a retry could duplicate a live order.'
    );
  }

  return { orderId: String(orderId), status: detail?.status ?? 'OPEN' };
}

interface OrdersResponse {
  OrdersResponse?: {
    Order?: RawEtradeOrder | RawEtradeOrder[];
  };
}

interface RawEtradeOrder {
  OrderDetail?:
    | {
        Instrument?:
          | { filledQuantity?: Num; Product?: { symbol?: string } }
          | { filledQuantity?: Num; Product?: { symbol?: string } }[];
        placedTime?: Num;
        status?: string;
      }
    | {
        Instrument?:
          | { filledQuantity?: Num; Product?: { symbol?: string } }
          | { filledQuantity?: Num; Product?: { symbol?: string } }[];
        placedTime?: Num;
        status?: string;
      }[];
  orderId?: Num;
}

export interface EtradeOpenOrder {
  readonly filledQuantity: Decimal | undefined;
  readonly orderId: string;
  readonly placedAt: string;
  readonly status: string;
  readonly symbol: string;
}

export async function listOrders(
  accountIdKey: string
): Promise<EtradeOpenOrder[]> {
  const response = await orderRequest<OrdersResponse>(
    'GET',
    `/v1/accounts/${accountIdKey}/orders.json?status=OPEN`
  );

  const raw = response.OrdersResponse?.Order;
  const orders = raw === undefined ? [] : Array.isArray(raw) ? raw : [raw];

  return orders.map(order => {
    const detail = firstOf(order.OrderDetail);
    const instrument = firstOf(detail?.Instrument);
    const placed = Number(detail?.placedTime);
    return {
      filledQuantity: dec(instrument?.filledQuantity),
      orderId: String(order.orderId ?? ''),
      // E*TRADE reports epoch milliseconds.
      placedAt: Number.isFinite(placed)
        ? new Date(placed).toISOString().slice(0, 10)
        : '',
      status: detail?.status ?? 'unknown',
      symbol: instrument?.Product?.symbol ?? ''
    };
  });
}

export async function cancelOrder(
  accountIdKey: string,
  orderId: string
): Promise<void> {
  await orderRequest<unknown>(
    'PUT',
    `/v1/accounts/${accountIdKey}/orders/cancel.json`,
    { CancelOrderRequest: { orderId: Number(orderId) } }
  );
}
