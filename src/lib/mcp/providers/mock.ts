/**
 * src/lib/mcp/providers/mock.ts
 * -----------------------------
 * Deterministic mock data provider. Zero-config default (mirrors the app's
 * LIVE_AGENT_MODE=mock pattern) AND the fallback every real adapter delegates
 * to when its API key is absent. Same value in → same envelope out, always.
 */

import { createHash } from 'node:crypto';
import { ok, softEmpty, type ServiceResult } from '../envelope';
import { CANONICAL_METHODS, type DataProvider, type ProviderCall } from './types';

/** Stable pseudo-number derived from a seed — deterministic across runs. */
function seededInt(seed: string, mod: number): number {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 8);
  return parseInt(hex, 16) % mod;
}

function fixture(input: ProviderCall): unknown {
  const { method, chain, params } = input;
  const addr = String(params.address ?? params.contract ?? params.tokenAddress ?? '0xmock');
  const seed = `${method}:${chain}:${addr}`;
  switch (method) {
    case 'getTokenBalances':
      return { chain, address: addr, tokens: [
        { symbol: 'USDC', decimals: 6, balance: String(seededInt(seed, 1_000_000)) },
        { symbol: 'WETH', decimals: 18, balance: String(seededInt(seed + 'w', 5_000)) },
      ] };
    case 'getTokenPrice':
      return { chain, token: addr, usd: (seededInt(seed, 500000) / 100).toFixed(2) };
    case 'getBlock':
      return { chain, number: 20_000_000 + seededInt(seed, 100_000), hash: `0x${createHash('sha256').update(seed).digest('hex').slice(0, 40)}` };
    case 'getGasPrice':
      return { chain, gwei: (seededInt(seed, 100) + 1).toString() };
    case 'getWalletTxns':
    case 'getTokenTransfers':
      return { chain, address: addr, txns: Array.from({ length: 3 }, (_, i) => ({
        hash: `0x${createHash('sha256').update(seed + i).digest('hex').slice(0, 40)}`,
        value: String(seededInt(seed + i, 10_000)),
      })) };
    default:
      return { chain, method, address: addr, note: 'deterministic mock payload' };
  }
}

export class MockProvider implements DataProvider {
  readonly name = 'mock' as const;

  supports(method: string, _chain?: string): boolean {
    return (CANONICAL_METHODS as readonly string[]).includes(method);
  }

  async call(input: ProviderCall): Promise<ServiceResult<unknown>> {
    if (!this.supports(input.method)) {
      return softEmpty('mock', `no mock fixture for method "${input.method}"`, 'add a fixture in providers/mock.ts');
    }
    return ok(fixture(input));
  }
}
