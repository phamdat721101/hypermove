import { z } from 'zod';
import { address, bytes32, evmNetwork } from './networks';
import { hash, ResearchError } from './contracts';
import { assetIdSchema, familySchema, poolKeyV8Schema, referenceV8Schema, emptyCoverage, coverageV8Schema } from './v8-contracts';

const status = z.enum(['reviewed', 'research']);
const venueSchema = z.object({ id: z.string().min(1).max(128), provider_ids: z.array(z.string().max(128)).max(16).default([]), family: familySchema, factory: address, factory_code_hash: bytes32, pool_code_hash: bytes32.optional(), pool_lookup: z.enum(['getPair', 'getPoolFee', 'getPoolSpacing', 'poolByPair', 'getPoolStable']).optional(), state_view: address.optional(), state_view_code_hash: bytes32.optional(), initialization_block: z.string().regex(/^(0|[1-9][0-9]*)$/).optional(), quoter_kind: z.enum(['exact_override', 'v4_state_quoter', 'onchain_quoter']), cpmm: z.boolean(), status }).strict();
const lenderSchema = z.object({ id: z.string().max(128), kind: z.enum(['morpho', 'balancer_v2', 'balancer_v3', 'aave_v3', 'v3_flash', 'v4_flash']), address, code_hash: bytes32, fee_bps: z.number().finite().nonnegative(), callback: z.string().max(128), assets: z.union([z.literal('any'), z.array(assetIdSchema).max(100)]) }).strict();
const converterSchema = z.object({ id: z.string().max(128), kind: z.enum(['erc4626', 'lst_wrap', 'index_redeem', 'pt_yt', 'other']), address, preview_fn: z.string().max(128), status }).strict();
const hookSchema = z.object({ address, code_hash: bytes32, status: z.enum(['allowlisted', 'research']), reviewed_at: z.string().datetime() }).strict();
const targetSchema = z.object({ id: z.string().max(128), kind: z.string().max(128), address, status: z.literal('research') }).strict();
const executorSchema = z.object({ id: z.string().max(128), address, code_hash: bytes32, venues: z.array(z.string()).max(100), lenders: z.array(z.string()).max(100) }).strict();
export const registryNetworkSchema = z.object({ venues: z.array(venueSchema).max(100).default([]), lenders: z.array(lenderSchema).max(100).default([]), converters: z.array(converterSchema).max(100).default([]), hooks: z.array(hookSchema).max(100).default([]), liquidation_targets: z.array(targetSchema).max(100).default([]), executors: z.array(executorSchema).max(100).default([]), anchors: z.array(assetIdSchema).max(30).default([]) }).strict();
const seedSchema = z.object({ network: evmNetwork, venue_id: z.string(), reference: referenceV8Schema, asset_ids: z.tuple([assetIdSchema, assetIdSchema]), pool_key: poolKeyV8Schema.optional() }).strict();
export const discoveryRegistryConfigSchema = z.object({ networks: z.partialRecord(evmNetwork, registryNetworkSchema).default({}), pools: z.array(seedSchema).max(1600).default([]), score_weights: z.object({ volume_spike: z.number().finite().nonnegative().default(1), imbalance: z.number().finite().nonnegative().default(0.8), liquidity: z.number().finite().nonnegative().default(1.2), venues: z.number().finite().nonnegative().default(0.6), change: z.number().finite().nonnegative().default(0.5), paid_penalty: z.number().finite().nonnegative().default(2) }).strict().default({ volume_spike: 1, imbalance: 0.8, liquidity: 1.2, venues: 0.6, change: 0.5, paid_penalty: 2 }) }).strict().superRefine((value, ctx) => {
  for (const [network, config] of Object.entries(value.networks)) {
    const prefix = 'eip155:' + ({ ethereum: 1, base: 8453, arbitrum: 42161, robinhood: 4663 } as Record<string, number>)[network] + '/';
    for (const category of ['venues', 'lenders', 'converters', 'hooks', 'liquidation_targets', 'executors'] as const) {
      const ids = config[category].map((item) => 'id' in item ? item.id : item.address);
      if (new Set(ids).size !== ids.length) ctx.addIssue({ code: 'custom', message: 'Duplicate registry identifier in ' + network + '.' + category });
    }
    for (const anchor of config.anchors) if (!anchor.startsWith(prefix)) ctx.addIssue({ code: 'custom', message: 'Anchor chain mismatch.' });
    for (const venue of config.venues) if (venue.family === 'V4' && (!venue.state_view || !venue.state_view_code_hash)) ctx.addIssue({ code: 'custom', message: 'V4 venue requires StateView evidence.' });
    const aliasOwners = new Map<string, string>();
    for (const venue of config.venues) for (const alias of new Set([venue.id, ...venue.provider_ids])) { const key = alias + ':' + (venue.family === 'V4' ? 'v4_id' : 'contract'); const owner = aliasOwners.get(key); if (owner && owner !== venue.id) ctx.addIssue({ code: 'custom', message: 'Ambiguous provider alias ' + alias + ' in ' + network }); aliasOwners.set(key, venue.id); }
  }
  const seen = new Set<string>();
  for (const seed of value.pools) {
    const config = value.networks[seed.network];
    const venue = config?.venues.find((v) => v.id === seed.venue_id);
    const chain = ({ ethereum: 1, base: 8453, arbitrum: 42161, robinhood: 4663 } as const)[seed.network];
    const id = hash(seed.reference);
    if (!venue || seen.has(id) || seed.reference.kind === 'provider_opaque' || seed.reference.chainId !== chain || seed.asset_ids.some((a) => !a.startsWith('eip155:' + chain + '/')) || new Set(seed.asset_ids).size !== 2 || (seed.reference.kind === 'evm_v4') !== (venue?.family === 'V4')) ctx.addIssue({ code: 'custom', message: 'Invalid or conflicting registry pool seed.' });
    seen.add(id);
  }
});
export type DiscoveryRegistryConfig = z.infer<typeof discoveryRegistryConfigSchema>;
export type Venue = z.infer<typeof venueSchema>;
export type RegistrySeed = z.infer<typeof seedSchema>;
export const registryV1Schema = z.object({ schema_version: z.literal('flashloan.registry.v1'), registry_version: z.string().regex(/^[a-f0-9]{64}$/), observed_at: z.string().datetime(), networks: z.partialRecord(evmNetwork, registryNetworkSchema), coverage: coverageV8Schema, warnings: z.array(z.string()) }).strict();

/** Config is bounded and normalized before hashing; response filters never change its version. */
export class DiscoveryRegistry {
  readonly config: DiscoveryRegistryConfig;
  readonly version: string;
  constructor(raw: unknown = {}) {
    this.config = discoveryRegistryConfigSchema.parse(raw);
    for (const config of Object.values(this.config.networks)) {
      for (const category of ['venues', 'lenders', 'converters', 'hooks', 'liquidation_targets', 'executors'] as const) config[category].sort((a, b) => ('id' in a ? a.id : a.address).localeCompare('id' in b ? b.id : b.address));
      config.anchors.sort();
      config.venues.forEach((v) => v.provider_ids.sort());
      config.executors.forEach((v) => { v.venues.sort(); v.lenders.sort(); });
      config.lenders.forEach((v) => { if (Array.isArray(v.assets)) v.assets.sort(); });
    }
    this.config.pools.sort((a, b) => hash(a.reference).localeCompare(hash(b.reference)));
    this.version = hash({ schema_version: 'flashloan.registry.v1', networks: this.config.networks });
  }
  network(network: z.infer<typeof evmNetwork>) { return this.config.networks[network] ?? registryNetworkSchema.parse({}); }
  document(networks?: z.infer<typeof evmNetwork>[]) {
    const coverage = emptyCoverage();
    const selected = networks ?? Object.keys(this.config.networks) as z.infer<typeof evmNetwork>[];
    for (const network of selected) coverage.source_results.push({ source: 'registry:' + network, status: this.config.networks[network] ? 'SUCCESS' : 'UNSUPPORTED', raw_count: this.network(network).venues.length, valid_count: this.network(network).venues.length, truncated: false, reason: this.config.networks[network] ? null : 'NETWORK_UNCONFIGURED' });
    return registryV1Schema.parse({ schema_version: 'flashloan.registry.v1', registry_version: this.version, observed_at: new Date().toISOString(), networks: Object.fromEntries(selected.filter((n) => this.config.networks[n]).map((n) => [n, this.config.networks[n]])), coverage, warnings: ['Discovery only. Consumers must use their own reviewed execution configuration.'] });
  }
}

export function parseDiscoveryRegistry(raw?: string) {
  try { return new DiscoveryRegistry(raw ? JSON.parse(raw) : {}); }
  catch { throw new ResearchError('REGISTRY_UNCONFIGURED', 'Invalid FLASHLOAN_DISCOVERY_REGISTRY; supply a bounded reviewed discovery registry.'); }
}
