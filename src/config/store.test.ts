import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { providerById } from './providers.ts';
import {
  getCredential,
  requireCredential,
  resetCredentialCache,
  saveCredentials,
  setupReport
} from './store.ts';

let configPath: string;
const saved = { ...process.env };

beforeEach(() => {
  configPath = join(
    mkdtempSync(join(tmpdir(), 'cigar-butt-')),
    'credentials.json'
  );
  // Clear every provider var so a developer's real shell does not leak in.
  for (const key of Object.keys(process.env)) {
    if (/_API_KEY$|^SEC_USER_AGENT$/.test(key)) delete process.env[key];
  }
  process.env.CIGAR_BUTT_CONFIG = configPath;
  resetCredentialCache();
});

afterEach(() => {
  process.env = { ...saved };
  resetCredentialCache();
});

describe('credential store', () => {
  it('reports nothing configured on a first run', () => {
    const report = setupReport();

    expect(report.ready).toBe(false);
    expect(report.missingRequired.map(spec => spec.envVar)).toContain(
      'SEC_USER_AGENT'
    );
    expect(report.unsatisfiedGroups).toContain('prices');
  });

  it('persists values and reads them back', () => {
    saveCredentials({ TIINGO_API_KEY: 'abc123' });
    resetCredentialCache();

    expect(getCredential('TIINGO_API_KEY')).toBe('abc123');
  });

  it('writes the credential file 0600', () => {
    saveCredentials({ TIINGO_API_KEY: 'abc123' });

    // Group and other must have no access: this file holds live API keys.
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('lets the environment override the stored value', () => {
    saveCredentials({ TIINGO_API_KEY: 'from-file' });
    resetCredentialCache();
    process.env.TIINGO_API_KEY = 'from-env';

    expect(getCredential('TIINGO_API_KEY')).toBe('from-env');
    const status = setupReport().statuses.find(
      entry => entry.spec.envVar === 'TIINGO_API_KEY'
    );
    expect(status?.source).toBe('environment');
  });

  it('removes a credential when given an empty string', () => {
    saveCredentials({ TIINGO_API_KEY: 'abc123' });
    saveCredentials({ TIINGO_API_KEY: '' });
    resetCredentialCache();

    expect(getCredential('TIINGO_API_KEY')).toBeUndefined();
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({});
  });

  it('is ready once the required and one-of credentials are present', () => {
    saveCredentials({
      SEC_USER_AGENT: 'Jane Doe jane@example.com',
      TIINGO_API_KEY: 'abc123'
    });
    resetCredentialCache();

    expect(setupReport().ready).toBe(true);
  });

  it('names the provider and its sign-up URL when a credential is missing', () => {
    const spec = providerById('tiingo');
    expect(spec).toBeDefined();
    if (!spec) return;

    expect(() => requireCredential(spec)).toThrow(/setup_credentials/);
    expect(() => requireCredential(spec)).toThrow(/tiingo\.com/);
  });
});
