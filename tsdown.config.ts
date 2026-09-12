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
  dts: true,
  entry: ['src/index.ts'],
  format: ['esm'],
  outExtensions: () => ({ js: '.js' }),
  platform: 'node',
  target: 'node24',
  unbundle: false
});
