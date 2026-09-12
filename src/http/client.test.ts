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
