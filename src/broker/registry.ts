import { alpacaAdapter } from './alpaca-adapter.ts';
import { etradeAdapter } from './etrade-adapter.ts';
import { fidelityAdapter } from './fidelity-adapter.ts';

import type { BrokerAdapter } from './contract.ts';

/**
 * Every brokerage integration, keyed by id.
 *
 * Adding one is: write an adapter against `BrokerAdapter`, add a line here,
 * add its credentials to the provider registry. No tool changes — the tools
 * speak only the neutral contract and fan out across whatever is registered.
 */
const ADAPTERS: Readonly<Record<string, BrokerAdapter>> = {
  alpaca: alpacaAdapter,
  etrade: etradeAdapter,
  fidelity: fidelityAdapter
};

/** An adapter with the id it is registered under. */
export interface RegisteredBroker {
  readonly adapter: BrokerAdapter;
  readonly id: string;
}

export function brokerAdapter(id: string): BrokerAdapter {
  const adapter = ADAPTERS[id];
  if (!adapter) {
    throw new Error(
      `No broker adapter "${id}". Available: ${Object.keys(ADAPTERS).join(', ')}.`
    );
  }
  return adapter;
}

/** Every registered broker, in a stable order. */
export function allBrokers(): RegisteredBroker[] {
  return Object.entries(ADAPTERS).map(([id, adapter]) => ({ adapter, id }));
}

/**
 * Those that could answer a read right now.
 *
 * `isConnected` rather than `isConfigured`: an E*TRADE consumer key with a
 * token that died at midnight is configured and useless, and including it
 * would turn every aggregate read into a failure report.
 */
export function connectedBrokers(): RegisteredBroker[] {
  return allBrokers().filter(broker => broker.adapter.isConnected());
}

/** Which brokers are configured, for reporting rather than for dispatch. */
export function configuredBrokers(): {
  configured: boolean;
  connected: boolean;
  id: string;
  label: string;
  needsAuthorization: boolean;
}[] {
  return allBrokers().map(({ adapter, id }) => ({
    configured: adapter.isConfigured(),
    connected: adapter.isConnected(),
    id,
    label: adapter.label(),
    needsAuthorization: adapter.authorize !== undefined
  }));
}
