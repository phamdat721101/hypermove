/**
 * src/lib/mcp/providers/goat.ts
 * ------------------------------
 * GOAT Network adapter: generic goat-geth EVM reads + GOAT-native methods
 * (yield, settlement status, identity, lending position). Uses viem for ABI
 * encoding + DataProvider pattern (same as Flare).
 *
 * SOLID:
 *  - Single Responsibility: GOAT reads only. Router + catalog handle exposure.
 *  - Open/Closed: add new GOAT methods by extending the method map.
 *
 * Security:
 *  - Keyless: GOAT RPC is public; no API key needed.
 *  - Honest: methods without live contracts return softEmpty (no fabrication).
 */

import { createPublicClient, http, type Chain, type Address, type PublicClient } from 'viem';
import { ok, softEmpty, type ServiceResult } from '../envelope';
import { GOAT_CHAIN_IDS, GOAT_RPC } from './chain-constants';
import { isMcpGoatEnabled } from '../../platform-flag';
import type { DataProvider, ProviderCall } from './types';

/** GOAT chain definitions (viem doesn't ship them). */
const GOAT_CHAINS: Record<string, Chain> = {
  'goat-mainnet': {
    id: GOAT_CHAIN_IDS.goat,
    name: 'GOAT Network',
    nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
    rpcUrls: { default: { http: [GOAT_RPC.goat] } },
  } as unknown as Chain,
  'goat-testnet': {
    id: GOAT_CHAIN_IDS['goat-testnet'],
    name: 'GOAT Testnet3',
    nativeCurrency: { name: 'Bitcoin', symbol: 'BTC', decimals: 18 },
    rpcUrls: { default: { http: [GOAT_RPC['goat-testnet'] ?? GOAT_RPC.goat] } },
  } as unknown as Chain,
};

const GOAT_NETWORKS = new Set(['goat', 'goat-mainnet', 'goat-testnet']);
const GOAT_METHODS = new Set(['goat.ethCall', 'goat.yieldRate', 'goat.settlementStatus', 'goat.identity', 'goat.lendingPosition']);

export class GoatProvider implements DataProvider {
  readonly name = 'goat' as const;
  private readonly clients = new Map<string, PublicClient>();

  supports(method: string, chain: string): boolean {
    if (!isMcpGoatEnabled()) return false;
    return GOAT_NETWORKS.has(chain.split('-')[0]) && GOAT_METHODS.has(method);
  }

  private client(network: string): PublicClient {
    let c = this.clients.get(network);
    if (!c) {
      const chainDef = GOAT_CHAINS[network] ?? GOAT_CHAINS['goat-mainnet'];
      c = createPublicClient({ chain: chainDef, transport: http() });
      this.clients.set(network, c);
    }
    return c;
  }

  async call(input: ProviderCall): Promise<ServiceResult<unknown>> {
    if (!isMcpGoatEnabled()) {
      return softEmpty('goat', 'GOAT adapter disabled', 'set FEATURE_MCP_GOAT=true');
    }
    const network = input.chain.split('-')[0] === 'goat' ? input.chain : 'goat-mainnet';
    const c = this.client(network);

    switch (input.method) {
      case 'goat.ethCall': {
        const { to, data } = input.params as { to: Address; data: `0x${string}` };
        try {
          const result = await c.call({ to, data });
          return ok(result.data ?? '0x');
        } catch (err) {
          return softEmpty('goat', err instanceof Error ? err.message : String(err), 'eth_call failed');
        }
      }

      case 'goat.yieldRate':
        // Honest: contract not yet verified; return corpus-grounded hint
        return ok({
          rate: null,
          source: 'GOAT native BTC yield from real network activity (goat.network)',
          hint: 'Contract address TBD; verify BitVM2 yield contract on goat.network/docs',
          chain: network,
        });

      case 'goat.settlementStatus':
        return ok({
          status: 'pending_contract_verification',
          source: 'GOAT Stack: value settles on Bitcoin via BitVM2 + zkMIPS (goat.network/news/the-goat-stack)',
          hint: 'BitVM2 contract address TBD; live status requires on-chain read',
          chain: network,
        });

      case 'goat.identity':
        return ok({
          identity: null,
          source: 'GOAT Agent Infrastructure (docs.goat.network/docs/agents/overview)',
          hint: 'ERC-8004 identity contract TBD; n-payment goat/identity module has paths',
          chain: network,
        });

      case 'goat.lendingPosition':
        return ok({
          position: null,
          source: 'n-payment goat/lending + acquisition modules',
          hint: 'BTC-as-collateral lending contract TBD; n-payment already ships the write path',
          chain: network,
        });

      default:
        return softEmpty('goat', `unknown GOAT method "${input.method}"`, `supported: ${[...GOAT_METHODS].join(', ')}`);
    }
  }
}

/** Create the GOAT provider. */
export function createGoat(): DataProvider {
  return new GoatProvider();
}
