#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createServer } from './server.ts';
import { runWatchCli } from './watch/cli.ts';

/**
 * Entry point.
 *
 * **Bare `cigar-butt` stays the stdio MCP server**, so every existing
 * `claude mcp add` line keeps working. Only an explicit `watch` subcommand
 * branches away — an MCP client launches this with no arguments, and anything
 * that changed that default would break every installation silently.
 *
 * Node emits an ExperimentalWarning for `node:sqlite` on runtimes newer than
 * the Node 24 LTS this targets, where it is a release candidate and silent. It
 * cannot be suppressed from here: the bundler hoists every import, so the
 * warning fires before any handler this module installs could run. Cosmetic,
 * stderr-only, and not worth lazy-loading sqlite in four modules to hide.
 *
 * Nothing may write to stdout except the protocol itself. A stray console.log
 * corrupts the stream and the client drops the connection, which is why
 * `eslint/no-console` is an error across this package and why the watch CLI
 * prints to stderr even though it never speaks the protocol.
 */
const [subcommand, ...rest] = process.argv.slice(2);

if (subcommand === 'watch') {
  await runWatchCli(rest);
} else {
  serveStdio(createServer);
}
