import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { PROVIDERS, type ProviderSpec } from './providers.ts';

/**
 * Credentials live in two places and are read in this order:
 *
 *   1. the process environment (what a `claude_desktop_config.json` `env`
 *      block or a shell export sets), and
 *   2. a JSON file under the user's config dir, written by `setup_credentials`.
 *
 * The environment wins, so an operator can override a stored key for one run
 * without editing the file. Nothing is ever written to the repository, and the
 * file is created 0600.
 */

interface CredentialStatus {
  readonly configured: boolean;
  /** Where the value came from, when configured. */
  readonly source?: 'config-file' | 'environment';
  readonly spec: ProviderSpec;
}

export interface SetupReport {
  readonly configPath: string;
  /** Providers whose absence blocks screening. */
  readonly missingRequired: readonly ProviderSpec[];
  readonly ready: boolean;
  readonly statuses: readonly CredentialStatus[];
  /** `one-of` groups with no member configured. */
  readonly unsatisfiedGroups: readonly string[];
}

type StoredCredentials = Record<string, string>;

const APP_DIR = 'cigar-butt';
const FILE_NAME = 'credentials.json';

/** Resolved once per process; `setup_credentials` invalidates it on write. */
let cache: StoredCredentials | undefined;

function credentialsPath(): string {
  const override = process.env.CIGAR_BUTT_CONFIG;
  if (override) return override;

  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg && xdg.length > 0 ? xdg : join(homedir(), '.config');
  return join(base, APP_DIR, FILE_NAME);
}

/**
 * Loads a dotenv file if the operator points at one. Node 24 parses these
 * natively, so this costs no dependency. Failures are deliberately silent: an
 * absent or malformed env file is a configuration choice, not a crash, and the
 * setup report will show exactly which credentials ended up missing.
 */
export function loadEnvFile(): void {
  const path = process.env.CIGAR_BUTT_ENV_FILE;
  if (!path) return;
  try {
    process.loadEnvFile(path);
  } catch {
    // Reported through the setup status, not thrown — see above.
  }
}

function readStore(): StoredCredentials {
  if (cache) return cache;
  try {
    const raw = readFileSync(credentialsPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    cache =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as StoredCredentials)
        : {};
  } catch {
    // No file yet is the normal first-run state.
    cache = {};
  }
  return cache;
}

/** Reads one credential, environment first. Returns undefined when unset. */
export function getCredential(envVar: string): string | undefined {
  const fromEnv = process.env[envVar]?.trim();
  if (fromEnv) return fromEnv;
  const fromFile = readStore()[envVar]?.trim();
  return fromFile && fromFile.length > 0 ? fromFile : undefined;
}

/** Reads a credential or throws a message aimed at the calling model. */
export function requireCredential(spec: ProviderSpec): string {
  const value = getCredential(spec.envVar);
  if (!value) {
    throw new Error(
      `${spec.label} is not configured. Run the \`setup_credentials\` tool, or ` +
        `set ${spec.envVar}. Register at ${spec.signupUrl}`
    );
  }
  return value;
}

/**
 * Merges values into the credential file. Empty strings delete a key, which is
 * how a user rotates a provider back out. Returns the keys actually written.
 */
export function saveCredentials(values: Readonly<StoredCredentials>): string[] {
  const path = credentialsPath();
  const merged: StoredCredentials = { ...readStore() };

  const written: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      delete merged[key];
    } else {
      merged[key] = trimmed;
    }
    written.push(key);
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });
  // writeFileSync's mode only applies on creation; chmod covers an existing
  // file that was created with a laxer umask.
  chmodSync(path, 0o600);

  cache = merged;
  return written;
}

/** The full picture of what is and is not configured. */
export function setupReport(): SetupReport {
  const statuses: CredentialStatus[] = PROVIDERS.map(spec => {
    const fromEnv = process.env[spec.envVar]?.trim();
    if (fromEnv) return { configured: true, source: 'environment', spec };
    const fromFile = readStore()[spec.envVar]?.trim();
    if (fromFile) return { configured: true, source: 'config-file', spec };
    return { configured: false, spec };
  });

  const missingRequired = statuses
    .filter(s => !s.configured && s.spec.requirement === 'required')
    .map(s => s.spec);

  const groups = new Set(
    PROVIDERS.filter(p => p.requirement === 'one-of' && p.group).map(
      p => p.group as string
    )
  );
  const unsatisfiedGroups = [...groups].filter(
    group => !statuses.some(s => s.configured && s.spec.group === group)
  );

  return {
    configPath: credentialsPath(),
    missingRequired,
    ready: missingRequired.length === 0 && unsatisfiedGroups.length === 0,
    statuses,
    unsatisfiedGroups
  };
}

/** Test seam: forces the next read to hit disk again. */
export function resetCredentialCache(): void {
  cache = undefined;
}
