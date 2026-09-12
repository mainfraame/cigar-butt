import { describe, expect, it } from 'vitest';

import { redactUrl } from './client.ts';

describe('redactUrl', () => {
  it.each(['apikey', 'api_key', 'apiKey', 'token'])(
    'scrubs the %s query parameter',
    param => {
      const url = new URL(
        `https://example.com/query?${param}=SECRET&symbol=AAPL`
      );
      const redacted = redactUrl(url);

      // Alpha Vantage and FRED take their key as a query parameter, so any
      // message that names a URL can otherwise leak one.
      expect(redacted).not.toContain('SECRET');
      expect(redacted).toContain('REDACTED');
      expect(redacted).toContain('symbol=AAPL');
    }
  );

  it('scrubs the EDINET subscription key, which rides in a query parameter', () => {
    const url = new URL(
      'https://api.edinet-fsa.go.jp/api/v2/documents.json?date=2026-09-11&Subscription-Key=SECRET'
    );
    const redacted = redactUrl(url);

    expect(redacted).not.toContain('SECRET');
    expect(redacted).toContain('date=2026-09-11');
  });

  it('scrubs a webhook secret carried in the path, not the query', () => {
    // A Slack webhook is hooks.slack.com/services/T…/B…/<secret>. Scrubbing
    // query parameters alone would put the whole secret into an HttpError the
    // moment a POST failed.
    const url = new URL(
      'https://hooks.slack.com/services/T0001/B0002/SECRETBIT'
    );
    const redacted = redactUrl(url);

    expect(redacted).not.toContain('SECRETBIT');
    expect(redacted).toBe('https://hooks.slack.com/REDACTED');
  });

  it('leaves a clean URL untouched', () => {
    const url = new URL('https://data.sec.gov/submissions/CIK0000320193.json');
    expect(redactUrl(url)).toBe(url.toString());
  });

  it('does not mutate the URL it was given', () => {
    const url = new URL('https://example.com/?apikey=SECRET');
    redactUrl(url);

    expect(url.searchParams.get('apikey')).toBe('SECRET');
  });
});

describe('retryStatuses', () => {
  it('defaults to treating 404 as permanent', async () => {
    // A 404 normally means "no such thing"; retrying it wastes quota and time.
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = () => {
      calls += 1;
      return Promise.resolve(new Response('gone', { status: 404 }));
    };

    try {
      const { fetchJson } = await import('./client.ts');
      await fetchJson('https://example.test/x', {
        rateKey: 'example.test',
        requestsPerSecond: 1000
      }).catch(() => undefined);
      expect(calls).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });

  it('retries 404 when a host opts in', async () => {
    // E*TRADE intermittently answers a valid, correctly-signed request with a
    // Tomcat 404. Observed directly: the same URL 404s once, then returns 200
    // four times running.
    let calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = () => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? new Response('flake', { status: 404 })
          : new Response('{"ok":true}', { status: 200 })
      );
    };

    try {
      const { fetchJson } = await import('./client.ts');
      const result = await fetchJson<{ ok: boolean }>(
        'https://example.test/y',
        {
          rateKey: 'example.test',
          requestsPerSecond: 1000,
          retryStatuses: [404]
        }
      );
      expect(result.ok).toBe(true);
      expect(calls).toBe(2);
    } finally {
      globalThis.fetch = original;
    }
  });
});
