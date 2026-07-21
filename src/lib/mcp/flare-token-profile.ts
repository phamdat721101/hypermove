/**
 * src/lib/mcp/flare-token-profile.ts
 * -----------------------------------
 * Implements the user-supplied "Token Profile" schema as a real MCP tool pair:
 * flare.token.save (compute + persist) and flare.token.profile (retrieve, computing
 * fresh if nothing is saved yet).
 *
 * Provenance discipline (per the PRD's Sub-PRD C, "Field-by-field provenance"):
 *  1. Live on-chain read, reusing an already-verified pattern (registry resolution,
 *     ERC-20 metadata, FTSO feed-ID derivation) — chainId, contractRegistryAddress,
 *     assetManagerAddress (for FAssets), erc20 metadata once an address is known,
 *     ftsoFeedId.
 *  2. Corpus-sourced reference data, honestly labeled — FAsset operational
 *     parameters (lot size, minting cap, fees, premium, max tickets), sourced from
 *     dev.flare.network/fassets/operational-parameters (fetched 2026-07-20, mainnet
 *     values). Mirrors flareFassetsBridgeStatus's existing corpus-not-live-read
 *     pattern in providers/flare.ts.
 *  3. Not yet determinable from any verified source — explicit null, never guessed.
 */

import { createPublicClient, http, parseAbi, type Address } from 'viem';
import { ok, fail, type ServiceResult } from './envelope';
import { isMcpTokenProfileEnabled } from '../platform-flag';
import { FLARE_CONTRACT_REGISTRY, FLARE_CHAIN_IDS, FLARE_RPC, deriveFeedId } from './providers/chain-constants';

export type TokenType = 'native' | 'fasset' | 'erc20';
export type FlareNetwork = 'flare' | 'coston2' | 'songbird' | 'coston';

export interface TokenProfile {
  identity: {
    tokenName: string;
    tokenSymbol: string;
    tokenType: TokenType;
    underlyingChain: string | null;
  };
  network: {
    flareNetwork: FlareNetwork;
    chainId: number;
    chainIdHex: string;
    contractAddress: string | null;
    assetManagerAddress: string | null;
    contractRegistryAddress: string;
  };
  metadata: {
    erc20Name: string | null;
    erc20Symbol: string | null;
    decimals: number | null;
    totalSupply: string | null;
    underlyingAssetName: string | null;
    underlyingAssetSymbol: string | null;
  };
  fassetParams: {
    lotSizeUnderlying: string | null;
    mintingCapUnderlying: string | null;
    mintingFeePercent: string | null;
    redemptionFeePercent: string | null;
    redemptionDefaultPremium: string | null;
    maxRedemptionTicketsPerRequest: number | null;
    fdcAttestationTypeUsed: string | null;
    coreVaultAddress: string | null;
  } | null;
  pricing: {
    priceFeedPair: string | null;
    ftsoFeedId: string | null;
  };
  usage: {
    isNativeCoin: boolean;
    isWrappedNative: boolean;
    isFasset: boolean;
    isOftCompatible: boolean;
    dappsOrVaults: string[] | null;
    notes: string | null;
  };
  sources: string[];
  computedAt: string;
}

/** Known-token identity map — extend deliberately per new token, never infer
 *  tokenType from a symbol pattern (WR-01: no clever heuristics for something a
 *  small explicit table handles safely). */
interface KnownTokenEntry {
  tokenType: TokenType;
  underlyingChain: string | null;
  isNativeCoin: boolean;
  isWrappedNative: boolean;
  isFasset: boolean;
  isOftCompatible: boolean;
  /** Registry name used for AssetManager lookup (FAssets only). */
  assetManagerRegistryName?: string;
  priceFeedPair: string | null;
}

const KNOWN_TOKENS: Record<string, KnownTokenEntry> = {
  FLR: { tokenType: 'native', underlyingChain: null, isNativeCoin: true, isWrappedNative: false, isFasset: false, isOftCompatible: false, priceFeedPair: 'FLR/USD' },
  WFLR: { tokenType: 'erc20', underlyingChain: null, isNativeCoin: false, isWrappedNative: true, isFasset: false, isOftCompatible: false, priceFeedPair: 'FLR/USD' },
  FXRP: { tokenType: 'fasset', underlyingChain: 'XRPL', isNativeCoin: false, isWrappedNative: false, isFasset: true, isOftCompatible: true, assetManagerRegistryName: 'AssetManager_XRP', priceFeedPair: 'XRP/USD' },
  FBTC: { tokenType: 'fasset', underlyingChain: 'Bitcoin', isNativeCoin: false, isWrappedNative: false, isFasset: true, isOftCompatible: false, assetManagerRegistryName: 'AssetManager_BTC', priceFeedPair: 'BTC/USD' },
  FDOGE: { tokenType: 'fasset', underlyingChain: 'Dogecoin', isNativeCoin: false, isWrappedNative: false, isFasset: true, isOftCompatible: false, assetManagerRegistryName: 'AssetManager_DOGE', priceFeedPair: null },
};

/** Corpus-sourced FAsset operational parameters — Flare Mainnet values, per
 *  dev.flare.network/fassets/operational-parameters (fetched 2026-07-20). NOT a
 *  live contract read (see module doc's provenance class 2). Extend deliberately
 *  when a new FAsset's real page values are fetched and cited — never guess. */
const FASSET_OPERATIONAL_PARAMS_CORPUS: Record<string, TokenProfile['fassetParams']> = {
  FXRP: {
    lotSizeUnderlying: '10 XRP',
    mintingCapUnderlying: '170M XRP',
    mintingFeePercent: '0.01%', // collateral reservation fee (CRF), mainnet
    redemptionFeePercent: '0.2%',
    redemptionDefaultPremium: '5%',
    maxRedemptionTicketsPerRequest: 20,
    fdcAttestationTypeUsed: 'XRPPayment',
    coreVaultAddress: null, // Core Vault XRPL address not independently verified this session — honest null, not guessed
  },
  FBTC: {
    lotSizeUnderlying: '0.0004 BTC',
    mintingCapUnderlying: null, // not fetched for BTC this session — honest null
    mintingFeePercent: null,
    redemptionFeePercent: null,
    redemptionDefaultPremium: null,
    maxRedemptionTicketsPerRequest: 20, // consistent across assets per the operational-parameters page
    fdcAttestationTypeUsed: null,
    coreVaultAddress: null,
  },
  FDOGE: {
    lotSizeUnderlying: '100 DOGE',
    mintingCapUnderlying: null,
    mintingFeePercent: null,
    redemptionFeePercent: null,
    redemptionDefaultPremium: null,
    maxRedemptionTicketsPerRequest: 20,
    fdcAttestationTypeUsed: null,
    coreVaultAddress: null,
  },
};

const REGISTRY_ABI = parseAbi(['function getContractAddressByName(string _name) view returns (address)']);
const ERC20_ABI = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
]);
const ASSET_MANAGER_ABI = parseAbi(['function fAsset() view returns (address)']);
const FASSET_ABI = parseAbi(['function assetName() view returns (string)', 'function assetSymbol() view returns (string)']);

function chainIdHex(chainId: number): string {
  return `0x${chainId.toString(16)}`;
}

async function computeTokenProfile(tokenSymbol: string, network: FlareNetwork): Promise<ServiceResult<TokenProfile>> {
  const symbol = tokenSymbol.toUpperCase();
  const known = KNOWN_TOKENS[symbol];
  if (!known) {
    return fail('flare-token-profile', `unknown token symbol: ${tokenSymbol}`, {
      code: 'unknown_token',
      hint: `known tokens: ${Object.keys(KNOWN_TOKENS).join(', ')}. Extend KNOWN_TOKENS in flare-token-profile.ts to add more (never inferred automatically).`,
    });
  }

  const chainId = FLARE_CHAIN_IDS[network] ?? FLARE_CHAIN_IDS.flare;
  const rpc = FLARE_RPC[network] ?? FLARE_RPC.flare;
  const client = createPublicClient({ transport: http(rpc) });
  const sources = [`dev.flare.network/network/guides/flare-contracts-registry (registry address, fetched 2026-07-20)`];

  let contractAddress: Address | null = null;
  let assetManagerAddress: Address | null = null;
  let underlyingAssetName: string | null = null;
  let underlyingAssetSymbol: string | null = null;

  if (known.tokenType === 'fasset' && known.assetManagerRegistryName) {
    try {
      assetManagerAddress = (await client.readContract({
        address: FLARE_CONTRACT_REGISTRY as Address,
        abi: REGISTRY_ABI,
        functionName: 'getContractAddressByName',
        args: [known.assetManagerRegistryName],
      })) as Address;
      if (assetManagerAddress && !/^0x0+$/.test(assetManagerAddress)) {
        sources.push('dev.flare.network/fxrp/token-interactions/fxrp-address (AssetManager -> fAsset() resolution pattern, fetched 2026-07-20)');
        contractAddress = (await client.readContract({ address: assetManagerAddress, abi: ASSET_MANAGER_ABI, functionName: 'fAsset' })) as Address;
        if (contractAddress && !/^0x0+$/.test(contractAddress)) {
          const [assetName, assetSymbol] = await Promise.all([
            client.readContract({ address: contractAddress, abi: FASSET_ABI, functionName: 'assetName' }) as Promise<string>,
            client.readContract({ address: contractAddress, abi: FASSET_ABI, functionName: 'assetSymbol' }) as Promise<string>,
          ]);
          underlyingAssetName = assetName;
          underlyingAssetSymbol = assetSymbol;
        }
      } else {
        assetManagerAddress = null;
      }
    } catch {
      // Registry lookup or fAsset() call failed — leave addresses null, never assume.
      assetManagerAddress = null;
      contractAddress = null;
    }
  }

  let erc20Name: string | null = null;
  let erc20Symbol: string | null = null;
  let decimals: number | null = null;
  let totalSupply: string | null = null;

  if (contractAddress) {
    try {
      const [name, sym, dec, supply] = await Promise.all([
        client.readContract({ address: contractAddress, abi: ERC20_ABI, functionName: 'name' }) as Promise<string>,
        client.readContract({ address: contractAddress, abi: ERC20_ABI, functionName: 'symbol' }) as Promise<string>,
        client.readContract({ address: contractAddress, abi: ERC20_ABI, functionName: 'decimals' }) as Promise<number>,
        client.readContract({ address: contractAddress, abi: ERC20_ABI, functionName: 'totalSupply' }) as Promise<bigint>,
      ]);
      erc20Name = name;
      erc20Symbol = sym;
      decimals = dec;
      totalSupply = supply.toString();
    } catch {
      // ERC-20 reads failed — leave metadata null, never fabricate.
    }
  }

  const ftsoFeedId = known.priceFeedPair ? deriveFeedId(known.priceFeedPair) : null;
  if (ftsoFeedId) sources.push('dev.flare.network/ftso/scaling/anchor-feeds (feed-ID derivation, fetched 2026-07-15)');

  const fassetParams = known.tokenType === 'fasset' ? FASSET_OPERATIONAL_PARAMS_CORPUS[symbol] ?? null : null;
  if (fassetParams) sources.push('dev.flare.network/fassets/operational-parameters (mainnet values, fetched 2026-07-20 — corpus-sourced, not a live contract read)');

  return ok({
    identity: {
      tokenName: erc20Name ?? symbol,
      tokenSymbol: symbol,
      tokenType: known.tokenType,
      underlyingChain: known.underlyingChain,
    },
    network: {
      flareNetwork: network,
      chainId,
      chainIdHex: chainIdHex(chainId),
      contractAddress,
      assetManagerAddress,
      contractRegistryAddress: FLARE_CONTRACT_REGISTRY,
    },
    metadata: {
      erc20Name,
      erc20Symbol,
      decimals,
      totalSupply,
      underlyingAssetName,
      underlyingAssetSymbol,
    },
    fassetParams,
    pricing: {
      priceFeedPair: known.priceFeedPair,
      ftsoFeedId,
    },
    usage: {
      isNativeCoin: known.isNativeCoin,
      isWrappedNative: known.isWrappedNative,
      isFasset: known.isFasset,
      isOftCompatible: known.isOftCompatible,
      dappsOrVaults: null, // not yet sourced from a verified corpus entry for this token
      notes: null,
    },
    sources,
    computedAt: new Date().toISOString(),
  });
}

/** Compute and persist a Token Profile. Table lives in db.ts's shared TABLE_DDL
 *  (hypermove_token_profiles) — reuses the existing withClient() pool/schema
 *  lifecycle helper rather than standing up a second pg.Pool (WR-04). */
export async function saveTokenProfile(input: { tokenSymbol: string; network?: FlareNetwork }): Promise<ServiceResult<TokenProfile>> {
  if (!isMcpTokenProfileEnabled()) {
    return fail('flare-token-profile', 'token profile tool disabled', { code: 'feature_disabled', hint: 'set FEATURE_MCP_TOKEN_PROFILE_V1=true' });
  }

  const network = input.network ?? 'flare';
  const computed = await computeTokenProfile(input.tokenSymbol, network);
  if (!computed.ok) return computed;

  const { withClient } = await import('../db');
  await withClient(async (client) => {
    await client.query(
      `INSERT INTO hypermove_token_profiles (token_symbol, flare_network, profile, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (token_symbol, flare_network) DO UPDATE SET profile = $3, updated_at = NOW()`,
      [computed.data.identity.tokenSymbol, network, JSON.stringify(computed.data)],
    );
  });
  // withClient() returns null (no-op) when DATABASE_URL is unset — this is the
  // expected dev/mock-first state, not an error; the computed profile is still
  // returned to the caller either way.

  return computed;
}

/** Retrieve a Token Profile — a previously saved one, or computed fresh if none
 *  exists yet (read-only: does not persist the freshly-computed result). */
export async function getTokenProfile(input: { tokenSymbol: string; network?: FlareNetwork }): Promise<ServiceResult<TokenProfile>> {
  if (!isMcpTokenProfileEnabled()) {
    return fail('flare-token-profile', 'token profile tool disabled', { code: 'feature_disabled' });
  }

  const network = input.network ?? 'flare';
  const { withClient } = await import('../db');
  const saved = await withClient(async (client) => {
    const { rows } = await client.query(
      `SELECT profile FROM hypermove_token_profiles WHERE token_symbol = $1 AND flare_network = $2`,
      [input.tokenSymbol.toUpperCase(), network],
    );
    return rows[0]?.profile as TokenProfile | undefined;
  });
  if (saved) return ok(saved);

  return computeTokenProfile(input.tokenSymbol, network);
}
