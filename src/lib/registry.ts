/**
 * src/lib/registry.ts
 * --------------------
 * Single source of truth for chains and payment protocols.
 * Consumers (<ChainBadge>, <ProtocolBadge>, ChainPicker, code pickers) MUST NOT
 * hard-code any chain/protocol metadata. They read from these exports.
 *
 * SOLID:
 *  - Open/Closed: add a new chain by appending to CHAINS; no consumer changes needed.
 *  - Interface Segregation: Chain and Protocol are minimal type contracts.
 */

export type ChainTier = 'mainnet' | 'testnet';
export type ChainKind = 'evm' | 'svm' | 'move' | 'cosmos' | 'btc' | 'xrpl' | 'stellar';

export interface Chain {
  /** CAIP-2-style slug used in code samples. */
  id: string;
  name: string;
  tier: ChainTier;
  kind: ChainKind;
  /** EVM chain ID where applicable. */
  chainId?: number;
  /** Hero color for the badge (Tailwind class token, NOT a hex). */
  accent: 'primary' | 'secondary' | 'tertiary' | 'error';
  /** True if covered by n-payment v0.29.1. */
  supported: boolean;
}

export const CHAINS: readonly Chain[] = [
  { id: 'goat-mainnet',      name: 'GOAT Network',     tier: 'mainnet', kind: 'evm',     chainId: 2345,  accent: 'primary',   supported: true },
  { id: 'base-mainnet',      name: 'Base',             tier: 'mainnet', kind: 'evm',     chainId: 8453,  accent: 'secondary', supported: true },
  { id: 'base-sepolia',      name: 'Base Sepolia',     tier: 'testnet', kind: 'evm',     chainId: 84532, accent: 'secondary', supported: true },
  { id: 'arbitrum-mainnet',  name: 'Arbitrum One',     tier: 'mainnet', kind: 'evm',     chainId: 42161, accent: 'secondary', supported: true },
  { id: 'optimism-mainnet',  name: 'Optimism',         tier: 'mainnet', kind: 'evm',     chainId: 10,    accent: 'primary',   supported: true },
  { id: 'polygon-mainnet',   name: 'Polygon',          tier: 'mainnet', kind: 'evm',     chainId: 137,   accent: 'primary',   supported: true },
  { id: 'celo-mainnet',      name: 'Celo',             tier: 'mainnet', kind: 'evm',     chainId: 42220, accent: 'tertiary',  supported: true },
  { id: 'flare-mainnet',     name: 'Flare',            tier: 'mainnet', kind: 'evm',     chainId: 14,    accent: 'error',     supported: true },
  { id: 'initia-mainnet',    name: 'Initia',           tier: 'mainnet', kind: 'cosmos',  accent: 'primary',   supported: true },
  { id: 'morph-mainnet',     name: 'Morph',            tier: 'mainnet', kind: 'evm',     chainId: 2818,  accent: 'tertiary',  supported: true },
  { id: 'xrpl-mainnet',      name: 'XRPL',             tier: 'mainnet', kind: 'xrpl',    accent: 'secondary', supported: true },
  { id: 'stellar-mainnet',   name: 'Stellar',          tier: 'mainnet', kind: 'stellar', accent: 'primary',   supported: true },
  { id: 'solana-mainnet',    name: 'Solana',           tier: 'mainnet', kind: 'svm',     accent: 'tertiary',  supported: true },
  { id: 'sui-mainnet',       name: 'Sui',              tier: 'mainnet', kind: 'move',    accent: 'secondary', supported: true },
];

export interface Protocol {
  id: string;
  name: string;
  /** Short tag-line used in the matrix table. */
  summary: string;
  /** Which chains it works on (chain IDs from CHAINS). */
  chains: readonly string[];
  accent: 'primary' | 'secondary' | 'tertiary' | 'error';
}

export const PROTOCOLS: readonly Protocol[] = [
  { id: 'x402',            name: 'x402',                 summary: 'HTTP 402 + WWW-Authenticate handshake',           chains: ['goat-mainnet','base-mainnet','base-sepolia','arbitrum-mainnet','optimism-mainnet'], accent: 'primary' },
  { id: 'eip-3009',        name: 'EIP-3009',             summary: 'Authorized USDC transfer (no gas to agent)',      chains: ['base-mainnet','base-sepolia','arbitrum-mainnet','polygon-mainnet'], accent: 'primary' },
  { id: 'mpp',             name: 'MPP',                  summary: 'Multi-Party Payment for split settlements',       chains: ['goat-mainnet','base-mainnet'], accent: 'secondary' },
  { id: 'stellar-channels',name: 'Stellar Channels',     summary: 'Sub-cent micropayments off-chain settle',         chains: ['stellar-mainnet'], accent: 'tertiary' },
  { id: 'wormhole-ntt',    name: 'Wormhole NTT',         summary: 'Native Token Transfers across 30+ chains',        chains: ['base-mainnet','arbitrum-mainnet','solana-mainnet','sui-mainnet'], accent: 'secondary' },
  { id: 'circle-gateway',  name: 'Circle Gateway',       summary: 'USDC mint/burn via Circle native bridge',         chains: ['base-mainnet','arbitrum-mainnet','optimism-mainnet','polygon-mainnet','solana-mainnet'], accent: 'primary' },
  { id: 'rlusd',           name: 'RLUSD',                summary: 'Ripple-issued USD stablecoin on XRPL + EVM',      chains: ['xrpl-mainnet','base-mainnet'], accent: 'tertiary' },
  { id: 'xrpl-x402',       name: 'XRPL x402',            summary: 'XRPL-native 402 paywall via MPT',                 chains: ['xrpl-mainnet'], accent: 'secondary' },
  { id: 'erc-8004',        name: 'ERC-8004',             summary: 'Agent identity + reputation registry',            chains: ['base-mainnet','celo-mainnet','arbitrum-mainnet'], accent: 'primary' },
  { id: 'aave-v3',         name: 'Aave V3 GHO',          summary: 'Idle USDC treasury yield',                        chains: ['base-mainnet','arbitrum-mainnet'], accent: 'tertiary' },
  { id: 'ows',             name: 'OWS Vault',            summary: 'Agent never touches a private key',               chains: CHAINS.map((c) => c.id), accent: 'primary' },
  { id: 'peg-btc',         name: 'PegBTC Lending',       summary: 'Lock BTC, borrow USDC just-in-time',              chains: ['goat-mainnet'], accent: 'secondary' },
  { id: 'flare-fxrp',      name: 'Flare FXRP',           summary: 'Bridged XRP as gas + asset on Flare',             chains: ['flare-mainnet'], accent: 'error' },
  { id: 'initia-vip',      name: 'Initia VIP',           summary: 'Validator-Incentive-Pool USDC settlement',        chains: ['initia-mainnet'], accent: 'tertiary' },
];

export function chainById(id: string): Chain | undefined {
  return CHAINS.find((c) => c.id === id);
}
export function protocolById(id: string): Protocol | undefined {
  return PROTOCOLS.find((p) => p.id === id);
}
