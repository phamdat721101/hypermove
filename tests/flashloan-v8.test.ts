// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { toFunctionSelector } from 'viem';
import Ajv from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { ResearchEngine } from '../src/lib/mcp/flashloan/engine';
import { DiscoveryRegistry, discoveryRegistryConfigSchema, registryV1Schema } from '../src/lib/mcp/flashloan/discovery-registry';
import { assetId, inventoryV3Schema, moversV2Schema, poolKeyV8Schema, v8DocumentSchemas, watchlistV1Schema } from '../src/lib/mcp/flashloan/v8-contracts';
import { publicOperationEnabled, publicSchemas, assertVersionEnabled } from '../src/lib/mcp/flashloan/public-contracts';
import { virtualDepth, decimalNumber } from '../src/lib/mcp/flashloan/inventory-v3';
import { hash } from '../src/lib/mcp/flashloan/contracts';
import { publicWireBytes, PUBLIC_LIMITS } from '../src/lib/mcp/flashloan/public-contracts';
import { boundedEvmLogs, JsonClient } from '../src/lib/mcp/flashloan/transport';
import { fixtureV8, A8, Q8, F8, BLOCK8, type FixtureFault } from './fixtures/flashloan-v8';

afterEach(() => { vi.unstubAllEnvs(); });
const engine = (options: Parameters<typeof fixtureV8>[0] = {}) => { const fixture = fixtureV8(options); return { ...fixture, engine: new ResearchEngine({ endpoints: { [fixture.network]: 'https://rpc.test' }, deployments: [], discoveryRegistry: fixture.registry, fetcher: fixture.fetcher }) }; };
const markers = { EDGE_01: 'FLV8_MCP_EDGE_01', EDGE_02: 'FLV8_MCP_EDGE_02', EDGE_03: 'FLV8_MCP_EDGE_03', EDGE_04: 'FLV8_MCP_EDGE_04', EDGE_05: 'FLV8_MCP_EDGE_05' };
const marker = (edge: keyof typeof markers) => console.log(JSON.stringify({ event: 'flashloan.v8.edge', marker: markers[edge], passed: true }));

describe('v8 contract and registry boundary', () => {
  it('keeps default legacy schemas and tools unchanged and refuses disabled versions', () => {
    expect(publicOperationEnabled('flashloan_get_registry_v1')).toBe(false);
    expect(publicOperationEnabled('flashloan_get_watchlist_v1')).toBe(false);
    expect(publicSchemas.flashloan_discover_arbitrage_pools.safeParse({ network: 'base', tokens: [A8], schema_version: 'v3' }).success).toBe(false);
    expect(() => assertVersionEnabled('flashloan_discover_arbitrage_pools', { schema_version: 'v3' })).toThrow(/disabled/);
    vi.stubEnv('FLASHLOAN_INVENTORY_V3', 'true'); vi.stubEnv('FLASHLOAN_MOVERS_V2', 'true');
    expect(publicSchemas.flashloan_get_token_movers.safeParse({ schema_version: 'v2', networks: ['base'], min_change_24h_pct: 10 }).success).toBe(false);
    expect(publicSchemas.flashloan_get_token_movers.safeParse({ schema_version: 'v2', networks: ['base'], limit_per_chain: 30 }).success).toBe(true);
    expect(publicSchemas.flashloan_get_token_movers.safeParse({ networks: ['base'], extra: true }).success).toBe(false);
    expect(publicSchemas.flashloan_discover_arbitrage_pools.safeParse({ schema_version: 'v3', network: 'sui', tokens: ['0x2::sui::SUI'] }).success).toBe(false);
    expect(publicSchemas.flashloan_discover_arbitrage_pools.safeParse({ schema_version: 'v3', network: 'base', tokens: [A8], min_liquidity_usd: 1e100 }).success).toBe(false);
    marker('EDGE_01');
  });
  it('hashes the complete normalized registry independently of filters, entry order and timestamps', () => {
    const { registry } = engine(), raw = JSON.parse(JSON.stringify(registry.config)); raw.networks.base.venues.reverse();
    const reversed = new DiscoveryRegistry(raw);
    expect(reversed.version).toBe(registry.version);
    expect(registry.document(['base']).registry_version).toBe(registry.document(['arbitrum']).registry_version);
    expect(registry.document(['arbitrum']).coverage.source_results[0].status).toBe('UNSUPPORTED');
    raw.networks.base.venues[0].factory_code_hash = BLOCK8;
    expect(new DiscoveryRegistry(raw).version).not.toBe(registry.version);
    expect(registryV1Schema.safeParse(registry.document()).success).toBe(true);
    expect(registry.version).toBe(hash({ schema_version: 'flashloan.registry.v1', networks: registry.document().networks }));
    raw.networks.base.anchors = [assetId('arbitrum', A8)]; expect(discoveryRegistryConfigSchema.safeParse(raw).success).toBe(false);
  });
  it('rejects ambiguous aliases rather than selecting an arbitrary manager', () => {
    const raw = JSON.parse(JSON.stringify(engine().registry.config)); raw.networks.base.venues[1].provider_ids.push('dex1');
    expect(() => new DiscoveryRegistry(raw)).toThrow(/Ambiguous provider alias/);
  });
  it('allows shared provider names across contract and V4 ID kinds and selects the V4 manager', async () => {
    const fixture = fixtureV8({ v4: true }), raw = JSON.parse(JSON.stringify(fixture.registry.config));
    raw.networks.base.venues.push({ id: 'dex1-v3', provider_ids: ['dex1'], family: 'V3', factory: Q8, factory_code_hash: BLOCK8, quoter_kind: 'onchain_quoter', cpmm: true, status: 'reviewed' });
    const registry = new DiscoveryRegistry(raw);
    const e = new ResearchEngine({ endpoints: { base: 'https://rpc.test' }, deployments: [], discoveryRegistry: registry, fetcher: fixture.fetcher });
    const result = await e.discoverV3({ network: 'base', tokens: [A8] });
    expect(result.pools[0]).toMatchObject({ reference: { kind: 'evm_v4', manager: F8 }, liquidity_eligible: true });
    raw.networks.base.venues.push({ ...raw.networks.base.venues[0], id: 'another-v4-manager' });
    expect(() => new DiscoveryRegistry(raw)).toThrow(/Ambiguous provider alias/);
  });
  it('separates dynamic PoolKeys from legacy executable quoting and enforces ordered currencies', () => {
    const { key } = fixtureV8({ dynamic: true });
    expect(poolKeyV8Schema.safeParse(key).success).toBe(true);
    expect(poolKeyV8Schema.safeParse({ ...key, fee: 0x800001 }).success).toBe(false);
    expect(poolKeyV8Schema.safeParse({ ...key, currency0: Q8, currency1: A8 }).success).toBe(false);
  });
});

describe('inventory pinned state and valuation', () => {
  it('orders assets by contract state, deduplicates and anchors every batch read to one block', async () => {
    const { engine: e, calls } = engine({ reverse: true });
    const result = await e.discoverV3({ network: 'base', tokens: [A8, A8] });
    expect(result.pools).toHaveLength(2); expect(result.token_results).toHaveLength(1);
    expect(result.pools.every((p) => p.liquidity_eligible && p.state?.block_hash === BLOCK8)).toBe(true);
    expect(result.pools[0].asset_ids).toEqual([assetId('base', A8), assetId('base', Q8)]);
    expect(result.pools[0].depth.virtual_depth_usd).toBe('20000');
    expect(calls.filter((r) => r.method === 'eth_call').every((r) => (r.params[1] as { blockHash: string }).blockHash === BLOCK8)).toBe(true);
    marker('EDGE_02');
  });
  it.each<FixtureFault>(['zero', 'state', 'code', 'reorg', 'no-price', 'wrong-currency', 'wrong-chain', 'bad-batch'])('retains honest inventory dispositions for %s', async (fault) => {
    const { engine: e } = engine({ fault }); const result = await e.discoverV3({ network: 'base', tokens: [A8] });
    expect(result.pools).toHaveLength(2); expect(result.pools.every((p) => !p.liquidity_eligible)).toBe(true);
    if (fault === 'zero') expect(result.pools[0].flags.zero_active_liquidity).toBe(true);
    else if (fault === 'state') expect(result.pools[0].flags.zero_active_liquidity).toBe(false);
    if (fault === 'reorg') { expect(result.block).toBeNull(); expect(result.pools.every((p) => p.state === undefined)).toBe(true); }
    expect(inventoryV3Schema.safeParse(result).success).toBe(true);
  });
  it('computes raw-unit depth without assuming 18 decimals or a dollar stablecoin', () => {
    const state = { block: '1', block_hash: BLOCK8, reserve0: '1000000', reserve1: '2000000' };
    expect(virtualDepth(state, 6, '0.98', 1)).toBe('3.92');
    expect(virtualDepth({ block: '1', block_hash: BLOCK8, sqrt_price_x96: (2n ** 96n).toString(), active_liquidity: '1000000' }, 6, '2', 0)).toBe('4');
    expect(decimalNumber(1e-7)).toBe('0.0000001'); expect(decimalNumber(1e-300)).toBe('0');
  });
  it.each(['V3', 'ALGEBRA', 'AERO_CL'] as const)('verifies the reviewed %s factory lookup and concentrated state', async (cl) => {
    const { engine: e, calls } = engine({ cl }); const result = await e.discoverV3({ network: 'base', tokens: [A8] });
    expect(result.pools.every((p) => p.liquidity_eligible && p.state?.sqrt_price_x96 !== undefined)).toBe(true);
    if (cl === 'AERO_CL') { expect(calls.some((r) => r.method === 'eth_call' && (r.params[0] as { data: string }).data.startsWith(toFunctionSelector('getPool(address,address,int24)')))).toBe(true); expect(calls.some((r) => r.method === 'eth_call' && (r.params[0] as { data: string }).data.startsWith(toFunctionSelector('getPool(address,address,uint24)')))).toBe(false); }
  });
  it('accepts exponent-form numeric thresholds without mislabelling state failures', async () => {
    const { engine: e } = engine(); const result = await e.discoverV3({ network: 'base', tokens: [A8], min_liquidity_usd: 1e-7 });
    expect(result.pools.every((p) => p.liquidity_eligible)).toBe(true);
  });
  it('trims using the actual escaped MCP envelope and reconciles selected pool references', async () => {
    const fixture = fixtureV8(); const e = new ResearchEngine({ endpoints: { base: 'https://rpc.test' }, deployments: [], discoveryRegistry: fixture.registry, fetcher: async (url, init) => String(url).includes('/token-pairs/') ? Response.json(fixture.pairs.map((p) => ({ ...p, labels: ['"'.repeat(300000)] }))) : fixture.fetcher(url, init) });
    const result = await e.discoverV3({ network: 'base', tokens: [A8] });
    expect(result.coverage.truncated).toBe(true); expect(result.coverage.deferred_counts.BYTE_LIMIT).toBeGreaterThan(0);
    expect(publicWireBytes({ schema_version: 'flashloan.public.v3', request_id: '0'.repeat(36), operation: 'flashloan_discover_arbitrage_pools', ok: true, data: result, execution: false, warnings: result.warnings })).toBeLessThan(PUBLIC_LIMITS.body_bytes);
    expect(result.token_results[0].pool_ids.every((id) => result.pools.some((p) => p.id === id))).toBe(true);
  });
  it('splits oversized log ranges and stops splitting a single oversized block', async () => {
    const ranges: unknown[] = [], rpc = new JsonClient('https://rpc.test', async (_url, init) => { const request = JSON.parse(String(init?.body)); ranges.push(request.params[0]); return Response.json({ result: request.params[0].fromBlock === request.params[0].toBlock ? [1] : Array(2001).fill(1) }); });
    expect(await boundedEvmLogs(rpc, { address: A8, fromBlock: '0x1', toBlock: '0x2' }, new AbortController().signal)).toEqual([1, 1]); expect(ranges).toHaveLength(3);
    const huge = new JsonClient('https://rpc.test', async () => Response.json({ result: Array(2001).fill(1) }));
    await expect(boundedEvmLogs(huge, { address: A8, fromBlock: '0x1', toBlock: '0x1' }, new AbortController().signal)).rejects.toMatchObject({ code: 'LOG_RESPONSE_BUDGET' });
  });
  it.each([{ dynamic: true }, { hook: true }, { network: 'robinhood' as const, dynamic: true, hook: true }])('resolves V4 identity without reserve-math hook quoting: %j', async (options) => {
    const { engine: e, network, poolId } = engine({ ...options, v4: true });
    const result = await e.discoverV3({ network, tokens: [A8], min_liquidity_usd: 5000 });
    expect(result.pools[0].reference).toMatchObject({ kind: 'evm_v4', poolId });
    expect(result.pools[0].liquidity_eligible).toBe(true);
    expect(result.pools[0].fee_mode).toBe(options.hook ? 'hooked' : 'dynamic');
    if (options.hook) expect(result.pools[0]).toMatchObject({ hook: { allowlisted: false }, capabilities: { quote: { status: 'simulation_only' } } });
    marker('EDGE_03');
  });
  it('retains unresolved V4 identities with explicit dependencies', async () => {
    const { engine: e } = engine({ v4: true, fault: 'bad-init' });
    const result = await e.discoverV3({ network: 'base', tokens: [A8] });
    expect(result.pools[0].reference.kind).toBe('provider_opaque');
    expect(result.pools[0].eligibility_reasons).toContain('UNRESOLVED_POOL_KEY');
  });
  it('merges provenance when opaque and canonical V4 references resolve to the same pool', async () => {
    const fixture = fixtureV8({ v4: true }), raw = JSON.parse(JSON.stringify(fixture.registry.config));
    raw.pools = [{ network: 'base', venue_id: 'dex1', reference: { kind: 'evm_v4', chainId: 8453, manager: F8, poolId: fixture.poolId }, asset_ids: [assetId('base', A8), assetId('base', Q8)] }];
    const e = new ResearchEngine({ endpoints: { base: 'https://rpc.test' }, deployments: [], fetcher: fixture.fetcher, discoveryRegistry: new DiscoveryRegistry(raw) });
    const result = await e.discoverV3({ network: 'base', tokens: [A8] });
    expect(result.pools).toHaveLength(1); expect(result.pools[0].provenance.map((p) => p.source)).toContain('reviewed-registry');
    expect(result.pools[0].provenance.some((p) => p.source.startsWith('dexscreener'))).toBe(true);
  });
});

describe('movers and watchlist composition', () => {
  it('ranks quiet tokens using two eligible pools and leaves missing historical signals null', async () => {
    const { engine: e } = engine(); const result = await e.moversV2({ networks: ['base'], seed_tokens: { base: [A8] } });
    expect(result.chains[0].tokens[0]).toMatchObject({ token_id: assetId('base', A8), signals: { change_h24_pct: 1, volume_spike_z: null, pools_with_active_liquidity: 2 } });
    expect(result.chains[0].tokens[0].missing_signals).toContain('volume_spike_z');
    expect(moversV2Schema.safeParse(result).success).toBe(true);
    marker('EDGE_04');
  });
  it('retains newly created native pools before aggregators index them', async () => {
    const { engine: e } = engine({ nativeOnly: true }); const result = await e.watchlist({ network: 'base', seed_tokens: [A8] });
    expect(result.tokens.some((t) => t.token_id === assetId('base', A8))).toBe(true); expect(result.pools).toHaveLength(2);
    expect(result.pools.some((p) => p.provenance.some((s) => s.source.startsWith('onchain.pool_created')))).toBe(true);
  });
  it('keeps configured-chain results when another requested RPC is absent', async () => {
    const { engine: e } = engine(); const result = await e.moversV2({ networks: ['base', 'arbitrum'], seed_tokens: { base: [A8] } });
    expect(result.chains[0].tokens).toHaveLength(1); expect(result.chains[1].outcome).toBe('PARTIAL');
    expect(result.chains[1].coverage.source_results.some((s) => s.status === 'FAILED')).toBe(true);
  });
  it('labels failed RPC coverage PARTIAL even when the provider inventory is empty', async () => {
    const e = new ResearchEngine({ endpoints: {}, deployments: [], fetcher: async () => Response.json([]) });
    const result = await e.discoverV3({ network: 'base', tokens: [A8] });
    expect(result.pools).toEqual([]); expect(result.outcome).toBe('PARTIAL'); expect(result.coverage.source_results.some((s) => s.status === 'FAILED')).toBe(true);
  });
  it('preserves source failure and provider-unsupported coverage', async () => {
    const { engine: e } = engine({ fault: 'gecko' }); const result = await e.moversV2({ networks: ['base'], seed_tokens: { base: [A8] } });
    expect(result.chains[0].outcome).toBe('PARTIAL'); expect(result.chains[0].coverage.source_results).toContainEqual(expect.objectContaining({ source: 'geckoterminal.trending', status: 'FAILED' }));
    const { engine: robin } = engine({ network: 'robinhood' }); const rh = await robin.moversV2({ networks: ['robinhood'], seed_tokens: { robinhood: [A8] } });
    expect(rh.chains[0].coverage.source_results.filter((s) => s.source === 'geckoterminal.trending')).toEqual([expect.objectContaining({ status: 'UNSUPPORTED' })]);
  });
  it('discloses reviewed families without a native creation adapter', async () => {
    const { engine: e } = engine({ cl: 'ALGEBRA' }); const result = await e.moversV2({ networks: ['base'], seed_tokens: { base: [A8] } });
    expect(result.chains[0].tokens).toHaveLength(1); expect(result.chains[0].outcome).toBe('PARTIAL');
    expect(result.chains[0].coverage.excluded_counts.ONCHAIN_UNSUPPORTED_FAMILY).toBe(2);
    expect(result.chains[0].coverage.source_results).toContainEqual(expect.objectContaining({ source: 'onchain.pool_created', status: 'UNSUPPORTED', reason: 'NO_REVIEWED_CREATION_VENUES' }));
  });
  it('bounds a stalled source phase and still verifies pools from successful sources', async () => {
    const fixture = fixtureV8();
    const e = new ResearchEngine({ endpoints: { base: 'https://rpc.test' }, deployments: [], discoveryRegistry: fixture.registry, fetcher: async (url, init) => {
      if (String(url).includes('api.geckoterminal.com')) return new Promise<Response>((_resolve, reject) => { const abort = () => reject(new Error('source deadline')); if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort', abort, { once: true }); });
      return fixture.fetcher(url, init);
    } });
    const result = await e.watchlist({ network: 'base', seed_tokens: [A8] });
    expect(result.outcome).toBe('PARTIAL'); expect(result.pools).toHaveLength(2);
    expect(result.coverage.source_results).toContainEqual(expect.objectContaining({ source: 'geckoterminal.trending', status: 'FAILED', reason: 'SOURCE_DEADLINE' }));
  }, 12000);
  it('enforces watchlist evidence, excludes, registry pin and the consumer document unchanged', async () => {
    const { engine: e, registry } = engine(); const result = await e.watchlist({ network: 'base', seed_tokens: [A8], max_pools: 2 });
    expect(result.tokens).toHaveLength(1); expect(result.pools).toHaveLength(2); expect(result.registry_version).toBe(registry.document().registry_version); expect(result.ttl_seconds).toBe(120);
    const consumer = watchlistV1Schema.parse(JSON.parse(JSON.stringify(result))); expect(consumer).toEqual(result);
    const invalid = engine({ fault: 'no-price' }); expect((await invalid.engine.watchlist({ network: 'base', seed_tokens: [A8] })).pools).toEqual([]);
    const excluded = await e.watchlist({ network: 'base', seed_tokens: [A8], exclude_tokens: [A8] }); expect(excluded.tokens).toEqual([]); expect(excluded.pools).toEqual([]);
    marker('EDGE_05');
  }, 20000);
  it('round trips the exported JSON schemas and rejects unexpected fields', async () => {
    const { engine: e } = engine(); const result = await e.discoverV3({ network: 'base', tokens: [A8] });
    const ajv = new Ajv({ strict: false }); addFormats(ajv);
    const validate = ajv.compile(v8DocumentSchemas().inventory);
    expect(validate(result), JSON.stringify(validate.errors)).toBe(true);
    expect(validate({ ...result, signer: A8 })).toBe(false);
    expect(z.toJSONSchema(registryV1Schema, { io: 'input' })).toBeTruthy();
  });
});
