/**
 * One HTTP path for every upstream, so rate limits, retries and the "never log
 * a credential" rule are enforced in a single place rather than per provider.
 */

export interface FetchJsonOptions {
  /** JSON request body. Implies POST unless `method` says otherwise. */
  readonly body?: unknown;
  /** Cookie jar, read and written in place. Enables session-based sources. */
  readonly cookies?: Map<string, string>;
  /** Form-encoded body. Mutually exclusive with `body`; implies POST. */
  readonly form?: Readonly<Record<string, string>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method?: 'GET' | 'POST';
  /** Requests per second permitted against this host. */
  /** `text` returns the raw body; the default parses JSON. */
  readonly parse?: 'json' | 'text';
  readonly rateKey: string;
  readonly requestsPerSecond: number;
  readonly searchParams?: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}

class HttpError extends Error {
  readonly body: string;
  readonly status: number;

  constructor(status: number, url: string, body: string) {
    // `url` is pre-redacted by the caller; see redactUrl.
    super(
      `HTTP ${status} from ${url}${body ? `: ${truncate(body, 300)}` : ''}`
    );
    this.body = body;
    this.name = 'HttpError';
    this.status = status;
  }
}

/** Per-host clock: the earliest time the next request to that host may go out. */
const nextSlot = new Map<string, number>();

const RETRY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/**
 * Alpha Vantage and FRED take their key as a query parameter, so a URL can
 * carry a secret. Every message that names a URL goes through here first.
 */
export function redactUrl(url: URL): string {
  const copy = new URL(url.toString());
  for (const key of ['apikey', 'api_key', 'apiKey', 'token']) {
    if (copy.searchParams.has(key)) copy.searchParams.set(key, 'REDACTED');
  }
  return copy.toString();
}

/** Merges a response's Set-Cookie headers into the jar. */
function absorbCookies(response: Response, jar: Map<string, string>): void {
  // getSetCookie keeps the headers separate. A joined `set-cookie` string
  // cannot be split reliably, because Expires attributes contain commas.
  for (const header of response.headers.getSetCookie()) {
    const [pair] = header.split(';');
    const index = pair?.indexOf('=') ?? -1;
    if (!pair || index <= 0) continue;
    jar.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
  }
}

function serialiseCookies(jar: Map<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

/** Serialises requests to one host at the configured rate. */
async function throttle(key: string, requestsPerSecond: number): Promise<void> {
  const interval = 1000 / requestsPerSecond;
  const now = Date.now();
  const earliest = nextSlot.get(key) ?? 0;
  const wait = Math.max(0, earliest - now);
  nextSlot.set(key, Math.max(now, earliest) + interval);
  if (wait > 0) await sleep(wait);
}

export async function fetchJson<T>(
  baseUrl: string,
  options: FetchJsonOptions
): Promise<T> {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(options.searchParams ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value);
  }

  const method =
    options.method ??
    (options.body === undefined && options.form === undefined ? 'GET' : 'POST');
  const payload = options.form
    ? new URLSearchParams(options.form).toString()
    : options.body === undefined
      ? undefined
      : JSON.stringify(options.body);
  const contentType = options.form
    ? 'application/x-www-form-urlencoded'
    : 'application/json';

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await throttle(options.rateKey, options.requestsPerSecond);

    let response: Response;
    try {
      response = await fetch(url, {
        body: payload,
        headers: {
          accept: 'application/json',
          ...(payload === undefined ? {} : { 'content-type': contentType }),
          ...(options.cookies && options.cookies.size > 0
            ? { cookie: serialiseCookies(options.cookies) }
            : {}),
          ...options.headers
        },
        method,
        // A session source hands out its token on a redirect, so the jar has to
        // see every hop rather than only the final response.
        redirect: options.cookies ? 'manual' : 'follow',
        signal: options.signal
      });
      if (options.cookies) absorbCookies(response, options.cookies);
    } catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(2 ** attempt * 250);
      continue;
    }

    // With manual redirects a 302 is a successful hop, not a failure — the
    // caller wanted the cookies it carried, and there is no body to parse.
    if (options.cookies && response.status >= 300 && response.status < 400) {
      return undefined as T;
    }
    if (response.ok) {
      return options.parse === 'text'
        ? ((await response.text()) as T)
        : ((await response.json()) as T);
    }

    const body = await response.text().catch(() => '');
    const error = new HttpError(response.status, redactUrl(url), body);
    if (!RETRY_STATUSES.has(response.status) || attempt === MAX_ATTEMPTS) {
      throw error;
    }
    lastError = error;

    // Honour Retry-After when the server sends one; otherwise back off.
    const retryAfter = Number(response.headers.get('retry-after'));
    await sleep(
      Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : 2 ** attempt * 500
    );
  }

  throw lastError instanceof Error
    ? lastError
    : new Error(`Request to ${redactUrl(url)} failed`);
}

/**
 * The same path as {@link fetchJson}, for sources that answer with HTML.
 *
 * A thin wrapper rather than a second implementation, so rate limiting, retries
 * and credential redaction stay in one place — a source that bypassed them
 * would be the one that gets an IP blocked.
 */
export function fetchText(
  baseUrl: string,
  options: FetchJsonOptions
): Promise<string> {
  return fetchJson<string>(baseUrl, {
    ...options,
    headers: { accept: 'text/html,application/xhtml+xml', ...options.headers },
    parse: 'text'
  });
}
