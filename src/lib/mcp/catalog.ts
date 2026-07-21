/**
 * src/lib/mcp/catalog.ts
 * ----------------------
 * Assembles the unified web3 catalog the `search` tool ranks over. Built
 * deterministically (sorted by id) from three existing sources — no network:
 *   1. registry.ts CHAINS   → one "chain" entry each
 *   2. registry.ts PROTOCOLS→ one "protocol" entry each
 *   3. provider method manifest → one "operation" entry per (service, method)
 *
 * Determinism: entries sorted by id; no wall-clock in the entry bodies. This is
 * what makes the CI drift check (scripts/refresh-catalog.mjs) byte-stable.
 */

import { CHAINS, PROTOCOLS } from '../registry';

export type PriceTier = 't1_read' | 't2_realtime' | 't3_vector' | 'confidential';
export type CatalogKind = 'operation' | 'chain' | 'protocol' | 'dapp';

export interface CatalogEntry {
  id: string;
  service: string;
  chain?: string;
  kind: CatalogKind;
  description: string;
  keywords: string[];
  signature?: string;
  priceTier: PriceTier;
}

/** Canonical operations exposed across the data providers (doc-04 tables). */
interface MethodSpec {
  method: string;
  services: string[];
  description: string;
  signature: string;
  tier: PriceTier;
}

const METHOD_MANIFEST: readonly MethodSpec[] = [
  { method: 'getTokenBalances', services: ['moralis', 'alchemy'], description: 'List ERC-20/native token balances for a wallet address.', signature: 'getTokenBalances(chain: string, address: string): TokenBalance[]', tier: 't1_read' },
  { method: 'getWalletTxns', services: ['moralis', 'quicknode'], description: 'Transaction history for a wallet address.', signature: 'getWalletTxns(chain: string, address: string, limit?: number): Txn[]', tier: 't1_read' },
  { method: 'getTokenPrice', services: ['moralis'], description: 'Current USD price for a token.', signature: 'getTokenPrice(chain: string, tokenAddress: string): { usd: string }', tier: 't1_read' },
  { method: 'getNftHoldings', services: ['moralis', 'alchemy'], description: 'NFTs held by a wallet address.', signature: 'getNftHoldings(chain: string, address: string): Nft[]', tier: 't1_read' },
  { method: 'getContractLogs', services: ['moralis'], description: 'Event logs emitted by a contract.', signature: 'getContractLogs(chain: string, contract: string, topic?: string): Log[]', tier: 't1_read' },
  { method: 'getBlock', services: ['moralis', 'alchemy', 'quicknode'], description: 'Block header + metadata by number.', signature: 'getBlock(chain: string, blockNumber: number | "latest"): Block', tier: 't1_read' },
  { method: 'getTx', services: ['quicknode', 'moralis'], description: 'Transaction detail by hash.', signature: 'getTx(chain: string, txHash: string): Txn', tier: 't1_read' },
  { method: 'getTokenMetadata', services: ['moralis'], description: 'Token name/symbol/decimals metadata.', signature: 'getTokenMetadata(chain: string, tokenAddress: string): TokenMeta', tier: 't1_read' },
  { method: 'getContractState', services: ['alchemy'], description: 'Read contract state via eth_call.', signature: 'getContractState(chain: string, contract: string, data: string): Hex', tier: 't1_read' },
  { method: 'getTransactionReceipt', services: ['alchemy'], description: 'Transaction receipt (status, logs, gas).', signature: 'getTransactionReceipt(chain: string, txHash: string): Receipt', tier: 't1_read' },
  { method: 'getGasPrice', services: ['alchemy'], description: 'Current gas price.', signature: 'getGasPrice(chain: string): { gwei: string }', tier: 't1_read' },
  { method: 'getTopTokenHolders', services: ['moralis'], description: 'Largest holders of a token.', signature: 'getTopTokenHolders(chain: string, tokenAddress: string): Holder[]', tier: 't1_read' },
  { method: 'getTokenTransfers', services: ['moralis'], description: 'Recent transfers of a token.', signature: 'getTokenTransfers(chain: string, tokenAddress: string, limit?: number): Transfer[]', tier: 't1_read' },
  { method: 'streamEvents', services: ['quicknode'], description: 'Subscribe to real-time contract/wallet events.', signature: 'streamEvents(chain: string, filter: StreamFilter): AsyncIterable<Event>', tier: 't2_realtime' },
  { method: 'queryOnChainSql', services: ['quicknode'], description: 'Run a Dune-style SQL query over on-chain data.', signature: 'queryOnChainSql(chain: string, sql: string): Row[]', tier: 't2_realtime' },
  // ── Stellar (Horizon REST + Soroban RPC) ──────────────────────────────────
  { method: 'getAccount', services: ['stellar'], description: 'Stellar account balances, thresholds, signers and flags (Horizon).', signature: 'getAccount(chain: "stellar-mainnet", account: string): Account', tier: 't1_read' },
  { method: 'getPayments', services: ['stellar'], description: 'Recent payments to/from a Stellar account (Horizon).', signature: 'getPayments(chain: "stellar-mainnet", account: string, limit?: number): Payment[]', tier: 't1_read' },
  { method: 'getAccountTxns', services: ['stellar'], description: 'Recent transactions for a Stellar account (Horizon).', signature: 'getAccountTxns(chain: "stellar-mainnet", account: string, limit?: number): Txn[]', tier: 't1_read' },
  { method: 'getOrderBook', services: ['stellar'], description: 'Stellar DEX order book (bids/asks) for an asset pair (Horizon).', signature: 'getOrderBook(chain: "stellar-mainnet", buyingAssetType?: string): OrderBook', tier: 't2_realtime' },
  { method: 'getAssets', services: ['stellar'], description: 'Stellar issued-asset registry (Horizon).', signature: 'getAssets(chain: "stellar-mainnet", assetCode?: string, limit?: number): Asset[]', tier: 't1_read' },
  { method: 'getLatestLedger', services: ['stellar'], description: 'Latest closed Stellar ledger (Soroban RPC).', signature: 'getLatestLedger(chain: "stellar-mainnet"): Ledger', tier: 't1_read' },
  // ── XRPL (public JSON-RPC) ────────────────────────────────────────────────
  { method: 'xrplAccountInfo', services: ['xrpl'], description: 'XRPL account info, balance and settings.', signature: 'xrplAccountInfo(chain: "xrpl-mainnet", account: string): AccountInfo', tier: 't1_read' },
  { method: 'xrplAccountTx', services: ['xrpl'], description: 'Validated transactions involving an XRPL account.', signature: 'xrplAccountTx(chain: "xrpl-mainnet", account: string, limit?: number): Txn[]', tier: 't1_read' },
  { method: 'xrplBookOffers', services: ['xrpl'], description: 'XRPL DEX order book between two currencies.', signature: 'xrplBookOffers(chain: "xrpl-mainnet", takerGets: Asset, takerPays: Asset): Offer[]', tier: 't2_realtime' },
  { method: 'xrplAmmInfo', services: ['xrpl'], description: 'XRPL Automated Market Maker (AMM) pool state.', signature: 'xrplAmmInfo(chain: "xrpl-mainnet", asset: Asset, asset2: Asset): Amm', tier: 't2_realtime' },
  { method: 'xrplTx', services: ['xrpl'], description: 'XRPL transaction detail by hash.', signature: 'xrplTx(chain: "xrpl-mainnet", txHash: string): Txn', tier: 't1_read' },
  { method: 'xrplLedger', services: ['xrpl'], description: 'XRPL ledger header + metadata.', signature: 'xrplLedger(chain: "xrpl-mainnet", ledgerIndex?: string): Ledger', tier: 't1_read' },
  // ── Flare (keyless public RPC + FTSO free oracle) — M2 FEATURE_MCP_FLARE_V1 ─
  { method: 'flareFtsoFeed', services: ['flare'], description: 'FTSOv2 block-latency price feed (free 1000-feed decentralized oracle) by feed name or bytes21 id.', signature: 'flareFtsoFeed(chain: "flare-mainnet", feed: string): { price: number, value: string, decimals: number, timestamp: number }', tier: 't2_realtime' },
  { method: 'flareFtsoAnchor', services: ['flare'], description: 'FTSO anchor / custom-feed value (FIP.13) by feed name + category.', signature: 'flareFtsoAnchor(chain: "flare-mainnet", feed: string, category?: string): FeedValue', tier: 't2_realtime' },
  { method: 'flareFassetsFxrp', services: ['flare'], description: 'FXRP mint capacity + collateral state (FAssets AssetManager). Corpus-grounded until interface verified.', signature: 'flareFassetsFxrp(chain: "flare-mainnet"): FxrpState', tier: 't1_read' },
  { method: 'flareFassetsAgents', services: ['flare'], description: 'FAssets agent registry (AgentOwnerRegistry). Corpus-grounded until interface verified.', signature: 'flareFassetsAgents(chain: "flare-mainnet"): Agent[]', tier: 't1_read' },
  { method: 'flareFdcAttestation', services: ['flare'], description: 'FDC V2 attestation state (4 types). Corpus-grounded until interface verified.', signature: 'flareFdcAttestation(chain: "flare-mainnet"): AttestationState', tier: 't1_read' },
  { method: 'flareFccStatus', services: ['flare'], description: 'FCC confidential-compute + PMW availability status. Corpus-grounded until interface verified.', signature: 'flareFccStatus(chain: "flare-mainnet"): FccStatus', tier: 't1_read' },
  // GOAT Network (M3) — generic EVM reads + GOAT-native methods
  { method: 'goat.ethCall', services: ['goat'], description: 'Generic EVM eth_call on GOAT (goat-geth RPC).', signature: 'goat.ethCall(chain: "goat-mainnet", to: Address, data: Hex): Hex', tier: 't2_realtime' },
  { method: 'goat.yieldRate', services: ['goat'], description: 'Native BTC-denominated yield rate + source. Corpus-grounded until BitVM2 contract verified.', signature: 'goat.yieldRate(chain: "goat-mainnet"): { rate: number | null, source: string }', tier: 't1_read' },
  { method: 'goat.settlementStatus', services: ['goat'], description: 'BitVM2 settlement finality status (Bitcoin-secured). Corpus-grounded until contract verified.', signature: 'goat.settlementStatus(chain: "goat-mainnet"): { status: string, source: string }', tier: 't1_read' },
  { method: 'goat.identity', services: ['goat'], description: 'ERC-8004 agent identity + reputation on GOAT. Corpus-grounded until contract verified.', signature: 'goat.identity(chain: "goat-mainnet", agent?: Address): { identity: unknown, source: string }', tier: 't1_read' },
  { method: 'goat.lendingPosition', services: ['goat'], description: 'BTC-collateral position + available USDC borrow. Corpus-grounded until n-payment integration wired.', signature: 'goat.lendingPosition(chain: "goat-mainnet"): { position: unknown, source: string }', tier: 't1_read' },
  // XRPL deepening (M1) — MPT, vault, lending+amendment, amendments
  { method: 'xrplMptIssuance', services: ['xrpl'], description: 'Multi-Purpose Token (XLS-33) issuance state: outstanding amount, flags, holder count.', signature: 'xrplMptIssuance(chain: "xrpl-mainnet", issuanceID: string): MptIssuance', tier: 't1_read' },
  { method: 'xrplVaultInfo', services: ['xrpl'], description: 'XLS-65 single-asset-vault state (shares = MPTs), supplied/liquid balances. Amendment-dependent.', signature: 'xrplVaultInfo(chain: "xrpl-mainnet", vaultID: string): VaultInfo', tier: 't1_read' },
  { method: 'xrplLendingStatus', services: ['xrpl'], description: 'XLS-66 lending protocol state + amendment-vote status. Returns "not_yet_mainnet" if amendment inactive.', signature: 'xrplLendingStatus(chain: "xrpl-mainnet", poolID?: string): LendingStatus', tier: 't1_read' },
  { method: 'xrplAmendments', services: ['xrpl'], description: 'Enabled + in-voting amendments (fixCleanup, XLS-65/66). Feature-gate awareness.', signature: 'xrplAmendments(chain: "xrpl-mainnet"): { enabled: string[], voting: { amendment: string, support: number }[] }', tier: 't1_read' },
];

function tokenize(...parts: string[]): string[] {
  return Array.from(
    new Set(
      parts
        .join(' ')
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 1),
    ),
  ).sort();
}

let cached: CatalogEntry[] | null = null;

/** The unified catalog — deterministic + memoized. */
export function getCatalog(): CatalogEntry[] {
  if (cached) return cached;
  const entries: CatalogEntry[] = [];

  for (const spec of METHOD_MANIFEST) {
    for (const service of spec.services) {
      entries.push({
        id: `${service}.${spec.method}`,
        service,
        kind: 'operation',
        description: spec.description,
        keywords: tokenize(service, spec.method, spec.description),
        signature: spec.signature,
        priceTier: spec.tier,
      });
    }
  }

  for (const c of CHAINS) {
    entries.push({
      id: `chain.${c.id}`,
      service: 'hypermove',
      chain: c.id,
      kind: 'chain',
      description: `${c.name} (${c.kind}, ${c.tier}) — supported cross-chain network.`,
      keywords: tokenize(c.id, c.name, c.kind, c.tier),
      priceTier: 't1_read',
    });
  }

  for (const p of PROTOCOLS) {
    entries.push({
      id: `protocol.${p.id}`,
      service: 'npayment',
      kind: 'protocol',
      description: `${p.name} — ${p.summary}`,
      keywords: tokenize(p.id, p.name, p.summary),
      priceTier: 't1_read',
    });
  }

  cached = entries.sort((a, b) => a.id.localeCompare(b.id));
  return cached;
}

/** Test hook. */
export function _resetCatalog(): void {
  cached = null;
}
