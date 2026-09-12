import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CACHE_NAMESPACES } from './store.ts';

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(entry => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
  });
}

/**
 * Every namespace a `cached()` call uses must be listed, or `cache_clear`
 * cannot name it. That is not cosmetic: a day list that came back empty during
 * an upstream outage sits there for a week, and without a name for it the only
 * remedy is deleting the whole database.
 */
describe('cache namespaces', () => {
  const used = new Set<string>();
  for (const file of sources('src')) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(
      /cached(?:<[^>]*>)?\(\s*\n?\s*'([a-z0-9-]+)'/g
    )) {
      used.add(match[1]!);
    }
    // E*TRADE caches through the same store behind `get(namespace, path)`.
    // The path argument is what distinguishes it from every other `get(` in
    // the codebase — Map.get, Headers.get — which would otherwise flood this.
    for (const match of text.matchAll(
      /get(?:<[^>]*>)?\(\s*\n?\s*'([a-z0-9-]+)',\s*\n?\s*(?:`|')\//g
    )) {
      used.add(match[1]!);
    }
  }

  it('finds the call sites at all, so a silent regex break fails loudly', () => {
    expect(used.size).toBeGreaterThan(20);
  });

  it('lists every namespace a call site uses', () => {
    const missing = [...used].filter(
      namespace => !CACHE_NAMESPACES.includes(namespace as never)
    );
    expect(missing).toEqual([]);
  });

  it('lists nothing that no call site uses', () => {
    // A stale entry is a `cache_clear` option that silently does nothing.
    const unused = CACHE_NAMESPACES.filter(namespace => !used.has(namespace));
    expect(unused).toEqual([]);
  });
});
