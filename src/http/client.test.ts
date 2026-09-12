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
