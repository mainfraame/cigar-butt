#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';

import { createServer } from './server.ts';

/**
 * stdio entrypoint. Nothing may write to stdout except the protocol itself —
 * a stray console.log corrupts the stream and the client drops the connection,
 * which is why `eslint/no-console` is an error across this package.
 */
serveStdio(createServer);
