import { z } from 'zod';
import type { ResearchEngine } from './engine';
import { DexScreener, inventorySchema } from './discovery';
import { InventoryReaderV3, decimalRaw, type NativeInventorySeed } from './inventory-v3';
import { collectCandidates, rankMovers } from './movers-v2';
import { RoundBudget } from './transport';
import { assetId, discoveryV3InputSchema, moversV2InputSchema, moversV2Schema, watchlistInputSchema, watchlistV1Schema, inventoryV3Schema } from './v8-contracts';
import { PUBLIC_LIMITS, PUBLIC_VERSION, publicWireBytes } from './public-contracts';

function fitsWire(operation: string, data: { warnings: string[] }) { return publicWireBytes({ schema_version: PUBLIC_VERSION, request_id: '0'.repeat(36), operation, ok: true, data, warnings: data.warnings, execution: false }) <= PUBLIC_LIMITS.body_bytes - 2048; }

/** One public lease owns one round; two seconds remain for envelope checks and serialization. */
async function inRound<T>(engine: ResearchEngine, signal: AbortSignal | undefined, work: (engine: ResearchEngine, budget: RoundBudget) => Promise<T>): Promise<T> {
  const budget = new RoundBudget({ maxRpcCalls: 600, maxEvaluations: 0, deadlineMs: 23000 }, signal ?? new AbortController().signal);
  try { return await work(engine.withBudget(budget), budget); } finally { budget.dispose(); }
}
export async function inventory(engine: ResearchEngine, reader: InventoryReaderV3, tokens: string[], excluded: string[], minDepth: number, native: NativeInventorySeed[] = []) {
  const dex = new DexScreener(engine.options.fetcher, undefined, undefined, reader.budget);
  const base = await dex.discover({ network: reader.network, tokens, exclude_tokens: excluded, min_liquidity_usd: 0, idempotency_key: 'v8' }, reader.budget.signal, true).catch(() => inventorySchema.parse({ schema_version: 'flashloan.inventory.v2', network: reader.network, observed_at: new Date().toISOString(), outcome: 'PARTIAL', pools: [], token_results: [], coverage: tokens.map((token) => ({ source: 'dexscreener:token-pairs/v1', token, scope: 'provider_response', status: 'FAILED', raw_count: 0, valid_count: 0, retrieval_complete: false, exhaustive: false, next_cursor: null, observed_at: new Date().toISOString() })), diagnostics: [], warnings: [] }));
  return reader.inventory(base, tokens, excluded, minDepth, native);
}
export async function discoverV3(engine: ResearchEngine, raw: z.input<typeof discoveryV3InputSchema>, signal?: AbortSignal) {
  const input = discoveryV3InputSchema.parse(raw);
  return inRound(engine, signal, async (bounded, budget) => {
    const reader = new InventoryReaderV3(bounded, input.network, budget);
    const result = await inventory(bounded, reader, [...new Set(input.tokens)], input.exclude_tokens, input.min_liquidity_usd);
    while (!fitsWire('flashloan_discover_arbitrage_pools', result) && result.pools.length) { result.pools.pop(); result.coverage.truncated = true; result.coverage.deferred_counts.BYTE_LIMIT = (result.coverage.deferred_counts.BYTE_LIMIT ?? 0) + 1; result.outcome = 'PARTIAL'; }
    const ids = new Set(result.pools.map((p) => p.id));
    for (const row of result.token_results) { row.pool_ids = row.pool_ids.filter((id) => ids.has(id)); row.liquidity_eligible_count = result.pools.filter((p) => row.pool_ids.includes(p.id) && p.liquidity_eligible).length; }
    result.coverage.pools_watched = result.pools.filter((p) => p.liquidity_eligible).length;
    return inventoryV3Schema.parse(result);
  });
}
async function marketNetwork(engine: ResearchEngine, budget: RoundBudget, network: z.infer<typeof moversV2InputSchema>['networks'][number], seeds: string[], excluded: string[], minimum: number, limit: number) {
  const reader = new InventoryReaderV3(engine, network, budget), candidates = await collectCandidates(engine, reader, seeds, excluded);
  const anchors = reader.registry.network(network).anchors.map((a) => a.endsWith('/slip44:60') ? '0x' + '0'.repeat(40) : a.split('/erc20:')[1]);
  const tokens = [...new Set([...candidates.tokens, ...anchors])].filter((t) => !excluded.includes(t));
  const state = await inventory(engine, reader, tokens, excluded, minimum, candidates.native_pools);
  return { ranked: rankMovers(reader, candidates, state, limit), inventory: state, reader };
}
export async function getMoversV2(engine: ResearchEngine, raw: z.input<typeof moversV2InputSchema>, signal?: AbortSignal) {
  const parameters = moversV2InputSchema.parse(raw), started_at = new Date().toISOString();
  return inRound(engine, signal, async (bounded, budget) => {
    const chains: Array<Awaited<ReturnType<typeof marketNetwork>>['ranked']> = [];
    for (const network of parameters.networks) { const result = await marketNetwork(bounded, budget, network, parameters.seed_tokens[network] ?? [], parameters.exclude_tokens[network] ?? [], parameters.min_liquidity_usd, parameters.limit_per_chain); chains.push(result.ranked); }
    return moversV2Schema.parse({ schema_version: 'flashloan.movers.v2', started_at, completed_at: new Date().toISOString(), parameters, chains, warnings: ['Signals rank candidates only. Missing historical signals contribute zero; social declarations are unverified.'] });
  });
}
export async function getWatchlistV1(engine: ResearchEngine, raw: z.input<typeof watchlistInputSchema>, signal?: AbortSignal) {
  const input = watchlistInputSchema.parse(raw);
  return inRound(engine, signal, async (bounded, budget) => {
    const { ranked, inventory: state, reader } = await marketNetwork(bounded, budget, input.network, input.seed_tokens, input.exclude_tokens, input.min_virtual_depth_usd, input.max_tokens);
    const eligible = state.pools.filter((p) => p.liquidity_eligible).sort((a, b) => { const av = decimalRaw(a.depth.virtual_depth_usd!), bv = decimalRaw(b.depth.virtual_depth_usd!); return av === bv ? a.id.localeCompare(b.id) : av > bv ? -1 : 1; });
    const selected = new Map<string, typeof eligible[number]>(), tokens: Array<{ token_id: string; score: number; reasons: string[] }> = [];
    const coverage = ranked.coverage;
    for (const token of ranked.tokens) {
      const pools = eligible.filter((p) => p.asset_ids.includes(token.token_id));
      const required = pools.slice(0, 2).filter((p) => !selected.has(p.id));
      if (selected.size + required.length > input.max_pools) { coverage.truncated = true; coverage.deferred_counts.POOL_BUDGET_TOKEN = (coverage.deferred_counts.POOL_BUDGET_TOKEN ?? 0) + 1; continue; }
      required.forEach((p) => selected.set(p.id, p)); tokens.push({ token_id: token.token_id, score: token.score, reasons: token.sources });
    }
    const anchors = reader.registry.network(input.network).anchors.filter((a) => !input.exclude_tokens.some((t) => assetId(input.network, t) === a));
    for (const pool of eligible.filter((p) => p.asset_ids.some((a) => anchors.includes(a) || tokens.some((t) => t.token_id === a)))) {
      if (selected.has(pool.id)) continue;
      if (selected.size >= input.max_pools) { coverage.truncated = true; coverage.deferred_counts.POOL_LIMIT = (coverage.deferred_counts.POOL_LIMIT ?? 0) + 1; continue; }
      selected.set(pool.id, pool);
    }
    const result = { schema_version: 'flashloan.watchlist.v1' as const, network: input.network, chain_id: state.chain_id, observed_at: state.observed_at, block: state.block, registry_version: state.registry_version, ttl_seconds: 120 as const, outcome: ranked.outcome, tokens, pools: [...selected.values()], assets: state.assets, anchors, coverage, warnings: state.warnings };
    while (!fitsWire('flashloan_get_watchlist_v1', result) && result.pools.length) { result.pools.pop(); coverage.truncated = true; coverage.deferred_counts.BYTE_LIMIT = (coverage.deferred_counts.BYTE_LIMIT ?? 0) + 1; }
    result.tokens = result.tokens.filter((t) => result.pools.filter((p) => p.asset_ids.includes(t.token_id)).length >= 2);
    result.assets = result.assets.filter((a) => result.pools.some((p) => p.asset_ids.includes(a.asset_id)));
    coverage.tokens_watched = result.tokens.length; coverage.pools_watched = result.pools.length;
    result.outcome = coverage.truncated || ranked.outcome === 'PARTIAL' ? 'PARTIAL' : result.tokens.length || result.pools.length ? 'SUCCESS' : 'EMPTY';
    return watchlistV1Schema.parse(result);
  });
}
