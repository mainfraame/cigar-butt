import { defineConfig } from 'tsdown';

// A single ESM bundle with a shebang: this package is consumed as an MCP stdio
// server (`npx cigar-butt`), so there is no CJS consumer to support.
//
// Declared dependencies stay unbundled — that is tsdown's default for
// `dependencies` and `peerDependencies`, and it is the right call here: zod in
// particular must be the same copy the MCP SDK holds, or schema identity checks
// across the boundary stop matching.
export default defineConfig({
  clean: true,
  // No declarations: this package is a bin, not a library. `main`/`exports`
  // were removed for the same reason — importing the entry would start an MCP
  // server on stdio as a side effect.
  dts: false,
  entry: ['src/index.ts'],
  format: ['esm'],
  outExtensions: () => ({ js: '.js' }),
  platform: 'node',
  target: 'node24',
  unbundle: false
});
