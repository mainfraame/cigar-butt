import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeSettingsDb,
  detailPreference,
  openSettingsDbForTest,
  resolveDetail,
  setDetailPreference,
  setMeta
} from './technical-settings.ts';

const saved = { ...process.env };

beforeEach(() => {
  openSettingsDbForTest(':memory:');
});

afterEach(() => {
  closeSettingsDb();
  process.env = { ...saved };
});

describe('detail preference', () => {
  it('starts unset, which is not the same as "simple"', () => {
    // The three-state distinction the rest of the codebase draws: nothing
    // stored is a gap, not a choice. Only `resolveDetail` collapses it.
    expect(detailPreference()).toBeUndefined();
  });

  it('persists a choice and reads it back', () => {
    setDetailPreference('advanced');
    expect(detailPreference()).toBe('advanced');
    setDetailPreference('simple');
    expect(detailPreference()).toBe('simple');
  });

  it('ignores a value it does not recognise rather than throwing', () => {
    setMeta('technical.detail', 'expert');
    expect(detailPreference()).toBeUndefined();
    expect(resolveDetail()).toBe('simple');
  });
});

/**
 * The precedence, asserted in all three directions. It is exactly the kind of
 * ordering that inverts silently: `stored ?? requested` type-checks, reads
 * plausibly, and makes the explicit argument do nothing.
 */
describe('resolveDetail precedence', () => {
  it('defaults to simple when nothing is stored and nothing is passed', () => {
    expect(resolveDetail()).toBe('simple');
    expect(resolveDetail(undefined)).toBe('simple');
  });

  it('uses the stored preference when no argument is passed', () => {
    setDetailPreference('advanced');
    expect(resolveDetail()).toBe('advanced');
  });

  it('lets an explicit argument beat the stored preference, both ways', () => {
    setDetailPreference('advanced');
    expect(resolveDetail('simple')).toBe('simple');

    setDetailPreference('simple');
    expect(resolveDetail('advanced')).toBe('advanced');
  });

  it('does not persist anything by resolving', () => {
    expect(resolveDetail('advanced')).toBe('advanced');
    expect(detailPreference()).toBeUndefined();
  });
});

describe('storage', () => {
  it('survives a reconnect, which is what an MCP restart looks like', () => {
    // `:memory:` dies with the connection, so the round trip is proved against
    // a real file — a preference that only lives in the process is a
    // preference the user sets again every session.
    const directory = mkdtempSync(join(tmpdir(), 'cb-settings-'));
    const path = join(directory, 'settings.sqlite');

    openSettingsDbForTest(path);
    setDetailPreference('advanced');
    closeSettingsDb();

    openSettingsDbForTest(path);
    expect(detailPreference()).toBe('advanced');

    closeSettingsDb();
    rmSync(directory, { force: true, recursive: true });
  });
});
