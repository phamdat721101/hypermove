/**
 * src/lib/mcp/providers/index.ts
 * ------------------------------
 * Barrel + router factory. When the data-adapters flag is off, only the mock
 * provider is wired (mock-first). When on, the three real adapters join — but
 * each still self-delegates to mock when its key is absent.
 */

import { isMcpDataAdaptersEnabled, isMcpFlareEnabled, isMcpGoatEnabled } from '../../platform-flag';
import { AdapterRouter } from './router';
import { MockProvider } from './mock';
import { createMoralis, createAlchemy, createQuickNode, createStellar, createXrpl } from './real';
import { createFlare } from './flare';
import { createGoat } from './goat';
import type { DataProvider } from './types';

export { AdapterRouter, decide } from './router';
export { MockProvider } from './mock';
export type { DataProvider, ProviderCall, ProviderName } from './types';

let cached: AdapterRouter | null = null;

export function buildRouter(): AdapterRouter {
  if (cached) return cached;
  const providers: DataProvider[] = [new MockProvider()];
  if (isMcpDataAdaptersEnabled()) {
    providers.push(createMoralis(), createAlchemy(), createQuickNode(), createStellar(), createXrpl());
  }
  // Flare is keyless (free FTSO oracle) → gated by its own flag, independent of keyed adapters.
  if (isMcpFlareEnabled()) {
    providers.push(createFlare());
  }
  // GOAT is keyless (goat-geth RPC) → gated by its own flag, independent of keyed adapters.
  if (isMcpGoatEnabled()) {
    providers.push(createGoat());
  }
  cached = new AdapterRouter(providers);
  return cached;
}

/** Test hook. */
export function _resetRouter(): void {
  cached = null;
}
