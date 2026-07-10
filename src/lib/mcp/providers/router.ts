/**
 * src/lib/mcp/providers/router.ts
 * -------------------------------
 * Chooses which provider serves a call (doc-04 §1 routing table) and falls
 * back through the remaining providers on failure. Depends only on the
 * DataProvider interface — adapters are injected, never imported here.
 *
 * SOLID:
 *  - Dependency Inversion: providers passed in via the constructor.
 *  - Open/Closed: change routing by editing decide(); adding a provider needs
 *    no change to callers.
 */

import { softEmpty, type ServiceResult } from '../envelope';
import type { DataProvider, ProviderCall, ProviderName } from './types';

export interface RouteDecision {
  primary: ProviderName;
  fallback: ProviderName[];
  reason: string;
}

const NON_EVM = new Set(['solana', 'bitcoin', 'ton', 'sui', 'stellar', 'xrpl']);

/** Pure routing decision — deterministic, unit-testable, no I/O. */
export function decide(method: string, chain: string): RouteDecision {
  const base = chain.split('-')[0];
  if (base === 'stellar') {
    return { primary: 'stellar', fallback: ['mock'], reason: 'Stellar served by Horizon + Soroban RPC adapter' };
  }
  if (base === 'xrpl') {
    return { primary: 'xrpl', fallback: ['mock'], reason: 'XRPL served by the public JSON-RPC adapter' };
  }
  if (NON_EVM.has(base)) {
    return { primary: 'moralis', fallback: ['quicknode', 'mock'], reason: 'non-EVM chain best served by Moralis' };
  }
  if (method.startsWith('debug') || method.includes('trace') || method === 'getContractState' || method === 'getTransactionReceipt') {
    return { primary: 'alchemy', fallback: ['quicknode', 'moralis', 'mock'], reason: 'debug/trace/state best on Alchemy' };
  }
  if (method.includes('stream') || method.includes('subscribe') || method === 'queryOnChainSql') {
    return { primary: 'quicknode', fallback: ['moralis', 'mock'], reason: 'streaming/SQL best on QuickNode' };
  }
  if (method.toLowerCase().includes('nft') || method.toLowerCase().includes('token')) {
    return { primary: 'moralis', fallback: ['alchemy', 'quicknode', 'mock'], reason: 'NFT/token analytics best on Moralis' };
  }
  return { primary: 'alchemy', fallback: ['moralis', 'quicknode', 'mock'], reason: 'default EVM-chain adapter' };
}

export class AdapterRouter {
  private readonly byName: Map<ProviderName, DataProvider>;

  constructor(providers: DataProvider[]) {
    this.byName = new Map(providers.map((p) => [p.name, p]));
  }

  /** Route + dispatch with fallback. Never throws — always resolves an envelope. */
  async dispatch(input: ProviderCall): Promise<ServiceResult<unknown>> {
    const { primary, fallback } = decide(input.method, input.chain);
    const order = [primary, ...fallback];

    let lastMsg = 'no provider available';
    for (const name of order) {
      const provider = this.byName.get(name);
      if (!provider || !provider.supports(input.method, input.chain)) continue;
      try {
        const res = await provider.call(input);
        // soft-empty from a real provider → try the next; only return soft-empty if all exhausted.
        if (res.ok || res.error.kind === 'error') return res;
        lastMsg = res.error.message;
      } catch (err) {
        lastMsg = err instanceof Error ? err.message : String(err);
      }
    }
    return softEmpty('router', lastMsg, `all providers failed for ${input.method} on ${input.chain}; retry after backoff`);
  }
}
