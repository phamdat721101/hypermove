/**
 * src/lib/mcp/providers/types.ts
 * ------------------------------
 * The DataProvider contract. All web3 data adapters (Moralis / Alchemy /
 * QuickNode / Mock) implement this ONE interface and return the shared
 * ServiceResult envelope. The router depends on the interface, never on a
 * concrete adapter (Dependency Inversion).
 */

import type { ServiceResult } from '../envelope';

export type ProviderName = 'moralis' | 'alchemy' | 'quicknode' | 'stellar' | 'xrpl' | 'mock';

/** A normalized cross-provider call. `method` is a canonical operation id. */
export interface ProviderCall {
  method: string;
  chain: string;
  params: Record<string, unknown>;
}

export interface DataProvider {
  readonly name: ProviderName;
  /** True when this provider can serve `method` on `chain`. */
  supports(method: string, chain: string): boolean;
  /** Execute the call; MUST resolve to an envelope, never throw across the boundary. */
  call(input: ProviderCall): Promise<ServiceResult<unknown>>;
}

/** The canonical read/stream operations the gateway exposes (doc-04 method tables). */
export const CANONICAL_METHODS = [
  'getTokenBalances',
  'getWalletTxns',
  'getTokenPrice',
  'getNftHoldings',
  'getContractLogs',
  'getBlock',
  'getTx',
  'getTokenMetadata',
  'getContractState',
  'getTransactionReceipt',
  'getGasPrice',
  'getTopTokenHolders',
  'getTokenTransfers',
  'streamEvents',
  'queryOnChainSql',
] as const;

export type CanonicalMethod = (typeof CANONICAL_METHODS)[number];
