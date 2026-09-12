import { alpacaAdapter } from './alpaca-adapter.ts';
import { etradeAdapter } from './etrade-adapter.ts';

import type { BrokerAdapter } from './contract.ts';

/**
 * Every brokerage integration, keyed by id.
 *
 * Adding one is: write an adapter against `BrokerAdapter`, add a line here,
 * add its credentials to the provider registry. No tool changes — the tools
 * resolve a broker by id and speak only the neutral contract.
 */
const ADAPTERS: Readonly<Record<string, BrokerAdapter>> = {
  alpaca: alpacaAdapter,
  etrade: etradeAdapter
};

/**
 * E*TRADE stays the default for continuity with the existing tools. Alpaca is
 * the better unattended choice — static keys, no midnight expiry — so a
 * scheduled watch should prefer it explicitly.
 */
const DEFAULT_BROKER = 'etrade';

export function brokerAdapter(id: string = DEFAULT_BROKER): BrokerAdapter {
  const adapter = ADAPTERS[id];
  if (!adapter) {
    throw new Error(
      `No broker adapter "${id}". Available: ${Object.keys(ADAPTERS).join(', ')}.`
    );
  }
  return adapter;
}

/** Which brokers are configured, for reporting rather than for dispatch. */
export function configuredBrokers(): {
  configured: boolean;
  id: string;
  label: string;
}[] {
  return Object.entries(ADAPTERS).map(([id, adapter]) => ({
    configured: adapter.isConfigured(),
    id,
    label: adapter.label()
  }));
}
