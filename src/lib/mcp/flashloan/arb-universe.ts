import { keccak256, type Hex } from 'viem';
import type { z } from 'zod';
import { ResearchError, UNIVERSE_OPERATION, universeInputSchema, type PoolRef, type LenderProvider } from './contracts';
import { arbCacheKey, arbCycleId, arbUniversePayloadSchema, deploymentsVersion, universePoolSchema, universePoolToPool, type cycleSchema, type CycleHop, type UniversePool, type ArbGroundTruthDocument } from './arb-contracts';
import { depthBands, enumerateClosedRoutes, lenderRoutablePools, poolQuoteCapability, type Pool } from './math';
import { InventoryReaderV3, decimalRaw, decimalString, venueQuoteCapability } from './inventory-v3';
import { inventory as readInventory } from './discovery-v8';
import { assetId, type InventoryPoolV3, type InventoryV3 } from './v8-contracts';
import { CHAINS } from './networks';
import type { EvmReader, Deployment, Header } from './evm';
import type { DiscoveryRegistry, Venue } from './discovery-registry';
import type { ResearchEngine } from './engine';
import type { RoundBudget } from './transport';

/**
 * PRD-B `flashloan_get_arb_universe_v1` builder (amended by file 11 §B #12, #13, #21): the reviewed, liquidity-eligible,
 * quotable pool set at one pinned block, bounded tick hydration with in-range depth bands, every directed closed cycle
 * per lendable funding asset (both directions kept), live lender capacity, and a ranking anchored on verified realized
 * arbs from the latest shared ground-truth artifact. It runs only as a shared worker job; public calls read its artifact.
 */
export type UniverseInput = z.infer<typeof universeInputSchema>;
type Network = UniverseInput['network'];
type RegistryLender = ReturnType<DiscoveryRegistry['network']>['lenders'][number];
type CycleLender = { lender_id: string; provider: LenderProvider; address: string; fee_bps: number; capacity_raw: string };
const ZERO = '0x' + '0'.repeat(40);
/** Pools with the most reported liquidity get their ticks loaded (word_range 1) within this bound. */
export const UNIVERSE_HYDRATION = { top_k: 48, word_range: 1, max_ticks: 2000 } as const;
/** The worker builds one universe per cache key at most every 15 minutes; a public hit older than this is a miss. */
export const UNIVERSE_FRESH_MS = 900_000;
const PROVIDERS: Partial<Record<RegistryLender['kind'], LenderProvider>> = { morpho: 'MORPHO_BLUE', balancer_v2: 'BALANCER_V2', aave_v3: 'AAVE_V3', v3_flash: 'UNISWAP_V3_FLASH' };
const BLOCKS_PER_DAY: Record<Network, bigint> = { arbitrum: 345_600n, base: 43_200n, ethereum: 7_200n };

/** One normalized cache identity (file 11 #21) shared by the public read path and the worker build. */
export function universeCacheKey(registry: DiscoveryRegistry, deployments: Deployment[], input: UniverseInput) {
  const { network, ...inputs } = universeInputSchema.parse(input);
  return arbCacheKey({ op: UNIVERSE_OPERATION, network, registry, deployments_version: deploymentsVersion(deployments.filter((d) => d.network === network)), inputs });
}

const addressOf = (asset: string) => asset.endsWith('/slip44:60') ? ZERO : asset.slice(asset.indexOf('/erc20:') + 7);
const usd = (raw: bigint, decimals: number, price: string) => decimalString(raw * decimalRaw(price) / 10n ** BigInt(decimals));
const signedRaw = (value: string) => value.startsWith('-') ? -decimalRaw(value.slice(1)) : decimalRaw(value);
const signedString = (value: bigint) => (value < 0n ? '-' : '') + decimalString(value < 0n ? -value : value);
const bump = (counts: Record<string, number>, code: string, by = 1) => { counts[code] = (counts[code] ?? 0) + by; };

function venueOf(pool: InventoryPoolV3, venues: Venue[]) {
  const v4 = pool.reference.kind === 'evm_v4' || pool.reference.kind === 'provider_opaque' && /^0x[0-9a-f]{64}$/i.test(pool.reference.providerPoolId);
  return venues.find((v) => (v.family === 'V4') === v4 && (v.id === pool.protocol || v.provider_ids.includes(pool.protocol)));
}
/** EvmReader reference for a discovery pool; undefined when the pool has no snapshot adapter. */
function snapshotRef(pool: InventoryPoolV3, venue: Venue): PoolRef | undefined {
  const word_range = UNIVERSE_HYDRATION.word_range;
  if (venue.family === 'V4') {
    const id = pool.reference.kind === 'evm_v4' ? pool.reference.poolId : pool.reference.kind === 'provider_opaque' ? pool.reference.providerPoolId.toLowerCase() : undefined;
    const manager = pool.reference.kind === 'evm_v4' ? pool.reference.manager : venue.factory;
    if (!id || !pool.pool_key || pool.pool_key.fee === 0x800000) return undefined;
    return { address: id, adapter: 'UNISWAP_V4', manager, pool_key: { ...pool.pool_key, fee: pool.pool_key.fee as number }, word_range };
  }
  if (pool.reference.kind !== 'evm_contract') return undefined;
  const adapter = venue.family === 'V2' ? 'UNISWAP_V2' : venue.family === 'SOLIDLY_VOLATILE' ? 'AERODROME_VOLATILE' : venue.family === 'SOLIDLY_STABLE' ? 'AERODROME_STABLE'
    : venue.family === 'ALGEBRA' ? 'ALGEBRA' : venue.family === 'V3' ? (venue.pool_lookup === 'getPoolSpacing' ? 'AERODROME_CLMM' : 'UNISWAP_V3') : undefined;
  return adapter ? { address: pool.reference.address, adapter, word_range } : undefined;
}
const reportedDepth = (p: InventoryPoolV3) => decimalRaw(p.depth.reported_liquidity_usd ?? p.depth.virtual_depth_usd ?? '0');

type Hydrated = { pool: Pool; ok: true } | { ok: false; reason: string };
/** Bounded tick hydration (file 11 #13): top-K by reported liquidity, word_range 1, one shared tick budget. */
async function hydrate(reader: EvmReader, block: Header, items: Array<{ pool: InventoryPoolV3; venue: Venue }>, budget: RoundBudget, counts: Record<string, number>) {
  const out = new Map<string, Hydrated>(); let ticks = 0;
  const ranked = [...items].sort((a, b) => { const d = reportedDepth(b.pool) - reportedDepth(a.pool); return d === 0n ? a.pool.id.localeCompare(b.pool.id) : d > 0n ? 1 : -1; });
  for (const [index, { pool, venue }] of ranked.entries()) {
    if (index >= UNIVERSE_HYDRATION.top_k) { out.set(pool.id, { ok: false, reason: 'HYDRATION_TOP_K' }); bump(counts, 'HYDRATION_TOP_K'); continue; }
    const ref = snapshotRef(pool, venue);
    if (!ref) { out.set(pool.id, { ok: false, reason: 'HYDRATION_NO_ADAPTER' }); bump(counts, 'HYDRATION_NO_ADAPTER'); continue; }
    if (budget.remainingMs() < 3000 || budget.rpcCallsUsed >= budget.limits.maxRpcCalls - 64 || ticks >= UNIVERSE_HYDRATION.max_ticks) { out.set(pool.id, { ok: false, reason: 'HYDRATION_BUDGET' }); bump(counts, 'HYDRATION_BUDGET'); continue; }
    try {
      const hydrated = await reader.pool(ref, block, budget.signal, UNIVERSE_HYDRATION.max_ticks - ticks);
      if (hydrated.kind === 'clmm') ticks += hydrated.ticks.length;
      out.set(pool.id, { ok: true, pool: hydrated });
    } catch (error) {
      const code = error instanceof ResearchError ? error.code : 'STATE_UNAVAILABLE';
      out.set(pool.id, { ok: false, reason: 'HYDRATION_' + code }); bump(counts, 'HYDRATION_' + code);
    }
  }
  return out;
}

/** S2 pool from a discovery pool plus its hydration; undefined (with a counted reason) when S2 cannot be filled honestly. */
function universePool(network: Network, state: InventoryV3, pool: InventoryPoolV3, venue: Venue, hydrated: Hydrated | undefined, counts: Record<string, number>): UniversePool | undefined {
  const block = state.block!, chain_id = CHAINS[network];
  const prices = new Map(state.assets.map((a) => [a.asset_id, a]));
  let solver: Pool;
  if (hydrated?.ok) solver = hydrated.pool;
  else {
    // Without hydration only a CPMM with reviewed pool bytecode is representable; CLMM state needs spacing, ticks and protocol fee.
    const s = pool.state, decimals = pool.asset_ids.map((a) => prices.get(a)?.decimals ?? null);
    if (!s || s.reserve0 === undefined || s.reserve1 === undefined || !venue.pool_code_hash || decimals.includes(null) || pool.reference.kind !== 'evm_contract' || s.lp_fee_pips === undefined) { bump(counts, 'NOT_HYDRATED'); return undefined; }
    const [a0, a1] = [...pool.asset_ids].sort((a, b) => BigInt(addressOf(a)) < BigInt(addressOf(b)) ? -1 : 1);
    solver = { kind: 'v2', address: pool.reference.address, token0: addressOf(a0), token1: addressOf(a1), decimals0: prices.get(a0)!.decimals!, decimals1: prices.get(a1)!.decimals!, fee_pips: s.lp_fee_pips, code_hash: venue.pool_code_hash, adapter_version: venue.id, reserve0: s.reserve0, reserve1: s.reserve1, stable: venue.family === 'SOLIDLY_STABLE' };
  }
  if (solver.kind === 'wrap') return undefined;
  const tokens: [string, string] = [assetId(network, solver.token0), assetId(network, solver.token1)];
  const capability = hydrated?.ok ? poolQuoteCapability(solver) : venueQuoteCapability(venue, pool.fee_mode);
  const fee_mode = pool.fee_mode !== 'unknown' ? pool.fee_mode : venue.family === 'ALGEBRA' ? 'dynamic' : 'static';
  const canonicality = solver.canonicality ?? null;
  const v4 = solver.kind === 'clmm' ? solver.v4 : undefined;
  const pool_ref = solver.address.toLowerCase();
  const stateU: UniversePool['state'] = solver.kind === 'v2' ? { kind: 'cpmm', reserve0: solver.reserve0, reserve1: solver.reserve1, stable: solver.stable }
    : { kind: v4 ? 'v4' as const : 'clmm' as const, sqrt_price_x96: solver.sqrt_price_x96, tick: solver.tick, liquidity: solver.liquidity, tick_spacing: solver.tick_spacing, word_min: solver.word_min, word_max: solver.word_max, ticks: solver.ticks, ...(v4 ? { manager: v4.manager, pool_id: pool_ref, key: v4.key, protocol_fee: v4.protocol_fee } : {}) } as UniversePool['state'];
  let depth_coverage: UniversePool['depth_coverage'] = 'none', depth_usd: UniversePool['depth_usd'] = null;
  if (hydrated?.ok) {
    const bands = depthBands(solver);
    depth_coverage = bands && bands.every((b) => b.complete) ? 'complete' : 'partial';
    const p0 = prices.get(tokens[0])?.usd_price?.value, p1 = prices.get(tokens[1])?.usd_price?.value;
    if (bands && p0 && p1) {
      const value = (i: number) => decimalString(decimalRaw(usd(bands[i].amount0_in, solver.decimals0, p0)) + decimalRaw(usd(bands[i].amount1_in, solver.decimals1, p1)));
      depth_usd = { pm50bps: value(0), pm100bps: value(1), pm200bps: value(2) };
    } else if (bands) bump(counts, 'DEPTH_UNPRICED');
  }
  const candidate = {
    pool_ref, chain_id, venue_id: venue.id, family: venue.family, status: venue.status, tokens, decimals: [solver.decimals0, solver.decimals1] as [number, number],
    fee_pips: solver.fee_pips, fee_mode, code_hash: solver.code_hash, adapter_version: solver.adapter_version, quote_capability: capability,
    sizing: canonicality && capability !== 'none' && venue.status === 'reviewed' ? 'sizable' as const : 'discovery_only' as const,
    subscription: v4 ? { emitter: v4.manager, pool_id: pool_ref } : { emitter: pool_ref }, // #13: V4 logs are emitted by the manager
    block, state: stateU, depth_coverage, depth_usd, canonicality, executor_venue_ids: {},
  };
  const parsed = universePoolSchema.safeParse(candidate);
  if (!parsed.success) { bump(counts, 'INVALID_UNIVERSE_POOL'); return undefined; }
  return parsed.data;
}

/** Live lender fee and capacity per funding asset at the pinned block; failures are counted, never guessed. */
async function liveLenders(reader: EvmReader, block: Header, lenders: RegistryLender[], network: Network, assets: string[], signal: AbortSignal, counts: Record<string, number>) {
  const live = new Map<string, CycleLender[]>();
  const pin = { blockHash: block.hash, requireCanonical: true };
  for (const lender of lenders) {
    const provider = PROVIDERS[lender.kind];
    if (!provider) { bump(counts, 'LENDER_KIND_UNSUPPORTED'); continue; }
    const wanted = assets.filter((a) => a !== ZERO && (lender.assets === 'any' || lender.assets.includes(assetId(network, a))));
    if (!wanted.length) continue;
    try {
      const code = await reader.rpc.rpc<Hex>('eth_getCode', [lender.address, pin], signal);
      if (code === '0x' || keccak256(code) !== lender.code_hash) { bump(counts, 'LENDER_CODE_MISMATCH'); continue; }
      let fee_bps: number, custody: Map<string, string>;
      if (provider === 'BALANCER_V2') {
        const collector = '0x' + (await reader.call(lender.address, 'getProtocolFeesCollector()', [], block, signal))[0].toString(16).padStart(40, '0');
        const pct = (await reader.call(collector, 'getFlashLoanFeePercentage()', [], block, signal))[0]; // on-chain, never from config (#6)
        fee_bps = Number(pct * 1_000_000n / 10n ** 18n) / 100; custody = new Map(wanted.map((a) => [a, lender.address]));
      } else if (provider === 'AAVE_V3') {
        fee_bps = Number((await reader.call(lender.address, 'FLASHLOAN_PREMIUM_TOTAL()', [], block, signal))[0]);
        const reserves = await reader.batchSettled(wanted.map((a) => ({ to: lender.address, signature: 'getReserveData(address)', args: [a] })), block, signal);
        custody = new Map();
        reserves.forEach((r, i) => {
          if (!r.ok || r.words.length < 9 || !(r.words[0] & 1n << 56n) || !(r.words[0] & 1n << 63n) || r.words[0] & 1n << 60n) { bump(counts, 'LENDER_RESERVE_UNAVAILABLE'); return; }
          custody.set(wanted[i], '0x' + r.words[8].toString(16).padStart(40, '0'));
        });
      } else if (provider === 'UNISWAP_V3_FLASH') {
        fee_bps = Number((await reader.call(lender.address, 'fee()', [], block, signal))[0]) / 100; custody = new Map(wanted.map((a) => [a, lender.address]));
      } else { fee_bps = 0; custody = new Map(wanted.map((a) => [a, lender.address])); } // Morpho Blue charges no flash fee
      const entries = [...custody.entries()];
      const balances = await reader.batchSettled(entries.map(([asset, holder]) => ({ to: asset, signature: 'balanceOf(address)', args: [holder] })), block, signal);
      balances.forEach((b, i) => {
        if (!b.ok) { bump(counts, 'LENDER_CAPACITY_UNAVAILABLE'); return; }
        const list = live.get(entries[i][0]) ?? [];
        list.push({ lender_id: lender.id, provider, address: lender.address, fee_bps, capacity_raw: b.words[0].toString() }); live.set(entries[i][0], list);
      });
    } catch (error) { bump(counts, 'LENDER_' + (error instanceof ResearchError ? error.code : 'STATE_UNAVAILABLE')); }
  }
  for (const list of live.values()) list.sort((a, b) => a.fee_bps - b.fee_bps || (BigInt(b.capacity_raw) > BigInt(a.capacity_raw) ? 1 : BigInt(b.capacity_raw) < BigInt(a.capacity_raw) ? -1 : 0));
  return live;
}

/** A directed hop signature: pool plus whether token0 is sold. Rotation-insensitive so any funding asset matches. */
const directed = (hops: Array<{ pool: string; sells0: boolean }>) => hops.map((h) => h.pool.toLowerCase() + (h.sells0 ? ':0' : ':1'));
function sameCycle(a: string[], b: string[]) { return a.length === b.length && a.some((_, shift) => a.every((x, i) => x === b[(i + shift) % b.length])); }
type Realized = NonNullable<z.infer<typeof cycleSchema>['realized']>;

/** Verified-realized arbs (file 11 #14) in the latest GT window within 24 h of the universe block. */
function groundTruthWindow(doc: ArbGroundTruthDocument | null, network: Network, block: bigint) {
  if (!doc || doc.network !== network || doc.outcome === 'INCONCLUSIVE' || block - BigInt(doc.window.to_block) > BLOCKS_PER_DAY[network]) return null;
  const records = doc.records.filter((r) => r.tier === 'verified_realized').map((r) => ({ r, sig: directed(r.hops.map((h) => ({ pool: h.pool_ref, sells0: BigInt(h.delta[0]) < 0n }))) }));
  return { doc, records, window_blocks: Number(BigInt(doc.window.to_block) - BigInt(doc.window.from_block) + 1n) };
}

export type UniverseDeps = { engine: ResearchEngine; budget: RoundBudget; registry: DiscoveryRegistry; deployments: Deployment[]; groundTruth: ArbGroundTruthDocument | null };
export async function buildArbUniverse(deps: UniverseDeps, raw: UniverseInput) {
  const input = universeInputSchema.parse(raw), { network } = input, counts: Record<string, number> = {}, warnings: string[] = [];
  const config = deps.registry.network(network);
  const reader = new InventoryReaderV3(deps.engine, network, deps.budget);
  const anchors = config.anchors.map(addressOf);
  const tokens = [...new Set([...anchors, ...input.seed_tokens])];
  const state = await readInventory(deps.engine, reader, tokens, [], input.min_depth_usd);
  if (!state.block) throw new ResearchError('UNIVERSE_STATE_UNAVAILABLE', 'No canonical pinned block for the universe; retry later.', true);
  const header = await reader.header();
  if (BigInt(header.number).toString() !== state.block.number || header.hash !== state.block.hash) throw new ResearchError('UNIVERSE_STATE_UNAVAILABLE', 'Pinned block changed during the build.', true);
  // Pools: liquidity-eligible, quotable, reviewed (research only when asked, and then discovery-only).
  const selected: Array<{ pool: InventoryPoolV3; venue: Venue }> = [];
  for (const pool of state.pools) {
    const venue = venueOf(pool, config.venues);
    if (!pool.liquidity_eligible) { bump(counts, 'NOT_LIQUIDITY_ELIGIBLE'); continue; }
    if (!venue) { bump(counts, 'VENUE_UNKNOWN'); continue; }
    if (venue.status === 'research' && !input.include_research) { bump(counts, 'RESEARCH_EXCLUDED'); continue; }
    if (venue.family === 'V4' && !input.include_v4) { bump(counts, 'V4_EXCLUDED'); continue; }
    if (pool.hook || venueQuoteCapability(venue, pool.fee_mode) === 'none') { bump(counts, 'QUOTE_CAPABILITY_NONE'); continue; }
    selected.push({ pool, venue });
  }
  const hydration = await hydrate(reader.reader, header, selected, deps.budget, counts);
  const pools: UniversePool[] = [];
  for (const { pool, venue } of selected) { const u = universePool(network, state, pool, venue, hydration.get(pool.id), counts); if (u && !pools.some((p) => p.pool_ref === u.pool_ref)) pools.push(u); }
  pools.sort((a, b) => a.pool_ref.localeCompare(b.pool_ref));
  // Cycles: research pools are discovery-only, never part of a cycle; quote_capability 'none' never enters the solver graph.
  const graph = pools.filter((p) => p.status === 'reviewed' && p.quote_capability !== 'none');
  const solverPools = graph.map(universePoolToPool), solverByRef = new Map(solverPools.map((p) => [p.address, p])), byRef = new Map(graph.map((p) => [p.pool_ref, p]));
  const assets = [...new Set(solverPools.flatMap((p) => [p.token0, p.token1]))].sort();
  const lenders = await liveLenders(reader.reader, header, config.lenders, network, assets, deps.budget.signal, counts);
  const gt = groundTruthWindow(deps.groundTruth, network, BigInt(state.block.number));
  let nodes = 0, exhausted = false;
  type Draft = { cycle: { cycle_id: string; funding_asset: string; hops: CycleHop[]; fee_floor_bps_approx: number; lenders: CycleLender[]; realized: Realized | null; rank: number }; net: bigint | null; minDepth: bigint };
  const drafts = new Map<string, Draft>();
  for (const asset of [...lenders.keys()].sort()) {
    const funders = lenders.get(asset)!;
    const remaining = input.max_nodes_visited - nodes;
    if (remaining <= 0) { exhausted = true; break; }
    const walk = enumerateClosedRoutes(solverPools, asset, { maxHops: input.max_hops, maxRoutes: 4000, maxNodes: remaining });
    nodes += walk.nodes_visited; exhausted ||= walk.exhausted;
    for (const route of walk.routes) {
      // M4 self-route lock: a V3-flash lender is locked during its callback, so it cannot fund a route through itself.
      const routePools = route.hops.map((h) => solverByRef.get(h.pool)!);
      const usable = funders.filter((l) => lenderRoutablePools(routePools, l).length === routePools.length);
      const hops = route.hops.map((h) => ({ pool_ref: h.pool, token_in: assetId(network, h.token_in), token_out: assetId(network, h.token_out) }));
      const funding_asset = assetId(network, asset), cycle_id = arbCycleId(funding_asset, hops);
      const members = route.hops.map((h) => byRef.get(h.pool)!);
      const sig = directed(route.hops.map((h, i) => ({ pool: h.pool, sells0: h.token_in === routePools[i].token0 })));
      let realized: Realized | null = null, net: bigint | null = null;
      if (gt) {
        const matches = gt.records.filter((m) => sameCycle(m.sig, sig));
        net = matches.reduce((sum, m) => sum + (m.r.net_usd === null ? 0n : signedRaw(m.r.net_usd)), 0n);
        realized = { window_blocks: gt.window_blocks, arbs: matches.length, gross_usd: decimalString(matches.reduce((s, m) => s + decimalRaw(m.r.gross_usd), 0n)), net_usd: signedString(net), bots: new Set(matches.map((m) => m.r.to)).size };
      }
      const minDepth = members.reduce((min, p) => { const d = p.depth_usd ? decimalRaw(p.depth_usd.pm100bps) : 0n; return min === -1n || d < min ? d : min; }, -1n);
      drafts.set(cycle_id, { cycle: { cycle_id, funding_asset, hops, fee_floor_bps_approx: members.reduce((s, p) => s + p.fee_pips, 0) / 100, lenders: usable.slice(0, 4), realized, rank: 0 }, net, minDepth });
    }
  }
  // Rank: verified realized net (24 h), then fee floor ascending, then the shallowest hop's depth descending; cap after ranking.
  const ranked = [...drafts.values()].sort((a, b) => {
    if (a.net !== b.net) { if (a.net === null) return 1; if (b.net === null) return -1; return a.net > b.net ? -1 : 1; }
    if (a.cycle.fee_floor_bps_approx !== b.cycle.fee_floor_bps_approx) return a.cycle.fee_floor_bps_approx - b.cycle.fee_floor_bps_approx;
    if (a.minDepth !== b.minDepth) return a.minDepth > b.minDepth ? -1 : 1;
    return a.cycle.cycle_id.localeCompare(b.cycle.cycle_id);
  });
  const cycles = ranked.slice(0, input.max_cycles).map((d, rank) => ({ ...d.cycle, rank }));
  if (ranked.length > cycles.length) bump(counts, 'MAX_CYCLES', ranked.length - cycles.length);
  // Coverage self-check: verified gross whose hop pools all sit inside this universe.
  let realized_value_share: number | null = null;
  if (gt) {
    const inside = new Set(pools.map((p) => p.pool_ref)), total = gt.records.reduce((s, m) => s + decimalRaw(m.r.gross_usd), 0n);
    const covered = gt.records.filter((m) => m.r.hops.every((h) => inside.has(h.pool_ref.toLowerCase()))).reduce((s, m) => s + decimalRaw(m.r.gross_usd), 0n);
    realized_value_share = total === 0n ? null : Number(covered * 1_000_000n / total) / 1_000_000;
    if (total === 0n) warnings.push('Ground-truth window has no verified realized gross; realized_value_share is null.');
  } else warnings.push('No ground-truth artifact within 24 h: realized is null and ranking is structural only.');
  if (exhausted) { bump(counts, 'ENUMERATION_BUDGET'); warnings.push('Cycle enumeration hit max_nodes_visited; the cycle set is incomplete.'); }
  const unpriced = state.assets.filter((a) => !a.usd_price && pools.some((p) => (p.tokens as string[]).includes(a.asset_id))).length;
  const truncated = state.coverage.truncated || exhausted || (counts.MAX_CYCLES ?? 0) > 0;
  const coverage = {
    ...state.coverage, excluded_counts: { ...state.coverage.excluded_counts, ...counts }, truncated, pools_watched: pools.length,
    tokens_watched: new Set(pools.flatMap((p) => p.tokens)).size,
    archive: 'not_required' as const, nodes_visited: nodes, max_nodes_visited: input.max_nodes_visited, pools_hydrated: [...hydration.values()].filter((h) => h.ok).length,
    unauthenticated_emitters: 0, unsupported_emitters: 0, unpriced,
    realized_value_share, ground_truth_window: gt ? { from_block: gt.doc.window.from_block, to_block: gt.doc.window.to_block } : null,
  };
  warnings.push('Discovery and ranking only; re-read state and quote each cycle before any decision. execution:false.');
  return arbUniversePayloadSchema.parse({
    schema_version: 'flashloan.arb.universe.v1', network, chain_id: CHAINS[network], block: state.block, registry_version: deps.registry.version,
    cache_key: universeCacheKey(deps.registry, deps.deployments, input), outcome: !pools.length ? 'EMPTY' : truncated || state.outcome === 'PARTIAL' ? 'PARTIAL' : 'SUCCESS',
    pools, cycles, coverage, warnings: warnings.slice(0, 64),
  });
}
/** Fits a universe into the public envelope: drop the lowest-ranked cycles, then pools no kept cycle uses. */
export function fitUniverse(payload: z.infer<typeof arbUniversePayloadSchema>, maxBytes: number) {
  const size = () => Buffer.byteLength(JSON.stringify(payload));
  const mark = () => { payload.coverage.truncated = true; payload.outcome = payload.outcome === 'EMPTY' ? 'EMPTY' : 'PARTIAL'; payload.coverage.deferred_counts.BYTE_LIMIT = (payload.coverage.deferred_counts.BYTE_LIMIT ?? 0) + 1; };
  while (size() > maxBytes && payload.cycles.length) { payload.cycles.pop(); mark(); }
  const used = () => new Set(payload.cycles.flatMap((c) => c.hops.map((h) => h.pool_ref)));
  while (size() > maxBytes && payload.pools.length) { const keep = used(), at = payload.pools.findLastIndex((p) => !keep.has(p.pool_ref)); payload.pools.splice(at === -1 ? payload.pools.length - 1 : at, 1); mark(); }
  return payload;
}
