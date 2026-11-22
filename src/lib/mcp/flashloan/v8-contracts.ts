import { z } from 'zod';
import { address, bytes32, evmNetwork, CHAINS } from './networks';
import { uint, digest } from './contracts';

export const v8Enabled = (name: 'INVENTORY_V3' | 'MOVERS_V2' | 'WATCHLIST_V1' | 'REGISTRY_V1') => process.env['FLASHLOAN_' + name] === 'true';
export const familySchema = z.enum(['V2', 'SOLIDLY_VOLATILE', 'SOLIDLY_STABLE', 'V3', 'ALGEBRA', 'V4', 'CURVE', 'BALANCER', 'OTHER']);
export const usdSchema = z.string().max(128).regex(/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/);
export const assetIdSchema = z.string().regex(/^eip155:(?:1|8453|42161|4663)\/(?:erc20:0x[0-9a-f]{40}|slip44:60)$/);
export const assetId = (network: z.infer<typeof evmNetwork>, token: string) => 'eip155:' + CHAINS[network] + (token === '0x' + '0'.repeat(40) ? '/slip44:60' : '/erc20:' + address.parse(token));
export const poolKeyV8Schema = z.object({ currency0: address, currency1: address, fee: z.union([z.number().int().min(0).max(1000000), z.literal(0x800000)]), tickSpacing: z.number().int().min(1).max(32767), hooks: address }).strict().refine((k) => BigInt(k.currency0) < BigInt(k.currency1), 'Currencies must be ordered.');
export const referenceV8Schema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('evm_contract'), chainId: z.number().int().positive(), address }).strict(),
  z.object({ kind: z.literal('evm_v4'), chainId: z.number().int().positive(), manager: address, poolId: bytes32 }).strict(),
  z.object({ kind: z.literal('provider_opaque'), network: evmNetwork, provider: z.string().max(128), providerPoolId: z.string().max(1024) }).strict(),
]);
const count = z.number().int().nonnegative();
export const sourceResultSchema = z.object({ source: z.string(), status: z.enum(['SUCCESS', 'FAILED', 'UNSUPPORTED']), raw_count: count, valid_count: count, truncated: z.boolean(), reason: z.string().nullable() }).strict();
export const coverageV8Schema = z.object({ exhaustive: z.literal(false), source_results: z.array(sourceResultSchema).max(128), tokens_considered: count, tokens_watched: count, pools_considered: count, pools_watched: count, excluded_counts: z.record(z.string(), count), deferred_counts: z.record(z.string(), count), truncated: z.boolean() }).strict();
export type CoverageV8 = z.infer<typeof coverageV8Schema>;
export function emptyCoverage(): CoverageV8 { return { exhaustive: false, source_results: [], tokens_considered: 0, tokens_watched: 0, pools_considered: 0, pools_watched: 0, excluded_counts: {}, deferred_counts: {}, truncated: false }; }
export const blockV8Schema = z.object({ number: uint, hash: bytes32, timestamp: uint }).strict();
export const valuationSchema = z.object({ value: usdSchema, source: z.string(), observed_at: z.string().datetime() }).strict();
export const assetMetadataSchema = z.object({ asset_id: assetIdSchema, address: address.nullable(), decimals: z.number().int().min(0).max(36).nullable(), usd_price: valuationSchema.nullable() }).strict();
const capability = z.object({ status: z.enum(['available', 'unverified', 'unsupported', 'simulation_only']), reason: z.string() }).strict();
export const inventoryPoolV3Schema = z.object({
  id: digest, reference: referenceV8Schema, asset_ids: z.tuple([assetIdSchema, assetIdSchema]), protocol: z.string(), family: familySchema, labels: z.array(z.string()).max(32),
  pool_key: poolKeyV8Schema.optional(), hook: z.object({ address, code_hash: bytes32, allowlisted: z.boolean() }).strict().optional(), fee_mode: z.enum(['static', 'dynamic', 'hooked', 'unknown']),
  state: z.object({ block: uint, block_hash: bytes32, sqrt_price_x96: uint.optional(), tick: z.number().int().min(-887272).max(887272).optional(), active_liquidity: uint.optional(), reserve0: uint.optional(), reserve1: uint.optional(), lp_fee_pips: z.number().int().min(0).max(1000000).optional() }).strict().optional(),
  depth: z.object({ reported_liquidity_usd: usdSchema.nullable(), virtual_depth_usd: usdSchema.nullable() }).strict(),
  flags: z.object({ zero_active_liquidity: z.boolean(), stale_price_suspect: z.boolean() }).strict(), liquidity_eligible: z.boolean().nullable(), eligibility_reasons: z.array(z.string()).max(32),
  capabilities: z.object({ state: capability, quote: capability, funding: capability, simulation: capability }).strict(),
  provenance: z.array(z.object({ source: z.string(), provider_pool_id: z.string().max(1024), observed_at: z.string().datetime() }).strict()).max(16),
}).strict();
export type InventoryPoolV3 = z.infer<typeof inventoryPoolV3Schema>;
export const inventoryV3Schema = z.object({ schema_version: z.literal('flashloan.inventory.v3'), network: evmNetwork, chain_id: z.number().int(), observed_at: z.string().datetime(), block: blockV8Schema.nullable(), registry_version: digest, outcome: z.enum(['SUCCESS', 'EMPTY', 'PARTIAL']), assets: z.array(assetMetadataSchema).max(860), pools: z.array(inventoryPoolV3Schema).max(400), token_results: z.array(z.object({ token_id: assetIdSchema, disposition: z.enum(['INCLUDED', 'EXCLUDED']), pool_ids: z.array(digest), discovered_count: count, liquidity_eligible_count: count }).strict()).max(60), coverage: coverageV8Schema, warnings: z.array(z.string()) }).strict();
export type InventoryV3 = z.infer<typeof inventoryV3Schema>;
export const discoveryV3InputSchema = z.object({ network: evmNetwork, tokens: z.array(address).min(1).max(30), exclude_tokens: z.array(address).max(30).default([]), min_liquidity_usd: z.number().finite().min(0).max(1e30).default(15000) }).strict();
export const moversV2InputSchema = z.object({ networks: z.array(evmNetwork).min(1).max(4).refine((v) => new Set(v).size === v.length, 'Duplicate networks.').default(['base', 'arbitrum', 'robinhood']), limit_per_chain: z.number().int().min(1).max(30).default(30), min_liquidity_usd: z.number().finite().min(0).max(1e30).default(5000), seed_tokens: z.partialRecord(evmNetwork, z.array(address).max(30)).default({}), exclude_tokens: z.partialRecord(evmNetwork, z.array(address).max(30)).default({}) }).strict().superRefine((v, ctx) => { for (const entries of [v.seed_tokens, v.exclude_tokens]) for (const key of Object.keys(entries)) if (!v.networks.includes(key as z.infer<typeof evmNetwork>)) ctx.addIssue({ code: 'custom', message: 'Token network was not requested.' }); });
const nullableSignal = z.number().finite().nullable();
export const moverTokenV2Schema = z.object({ rank: count, token_id: assetIdSchema, symbol: z.string().max(128).nullable(), name: z.string().max(256).nullable(), sources: z.array(z.string()), signals: z.object({ change_m5_pct: nullableSignal, change_h1_pct: nullableSignal, change_h24_pct: nullableSignal, volume_m5_usd: usdSchema.nullable(), volume_h24_usd: usdSchema.nullable(), volume_spike_z: nullableSignal, buys_m5: count.nullable(), sells_m5: count.nullable(), imbalance_m5: nullableSignal, pools_with_active_liquidity: count, venues: count, age_hours: nullableSignal, paid_visibility_only: z.boolean(), socials_declared: z.array(z.string()).max(16) }).strict(), missing_signals: z.array(z.string()), exclusions: z.array(z.string()), score: z.number().finite() }).strict();
export const moversV2Schema = z.object({ schema_version: z.literal('flashloan.movers.v2'), started_at: z.string().datetime(), completed_at: z.string().datetime(), parameters: moversV2InputSchema, chains: z.array(z.object({ network: evmNetwork, chain_id: z.number().int(), outcome: z.enum(['SUCCESS', 'EMPTY', 'PARTIAL']), tokens: z.array(moverTokenV2Schema).max(30), dispositions: z.array(z.object({ token_id: assetIdSchema, exclusions: z.array(z.string()) }).strict()).max(60), coverage: coverageV8Schema }).strict()).max(4), warnings: z.array(z.string()) }).strict();
export const watchlistInputSchema = z.object({ network: evmNetwork, max_tokens: z.number().int().min(1).max(30).default(30), max_pools: z.number().int().min(2).max(400).default(400), min_virtual_depth_usd: z.number().finite().min(0).max(1e30).default(5000), seed_tokens: z.array(address).max(30).default([]), exclude_tokens: z.array(address).max(30).default([]) }).strict();
export const watchlistV1Schema = z.object({ schema_version: z.literal('flashloan.watchlist.v1'), network: evmNetwork, chain_id: z.number().int(), observed_at: z.string().datetime(), block: blockV8Schema.nullable(), registry_version: digest, ttl_seconds: z.literal(120), outcome: z.enum(['SUCCESS', 'EMPTY', 'PARTIAL']), tokens: z.array(z.object({ token_id: assetIdSchema, score: z.number().finite(), reasons: z.array(z.string()) }).strict()).max(30), pools: z.array(inventoryPoolV3Schema).max(400), assets: z.array(assetMetadataSchema).max(860), anchors: z.array(assetIdSchema).max(30), coverage: coverageV8Schema, warnings: z.array(z.string()) }).strict();
export const registryInputSchema = z.object({ networks: z.array(evmNetwork).min(1).max(4).refine((v) => new Set(v).size === v.length).optional() }).strict();

/** Exported schemas are the wire authority; the SDK receives the same full objects. */
export function v8DocumentSchemas() { return { inventory: z.toJSONSchema(inventoryV3Schema, { io: 'input' }), movers: z.toJSONSchema(moversV2Schema, { io: 'input' }), watchlist: z.toJSONSchema(watchlistV1Schema, { io: 'input' }) }; }
