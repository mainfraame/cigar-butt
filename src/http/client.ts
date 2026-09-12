/**
 * One HTTP path for every upstream, so rate limits, retries and the "never log
 * a credential" rule are enforced in a single place rather than per provider.
 */

export interface FetchJsonOptions {
  /** JSON request body. Implies POST unless `method` says otherwise. */
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  readonly method?: 'GET' | 'POST';
  /** Requests per second permitted against this host. */
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
    options.method ?? (options.body === undefined ? 'GET' : 'POST');
  const payload =
    options.body === undefined ? undefined : JSON.stringify(options.body);

  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    await throttle(options.rateKey, options.requestsPerSecond);

    let response: Response;
    try {
      response = await fetch(url, {
        body: payload,
        headers: {
          accept: 'application/json',
          ...(payload === undefined
            ? {}
            : { 'content-type': 'application/json' }),
          ...options.headers
        },
        method,
        signal: options.signal
      });
    } catch (error) {
      lastError = error;
      if (attempt === MAX_ATTEMPTS) break;
      await sleep(2 ** attempt * 250);
      continue;
    }

    if (response.ok) return (await response.json()) as T;

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
