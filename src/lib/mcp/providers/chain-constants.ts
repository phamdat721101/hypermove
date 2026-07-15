/**
 * src/lib/mcp/providers/chain-constants.ts
 * ----------------------------------------
 * Pinned, source-labeled network constants for the v3.0 Flare + GOAT adapters.
 * Every value here was verified against a live official source on 2026-07-15
 * (see the inline source URL). Keeping them in ONE file is the T1-drift
 * mitigation: if a value ever changes, re-verify + edit here only.
 *
 * Design note: FTSO feed *addresses* are resolved at runtime through the
 * FlareContractRegistry (same address on every Flare network) rather than
 * hard-coded per network — the registry is the "only trusted source for
 * resolving official protocol contract addresses" (dev.flare.network), so this
 * survives FtsoV2 redeploys with zero code change.
 */

/** Flare EVM chain-IDs. Source: dev.flare.network/network/overview (2026-07-15). */
export const FLARE_CHAIN_IDS: Record<string, number> = {
  flare: 14, // Flare Mainnet
  coston2: 114, // Flare Testnet Coston2
  songbird: 19, // Songbird Canary-Network
};

/** Public keyless RPC per Flare network. Source: dev.flare.network/network/overview. */
export const FLARE_RPC: Record<string, string> = {
  flare: 'https://flare-api.flare.network/ext/C/rpc',
  coston2: 'https://coston2-api.flare.network/ext/C/rpc',
  songbird: 'https://songbird-api.flare.network/ext/C/rpc',
};

/**
 * FlareContractRegistry — identical address on ALL Flare networks; resolves
 * FtsoV2 / AssetManager / FdcHub by name via getContractAddressByName(string).
 * Source: dev.flare.network/network/solidity-reference (2026-07-15).
 */
export const FLARE_CONTRACT_REGISTRY = '0xaD67FE66660Fb8dFE9d6b1b4240d8650e30F6019';

/**
 * Known FtsoV2 fallback address (Coston2), used only if a registry lookup
 * fails. Source: dev.flare.network/ftso/guides/read-feeds-offchain (2026-07-15).
 */
export const FTSOV2_FALLBACK: Record<string, string> = {
  coston2: '0x3d893C53D9e8056135C26C8c638B76C8b60Df726',
};

/**
 * Verified FTSO feed-IDs (bytes21). Source:
 * dev.flare.network/ftso/scaling/anchor-feeds (2026-07-15).
 * Any other feed can be derived deterministically via deriveFeedId().
 */
export const FTSO_FEED_IDS: Record<string, string> = {
  'FLR/USD': '0x01464c522f55534400000000000000000000000000',
  'BTC/USD': '0x014254432f55534400000000000000000000000000',
  'XRP/USD': '0x015852502f55534400000000000000000000000000',
  'ETH/USD': '0x014554482f55534400000000000000000000000000',
  'XLM/USD': '0x01584c4d2f55534400000000000000000000000000',
};

/** FTSO feed category codes. Source: anchor-feeds derivation spec (2026-07-15). */
export const FTSO_CATEGORY = { crypto: '01', forex: '02', commodity: '03', stock: '04', custom: '21' } as const;

/**
 * Derive a bytes21 FTSO feed-ID from a feed name, per the documented encoding:
 * category (2 hex) + hex(name) + zero-pad to 42 hex chars, 0x-prefixed.
 * Source: dev.flare.network/ftso/scaling/anchor-feeds (2026-07-15).
 */
export function deriveFeedId(feedName: string, category: string = FTSO_CATEGORY.crypto): string {
  const known = FTSO_FEED_IDS[feedName.toUpperCase()];
  if (known) return known;
  const hexName = Array.from(feedName)
    .map((c) => c.charCodeAt(0).toString(16).padStart(2, '0'))
    .join('');
  return `0x${(category + hexName).padEnd(42, '0')}`;
}

/** GOAT (goat-geth EVM) chain-IDs. Source: docs.goat.network/docs/build/networks-rpc (2026-07-15). */
export const GOAT_CHAIN_IDS: Record<string, number> = {
  goat: 2345, // GOAT Alpha Mainnet (native currency BTC)
  'goat-testnet': 48816, // GOAT Testnet3
};

/** GOAT public keyless RPC. Source: docs.goat.network/docs/build/networks-rpc (2026-07-15). */
export const GOAT_RPC: Record<string, string> = {
  goat: 'https://rpc.goat.network',
  'goat-testnet': 'https://rpc.testnet3.goat.network',
};
