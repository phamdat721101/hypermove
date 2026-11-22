// @vitest-environment node
// EDGE-03 (seam: universe / shared cache) for docs/features/flashloan-mcp-arb-upgrade-map.md.
// M5a: S1–S6 arb contracts · shared artifacts · cache key · per-kind proof TTL (review file 11 §B #21, §F #19–#22).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  arbCanonicalityProofSchema, arbCacheKey, arbCycleId, arbDocumentSchemas, arbRecordSchema, arbUniversePayloadSchema, coverageArbSchema,
  cycleQuoteSchema, cycleSchema, deploymentsVersion, replayEventSchema, universePoolSchema, universePoolToPool, type CycleHop,
} from '../src/lib/mcp/flashloan/arb-contracts';
import { createHmac } from 'node:crypto';
import { canonical, hash } from '../src/lib/mcp/flashloan/contracts';
import { emptyCoverage } from '../src/lib/mcp/flashloan/v8-contracts';
import { poolQuoteCapability } from '../src/lib/mcp/flashloan/math';
import { DiscoveryRegistry } from '../src/lib/mcp/flashloan/discovery-registry';
import { MemoryRepository, SHARED_OWNER } from '../src/lib/mcp/flashloan/storage';
import { PublicProofs } from '../src/lib/mcp/flashloan/public-proof';
import { proofTtlMs, PUBLIC_LIMITS } from '../src/lib/mcp/flashloan/public-contracts';

const marker = () => console.log(JSON.stringify({ event: 'flashloan.arb.edge', marker: 'FLARB_EDGE_03', passed: true }));
const ok = (schema: { safeParse(v: unknown): { success: boolean } }, value: unknown) => schema.safeParse(value).success;
const WETH = 'eip155:42161/erc20:0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const USDC = 'eip155:42161/erc20:0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const USDT = 'eip155:42161/erc20:0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9';
const P1 = '0x' + '1'.repeat(40), P2 = '0x' + '2'.repeat(40), P3 = '0x' + '3'.repeat(40);
const H = (c: string) => '0x' + c.repeat(64);
const BLOCK = { number: '100', hash: H('b'), timestamp: '1700000000' };
const proof = { kind: 'create2', chain_id: 42161, adapter_version: 'uniswap-v3', factory: '0x1f98431c8ad98523631ae4a59f267346ea31f984', deployer: '0x1f98431c8ad98523631ae4a59f267346ea31f984', init_code_hash: '0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54', salt_kind: 'V3_FEE', salt_args: [P1, P2, '500'], salt: H('5') };
const clmm = { kind: 'clmm', sqrt_price_x96: (1n << 96n).toString(), tick: 0, liquidity: '1000000000000', tick_spacing: 10, word_min: -1, word_max: 1, ticks: [{ tick: -10, liquidity_net: '5' }, { tick: 10, liquidity_net: '-5' }] };
const pool = { pool_ref: P1, chain_id: 42161, venue_id: 'uniswap-v3', family: 'V3', status: 'reviewed', tokens: [WETH, USDC], decimals: [18, 6], fee_pips: 500, fee_mode: 'static', code_hash: H('c'), adapter_version: 'uniswap-v3', quote_capability: 'exact', sizing: 'sizable', subscription: { emitter: P1 }, block: BLOCK, state: clmm, depth_coverage: 'complete', depth_usd: { pm50bps: '1000', pm100bps: '2000.5', pm200bps: '4000' }, canonicality: proof, executor_venue_ids: { [P3]: 1 } };
const hops: CycleHop[] = [{ pool_ref: P1, token_in: WETH, token_out: USDC }, { pool_ref: P2, token_in: USDC, token_out: USDT }, { pool_ref: P3, token_in: USDT, token_out: WETH }];
const cycle = { cycle_id: arbCycleId(WETH, hops), funding_asset: WETH, hops, fee_floor_bps_approx: 15, lenders: [{ lender_id: 'morpho', provider: 'MORPHO_BLUE', address: P3, fee_bps: 0, capacity_raw: '10' }], realized: null, rank: 0 };
const record = { tier: 'swap_surplus_candidate', tx: H('a'), block: '100', tx_index: 3, to: P2, from: P3, hops: [{ pool_ref: P1, venue_id: 'uniswap-v3', delta: ['-100', '250'] }], net_by_asset: { [WETH]: '7', [USDC]: '0' }, gross_usd: '0.02', gas_usd: null, net_usd: null, priority_gwei: '0.01', express_lane: null, trigger: { tx: H('d'), tx_index: 2, shared_pools: [P1] }, cycle_id: null, price_sources: ['chainlink:0x639f@100'] };
const gas = { gas_units: '300000', base_fee_wei: '10000000', priority_bid_wei: '1', gas_price_wei: '10000001', cost_in_borrow_raw: '50', eth_usd: '3000' };
const quote = { cycle_id: cycle.cycle_id, block: BLOCK, mode: 'historical', pre_swaps_applied: 1, principal_raw: '1000', expected_out_raw: '1200', lender: { lender_id: 'morpho', provider: 'MORPHO_BLUE', fee_raw: '0' }, gross_raw: '200', gas, net_raw: '150', net_usd: '0.45', margin_raw: '10', min_profit_raw: '60', outcome: 'PROFITABLE', reason: null, fidelity: { quote_capability: 'exact', tick_words_loaded: 3, crossed_unloaded_tick: false, hooks: false }, route_payload: null };
const replay = { trigger_tx: H('d'), block: '100', tx_index: 2, trigger_pool: P1, trigger_usd: '50000', best_cycle_id: cycle.cycle_id, our_net_usd: '-0.1', taken_by: { tx: H('a'), to: P2, tx_index: 3, match: 'same_directed_cycle', net_usd: null }, latency_ms_to_winner: null, fidelity: 'TICK_APPROX', reason: null };
const coverage = { ...emptyCoverage(), archive: 'available', nodes_visited: 9, max_nodes_visited: 5000, pools_hydrated: 3, unauthenticated_emitters: 0, unsupported_emitters: 0, unpriced: 0 };

describe('M5a arb contracts S1–S6', () => {
  it('S1 reuses the M3 CREATE2 proof shape', () => {
    expect(ok(arbCanonicalityProofSchema, proof)).toBe(true);
    expect(ok(arbCanonicalityProofSchema, { ...proof, chain_id: undefined })).toBe(false);
    expect(ok(arbCanonicalityProofSchema, { ...proof, init_code_hash: proof.init_code_hash.slice(2) })).toBe(false);
  });
  it('S2 pools: union state, fee max 999,999, sizing gate, V4 subscription, math.ts compatibility', () => {
    expect(ok(universePoolSchema, pool)).toBe(true);
    expect(ok(universePoolSchema, { ...pool, fee_pips: 999999 })).toBe(true);
    expect(ok(universePoolSchema, { ...pool, fee_pips: 1_000_000 })).toBe(false);
    expect(ok(universePoolSchema, { ...pool, canonicality: null })).toBe(false); // sizable needs a derivation proof
    expect(ok(universePoolSchema, { ...pool, canonicality: null, sizing: 'discovery_only', status: 'research' })).toBe(true);
    expect(ok(universePoolSchema, { ...pool, quote_capability: 'none' })).toBe(false);
    expect(ok(universePoolSchema, { ...pool, canonicality: { ...proof, chain_id: 8453 } })).toBe(false);
    expect(ok(universePoolSchema, { ...pool, depth_coverage: 'none' })).toBe(false); // depth without hydration
    expect(ok(universePoolSchema, { ...pool, state: { ...clmm, kind: 'cpmm' } })).toBe(false);
    expect(ok(universePoolSchema, { ...pool, state: { ...clmm, word_min: 2 } })).toBe(false);
    const cpmm = { ...pool, state: { kind: 'cpmm', reserve0: '10', reserve1: '20', stable: false } };
    expect(ok(universePoolSchema, cpmm)).toBe(true);
    const id = H('e'), key = { currency0: '0x' + '0'.repeat(40), currency1: P2, fee: 500, tickSpacing: 10, hooks: '0x' + '0'.repeat(40) };
    const v4 = { ...pool, pool_ref: id, family: 'V4', subscription: { emitter: P3, pool_id: id }, state: { ...clmm, kind: 'v4', manager: P3, pool_id: id, key, protocol_fee: 0 }, tokens: ['eip155:42161/slip44:60', USDC] };
    expect(ok(universePoolSchema, v4)).toBe(true);
    expect(ok(universePoolSchema, { ...v4, subscription: { emitter: id.slice(0, 42) } })).toBe(false);
    // Every state variant converts to a valid solver Pool with the same capability.
    const converted = [pool, cpmm, v4].map((p) => universePoolToPool(universePoolSchema.parse(p)));
    expect(converted.map((p) => p.kind)).toEqual(['clmm', 'v2', 'clmm']);
    expect(converted[2].token0).toBe('0x' + '0'.repeat(40));
    expect(converted.map(poolQuoteCapability)).toEqual(['exact', 'exact', 'exact']);
  });
  it('S3 cycles: identity is (funding asset, ordered directed hops); both directions survive', () => {
    expect(ok(cycleSchema, cycle)).toBe(true);
    const reversed = [...hops].reverse().map((h) => ({ ...h, token_in: h.token_out, token_out: h.token_in }));
    expect(arbCycleId(WETH, reversed)).not.toBe(cycle.cycle_id);
    expect(ok(cycleSchema, { ...cycle, hops: reversed, cycle_id: arbCycleId(WETH, reversed) })).toBe(true);
    expect(ok(cycleSchema, { ...cycle, cycle_id: '0x' + cycle.cycle_id.slice(2) })).toBe(false); // hex64, never 0x-prefixed
    expect(ok(cycleSchema, { ...cycle, cycle_id: hash('other') })).toBe(false);
    expect(ok(cycleSchema, { ...cycle, hops: [hops[0], hops[2]], cycle_id: arbCycleId(WETH, [hops[0], hops[2]]) })).toBe(false); // broken chain
    expect(ok(cycleSchema, { ...cycle, lenders: [{ ...cycle.lenders[0], provider: 'MORPHO' }] })).toBe(false);
  });
  it('S4 records: every net ≥ 0, one > 0, tiered, reserved express_lane', () => {
    expect(ok(arbRecordSchema, record)).toBe(true);
    expect(ok(arbRecordSchema, { ...record, tier: 'verified_realized', express_lane: false })).toBe(true);
    expect(ok(arbRecordSchema, { ...record, net_by_asset: { [WETH]: '7', [USDC]: '-1' } })).toBe(false);
    expect(ok(arbRecordSchema, { ...record, net_by_asset: { [WETH]: '0' } })).toBe(false);
    expect(ok(arbRecordSchema, { ...record, tier: 'estimated' })).toBe(false);
    expect(ok(arbRecordSchema, { ...record, cycle_id: '0x' + 'a'.repeat(64) })).toBe(false);
    expect(ok(arbRecordSchema, { ...record, trigger: { ...record.trigger, tx_index: 3 } })).toBe(false);
  });
  it('S5 quotes: decided only with full gas and an exact model; PROFITABLE iff net ≥ margin', () => {
    expect(ok(cycleQuoteSchema, quote)).toBe(true);
    expect(ok(cycleQuoteSchema, { ...quote, outcome: 'UNPROFITABLE' })).toBe(false);
    expect(ok(cycleQuoteSchema, { ...quote, net_raw: '5' })).toBe(false);
    expect(ok(cycleQuoteSchema, { ...quote, net_raw: '5', outcome: 'UNPROFITABLE' })).toBe(true);
    expect(ok(cycleQuoteSchema, { ...quote, min_profit_raw: '10' })).toBe(false); // threshold = gas + margin
    expect(ok(cycleQuoteSchema, { ...quote, gas: { ...gas, eth_usd: null } })).toBe(false);
    expect(ok(cycleQuoteSchema, { ...quote, fidelity: { ...quote.fidelity, quote_capability: 'estimate' } })).toBe(false);
    expect(ok(cycleQuoteSchema, { ...quote, gas: { ...gas, cost_in_borrow_raw: '0' }, margin_raw: '0', min_profit_raw: '0' })).toBe(false); // ZERO_COST_POLICY
    expect(ok(cycleQuoteSchema, { ...quote, gas: { ...gas, eth_usd: null }, outcome: 'INCONCLUSIVE', reason: 'ETH_PRICE_MISSING' })).toBe(true);
    expect(ok(cycleQuoteSchema, { ...quote, outcome: 'INCONCLUSIVE', reason: null })).toBe(false);
  });
  it('S6 replay events and payload wrappers', () => {
    expect(ok(replayEventSchema, replay)).toBe(true);
    expect(ok(replayEventSchema, { ...replay, taken_by: { ...replay.taken_by, tx_index: 2 } })).toBe(false);
    expect(ok(replayEventSchema, { ...replay, trigger_tx: 'd'.repeat(64) })).toBe(false);
    expect(ok(coverageArbSchema, coverage)).toBe(true);
    expect(ok(coverageArbSchema, { ...coverage, surprise: 1 })).toBe(false);
    const universe = { schema_version: 'flashloan.arb.universe.v1', network: 'arbitrum', chain_id: 42161, block: BLOCK, registry_version: hash('r'), cache_key: hash('k'), outcome: 'SUCCESS', pools: [pool], cycles: [cycle], coverage: { ...coverage, realized_value_share: null, ground_truth_window: null }, warnings: [] };
    expect(ok(arbUniversePayloadSchema, universe)).toBe(true);
    expect(ok(arbUniversePayloadSchema, { ...universe, cache_key: '0x' + hash('k') })).toBe(false);
    const docs = arbDocumentSchemas();
    expect(Object.keys(docs)).toEqual(['universe', 'cycle_quote', 'ground_truth', 'backrun_replay']);
    expect(JSON.stringify(docs.universe)).toContain('flashloan.arb.universe.v1');
  });
});

describe('M5a cache key', () => {
  const block = JSON.parse(readFileSync(new URL('../services/flashloan/registry/arbitrum.reviewed.json', import.meta.url), 'utf8'));
  const deployments = JSON.parse(readFileSync(new URL('../services/flashloan/registry/arbitrum.deployments.json', import.meta.url), 'utf8'));
  const seed = { network: 'arbitrum', venue_id: 'uniswap-v3', reference: { kind: 'evm_contract', chainId: 42161, address: P1 }, asset_ids: [WETH, USDC] };
  const registry = (extra: Record<string, unknown> = {}) => new DiscoveryRegistry({ networks: { arbitrum: block }, ...extra });
  const key = (r: DiscoveryRegistry, inputs: Record<string, unknown>) => arbCacheKey({ op: 'flashloan_get_arb_universe_v1', network: 'arbitrum', registry: r, deployments_version: deploymentsVersion(deployments), inputs });
  it('changes with seed pools and score weights although registry_version does not', () => {
    const base = registry(), seeded = registry({ pools: [seed] }), weighted = registry({ score_weights: { volume_spike: 2 } });
    expect(seeded.version).toBe(base.version); expect(weighted.version).toBe(base.version);
    const inputs = { max_hops: 3 };
    expect(new Set([key(base, inputs), key(seeded, inputs), key(weighted, inputs)]).size).toBe(3);
  });
  it('is stable under input key order, address case and idempotency keys; sensitive to inputs and deployments', () => {
    const r = registry();
    const a = key(r, { max_hops: 3, tokens: [P1.toUpperCase().replace('0X', '0x')], idempotency_key: 'one' });
    const b = key(r, { idempotency_key: 'two', tokens: [P1], max_hops: 3 });
    expect(a).toBe(b); expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(key(r, { max_hops: 4, tokens: [P1] })).not.toBe(a);
    expect(deploymentsVersion([...deployments].reverse())).toBe(deploymentsVersion(deployments));
    expect(arbCacheKey({ op: 'flashloan_get_arb_universe_v1', network: 'arbitrum', registry: r, deployments_version: deploymentsVersion(deployments.slice(1)), inputs: { max_hops: 3, tokens: [P1] } })).not.toBe(a);
  });
});

describe('M5a shared artifact storage (MemoryRepository)', () => {
  const ck = hash('cache'), other = hash('other');
  it('publishes and reads shared artifacts; private artifacts never cross the shared path', async () => {
    const repo = new MemoryRepository();
    expect(await repo.readSharedLatest('arb_universe', ck)).toBeNull();
    const first = await repo.publishShared('arb_universe', ck, { v: 1 });
    expect(first).toMatchObject({ owner_id: SHARED_OWNER, shared: true, cache_key: ck, content_hash: hash({ v: 1 }) });
    await repo.publishShared('arb_universe', ck, { v: 2 });
    expect((await repo.readSharedLatest('arb_universe', ck))!.data).toEqual({ v: 2 });
    await repo.publishShared('arb_universe', ck, { v: 1 }); // republished content becomes latest again
    expect((await repo.readSharedLatest('arb_universe', ck))!.data).toEqual({ v: 1 });
    expect(await repo.readSharedLatest('arb_universe', other)).toBeNull();
    expect(await repo.readSharedLatest('arb_ground_truth', ck)).toBeNull();
    // A private artifact with the same kind is invisible to the shared path, and the shared one to other owners.
    const privateId = await repo.put('alice', 'arb_universe', { v: 3 });
    expect((await repo.readSharedLatest('arb_universe', ck))!.data).toEqual({ v: 1 });
    expect((await repo.artifact('alice', privateId)).shared).toBeUndefined();
    await expect(repo.artifact('alice', first.id)).rejects.toThrow('not found');
    await expect(repo.readSharedLatest('arb_universe', '0x' + ck)).rejects.toThrow();
  });
  it('retains per kind: universe 24 h, ground truth and replay 7 d, existing kinds unchanged', async () => {
    let now = 1_700_000_000_000; const repo = new MemoryRepository(() => now);
    await repo.publishShared('arb_universe', ck, { u: 1 }); await repo.publishShared('arb_ground_truth', ck, { g: 1 }); await repo.publishShared('backrun_replay', ck, { r: 1 });
    const snapshot = await repo.put('alice', 'snapshot', { s: 1 }), report = await repo.put('alice', 'report', { r: 1 });
    now += 24 * 3_600_000 - 1; expect(await repo.readSharedLatest('arb_universe', ck)).not.toBeNull(); expect((await repo.artifact('alice', snapshot)).kind).toBe('snapshot');
    now += 1; expect(await repo.readSharedLatest('arb_universe', ck)).toBeNull(); await expect(repo.artifact('alice', snapshot)).rejects.toThrow('not found');
    expect(await repo.readSharedLatest('arb_ground_truth', ck)).not.toBeNull();
    now += 6 * 24 * 3_600_000; expect(await repo.readSharedLatest('arb_ground_truth', ck)).toBeNull(); expect(await repo.readSharedLatest('backrun_replay', ck)).toBeNull(); await expect(repo.artifact('alice', report)).rejects.toThrow('not found');
  });
  it('dedupes concurrent enqueueShared calls to one active job and enqueues again once it finishes', async () => {
    const repo = new MemoryRepository();
    const [a, b] = await Promise.all([repo.enqueueShared('flashloan_research_job', { operation: 'capabilities' }, ck), repo.enqueueShared('flashloan_research_job', { operation: 'capabilities' }, ck)]);
    expect(a.id).toBe(b.id);
    expect((await repo.enqueueShared('flashloan_research_job', { operation: 'capabilities' }, other)).id).not.toBe(a.id);
    const claimed = await repo.claim(); expect(claimed!.id).toBe(a.id); expect(claimed!.owner).toBe(SHARED_OWNER);
    expect((await repo.enqueueShared('flashloan_research_job', { operation: 'capabilities' }, ck)).id).toBe(a.id); // RUNNING still dedupes
    await repo.finish(a.id, hash('done'));
    expect((await repo.enqueueShared('flashloan_research_job', { operation: 'capabilities' }, ck)).id).not.toBe(a.id);
  });
});

describe('M5a per-kind proof TTL', () => {
  const key = 'k'.repeat(32), registry = hash('registry');
  const resign = (unsigned: Record<string, unknown>) => ({ ...unsigned, proof: { algorithm: 'HS256', key_id: 'v2', signature: createHmac('sha256', key).update('hypermove-public-integrity-v2\n').update(canonical(unsigned)).digest('base64url') } });
  it('caps evm_cycle_quote at 30 s and evm_universe at 600 s in sign and verify', () => {
    let now = 1_700_000_000_000; const proofs = new PublicProofs(key, registry, () => now);
    expect(proofTtlMs('evm_cycle_quote')).toBe(30_000); expect(proofTtlMs('evm_universe')).toBe(Math.min(600_000, PUBLIC_LIMITS.proof_ttl_ms)); expect(proofTtlMs('evm_snapshot')).toBe(PUBLIC_LIMITS.proof_ttl_ms);
    const q = proofs.sign('evm_cycle_quote', { quote: 1 });
    expect(Date.parse(q.expires_at) - Date.parse(q.issued_at)).toBe(30_000);
    now += 29_999; expect(proofs.verify(q, 'evm_cycle_quote').kind).toBe('evm_cycle_quote');
    now += 1; expect(() => proofs.verify(q, 'evm_cycle_quote')).toThrow('expired');
    const u = proofs.sign('evm_universe', { pools: [] });
    expect(Date.parse(u.expires_at) - Date.parse(u.issued_at)).toBe(proofTtlMs('evm_universe'));
    expect(() => proofs.verify(u, 'evm_snapshot')).toThrow('Wrong research payload kind');
  });
  it('verify rejects a correctly signed quote envelope whose lifetime exceeds 30 s', () => {
    const now = 1_700_000_000_000; const proofs = new PublicProofs(key, registry, () => now);
    const payload = { quote: 1 };
    const unsigned = { version: 2 as const, kind: 'evm_cycle_quote', issued_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 60_000).toISOString(), registry_version: registry, content_hash: hash(payload), payload };
    const signature = createHmac('sha256', key).update('hypermove-public-integrity-v2\n').update(canonical(unsigned)).digest('base64url');
    const envelope = { ...unsigned, proof: { algorithm: 'HS256', key_id: 'v2', signature } };
    expect(() => proofs.verify(envelope, 'evm_cycle_quote')).toThrow('expired');
    expect(proofs.verify({ ...envelope, ...resign({ ...unsigned, kind: 'evm_universe' }) }, 'evm_universe').kind).toBe('evm_universe'); // same lifetime is fine for a universe
    marker();
  });
});
