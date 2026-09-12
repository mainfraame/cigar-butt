import { sortBy } from 'lodash-es';
import { createHmac, randomBytes } from 'node:crypto';

import { cached } from '../cache/store.ts';
import { getCredential, saveCredentials } from '../config/store.ts';
import { fetchJson } from '../http/client.ts';
import { dec, ZERO } from '../math/decimal.ts';

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
  readonly accountName: string;
  readonly accountStatus: string;
  readonly accountType: string;
  readonly institutionType: string;
}

interface EtradeBalance {
  readonly accountIdKey: string;
  /** ISO date the figures are as of. */
  readonly asOf: string;
  /** Cash available to deploy, not total cash: settled and unencumbered. */
  readonly cash: Decimal;
  readonly netCash: Decimal | undefined;
  readonly totalValue: Decimal | undefined;
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
  /** ISO date of the last trade the mark came from. */
  readonly asOf: string;
  readonly marketValue: Decimal | undefined;
  readonly price: Decimal;
  readonly shares: Decimal;
  readonly ticker: string;
  readonly totalCost: Decimal | undefined;
  readonly totalGain: Decimal | undefined;
}

const ENV_ACCESS_SECRET = 'ETRADE_ACCESS_TOKEN_SECRET';
const ENV_ACCESS_TOKEN = 'ETRADE_ACCESS_TOKEN';
const ENV_CONSUMER_KEY = 'ETRADE_CONSUMER_KEY';
const ENV_CONSUMER_SECRET = 'ETRADE_CONSUMER_SECRET';
const ENV_ENVIRONMENT = 'ETRADE_ENVIRONMENT';
const ENV_REQUEST_SECRET = 'ETRADE_REQUEST_TOKEN_SECRET';
const ENV_REQUEST_TOKEN = 'ETRADE_REQUEST_TOKEN';

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
  const raw = (getCredential(ENV_ENVIRONMENT) ?? getCredential('ETRADE_ENV'))
    ?.trim()
    .toLowerCase();
  return raw === 'sandbox' ? 'sandbox' : 'production';
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
 * Resolves the consumer key pair.
 *
 * E*TRADE issues two independent pairs and they are not interchangeable — a
 * sandbox token is rejected by production even if you send it to the right
 * host. Most people therefore hold both at once, so the environment-scoped
 * names are checked before the unscoped ones and the pair can be switched with
 * `ETRADE_ENV` alone rather than by re-exporting keys.
 */
function scopedVar(suffix: string): string {
  return environment() === 'sandbox'
    ? `ETRADE_SANDBOX_${suffix}`
    : `ETRADE_PROD_${suffix}`;
}

function consumer(): { key: string; secret: string } {
  const scopedKey = getCredential(scopedVar('CONSUMER_KEY'));
  const scopedSecret = getCredential(scopedVar('CONSUMER_SECRET'));
  if (scopedKey && scopedSecret) {
    return { key: scopedKey, secret: scopedSecret };
  }

  if (scopedKey || scopedSecret) {
    throw new Error(
      `Only half of the ${environment()} E*TRADE key pair is set. Both ` +
        `${scopedVar('CONSUMER_KEY')} and ${scopedVar('CONSUMER_SECRET')} are needed.`
    );
  }

  return {
    key: required(ENV_CONSUMER_KEY, `E*TRADE ${environment()} consumer key`),
    secret: required(
      ENV_CONSUMER_SECRET,
      `E*TRADE ${environment()} consumer secret`
    )
  };
}

/** Whether an access token is on hand. Says nothing about whether it still works. */
export function hasAccessToken(): boolean {
  return (
    getCredential(ENV_ACCESS_TOKEN) !== undefined &&
    getCredential(ENV_ACCESS_SECRET) !== undefined
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
    token: required(ENV_ACCESS_TOKEN, 'E*TRADE access token'),
    tokenSecret: required(ENV_ACCESS_SECRET, 'E*TRADE access token secret')
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
  saveCredentials({
    [ENV_REQUEST_SECRET]: pair.secret,
    [ENV_REQUEST_TOKEN]: pair.token
  });

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
  const requestToken = getCredential(ENV_REQUEST_TOKEN);
  const requestSecret = getCredential(ENV_REQUEST_SECRET);
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
  saveCredentials({
    [ENV_ACCESS_SECRET]: pair.secret,
    [ENV_ACCESS_TOKEN]: pair.token,
    [ENV_REQUEST_SECRET]: '',
    [ENV_REQUEST_TOKEN]: ''
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
  saveCredentials({ [ENV_ACCESS_SECRET]: '', [ENV_ACCESS_TOKEN]: '' });
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
  return cached(namespace, `${environment()}${path}`, TTL_BROKER, async () => {
    const payload = await fetchJson<T>(url, {
      headers: {
        authorization: authorization('GET', url, searchParams, identity)
      },
      rateKey: RATE_KEY,
      requestsPerSecond: REQUESTS_PER_SECOND,
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

interface BalanceResponse {
  BalanceResponse?: {
    Computed?: {
      cashAvailableForInvestment?: number | string;
      netCash?: number | string;
      RealTimeValues?: { totalAccountValue?: number | string };
      totalAccountValue?: number | string;
    };
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
  accountName?: string;
  accountStatus?: string;
  accountType?: string;
  institutionType?: string;
}

interface RawAccountPortfolio {
  Position?: RawPosition | RawPosition[];
}

interface RawPosition {
  marketValue?: number | string;
  Product?: { securityType?: string; symbol?: string };
  quantity?: number | string;
  Quick?: { lastTrade?: number | string; lastTradeTime?: number };
  totalCost?: number | string;
  totalGain?: number | string;
}

/** E*TRADE collapses one-element arrays into the object itself. */
function list<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

const today = (): string => new Date().toISOString().slice(0, 10);

/** `lastTradeTime` is epoch seconds; anything else is not a usable mark date. */
function markDate(seconds: number | undefined): string {
  if (
    typeof seconds !== 'number' ||
    !Number.isFinite(seconds) ||
    seconds <= 0
  ) {
    return today();
  }
  return new Date(seconds * 1000).toISOString().slice(0, 10);
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

  const computed = data.BalanceResponse?.Computed;
  return {
    accountIdKey,
    asOf: today(),
    cash: dec(computed?.cashAvailableForInvestment) ?? ZERO,
    netCash: dec(computed?.netCash),
    totalValue:
      dec(computed?.RealTimeValues?.totalAccountValue) ??
      dec(computed?.totalAccountValue)
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
        marketValue: dec(position.marketValue),
        price,
        shares,
        ticker,
        totalCost: dec(position.totalCost),
        totalGain: dec(position.totalGain)
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
