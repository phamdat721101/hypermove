import { z } from 'zod';
import { SuiReader, suiRuntimeSupported, type SuiOptions } from './sui';
import { suiSnapshotSchema, type suiOperations } from './sui-contracts';
import { evmNetwork, chainCatalog, normalizeCoinType } from './networks';
import { requireResearch, researchVerified, registryHash, type ResearchEvidence } from './verification';
import { DexScreener, inventorySchema } from './discovery';
import { getTokenMovers, type MoverInput } from './movers';
import { EvmReader, evmSnapshotSchema, type Deployment, type EvmSnapshot } from './evm';
import { solve, type SearchOptions } from './math';
import { simulatePlan, type EngineAdapter } from './simulation';
import { XrplReader, xrplCycles, type XrplSnapshot } from './xrpl';
import { JsonClient, type RoundBudget } from './transport';
import type { InitializationLocator } from './pool-resolution';
import { ResearchError, type Input, type RiskPolicy } from './contracts';
import type { DiscoveryRegistry } from './discovery-registry';
import type { V4InitializeIndex } from './storage';
import { discoverV3, getMoversV2, getWatchlistV1 } from './discovery-v8';
import type { discoveryV3InputSchema, moversV2InputSchema, watchlistInputSchema } from './v8-contracts';

export type ComputeTask = { kind: 'solve'; snapshot: EvmSnapshot; asset: string; policy: RiskPolicy; search?: SearchOptions } | { kind: 'xrpl'; snapshot: XrplSnapshot };
export type ComputeAdapter = (task: ComputeTask, signal?: AbortSignal) => Promise<unknown>;
export function computeInline(task: ComputeTask) {
  if (task.kind === 'xrpl') return xrplCycles(task.snapshot);
  return solve(task.snapshot.pools, task.asset, task.snapshot.lender, task.policy, task.search);
}
export type EngineOptions = { endpoints: Partial<Record<'ethereum' | 'arbitrum' | 'base' | 'robinhood' | 'xrpl', string>>; deployments: Deployment[]; evidence?: ResearchEvidence[]; sui?: SuiOptions; fetcher?: typeof fetch; engine?: EngineAdapter; budget?: RoundBudget; initializations?: InitializationLocator[]; discoveryRegistry?: DiscoveryRegistry; /** File 11 #16 persistent Initialize index; absent = legacy request-scoped V4 scans. */ initializeIndex?: V4InitializeIndex };
/** Domain execution shared by owned jobs and stateless requests; no repositories or memory. */
export class ResearchEngine {
  private readonly dex: DexScreener;
  constructor(readonly options: EngineOptions) { this.dex = new DexScreener(options.fetcher, undefined, undefined, options.budget); }
  withBudget(budget: RoundBudget) { return new ResearchEngine({ ...this.options, budget }); }
  registryHash() { return registryHash(this.options.deployments, this.options.sui?.deployments ?? []); }
  movers(input: MoverInput, signal?: AbortSignal, budgetMs?: number) { return getTokenMovers(this.dex, input, signal, budgetMs); }
  discoverV3(input: z.input<typeof discoveryV3InputSchema>, signal?: AbortSignal) { return discoverV3(this, input, signal); }
  moversV2(input: z.input<typeof moversV2InputSchema>, signal?: AbortSignal) { return getMoversV2(this, input, signal); }
  watchlist(input: z.input<typeof watchlistInputSchema>, signal?: AbortSignal) { return getWatchlistV1(this, input, signal); }
  requireResearch(network: string) { if (network === 'sui' && !suiRuntimeSupported()) throw new ResearchError('SUI_RUNTIME_UNSUPPORTED', 'Sui research requires Node 22.12 or newer.'); requireResearch(network, this.options.evidence ?? [], this.registryHash()); }
  capabilities() { return Object.entries(chainCatalog).map(([network, chain]) => ({ network, ...chain, discovery: true, research: network === 'sui' ? suiRuntimeSupported() && Boolean(this.options.sui) && researchVerified(network, this.options.evidence ?? [], this.registryHash()) : Boolean(this.options.endpoints[network as keyof EngineOptions['endpoints']]) && (network !== 'robinhood' || researchVerified(network, this.options.evidence ?? [], this.registryHash())), verification_required: network === 'robinhood' || network === 'sui' })); }
  suiReader() { if (!this.options.sui) throw new ResearchError('NETWORK_UNCONFIGURED', 'Sui GraphQL/gRPC endpoints and deployment registry are not configured.'); return new SuiReader({ ...this.options.sui, fetcher: this.options.fetcher }); }
  suiSnapshot(input: z.infer<typeof suiOperations.sui_ingest_pool_state>, signal?: AbortSignal) { this.requireResearch('sui'); return this.suiReader().snapshot(input, signal); }
  suiSize(snapshot: unknown, input: z.infer<typeof suiOperations.sui_solve_arbitrage_routes>, signal?: AbortSignal) { this.requireResearch('sui'); return this.suiReader().solve(suiSnapshotSchema.parse(snapshot), input, signal); }
  suiSimulate(plan: unknown, signal?: AbortSignal) { this.requireResearch('sui'); return this.suiReader().simulate(plan, signal); }
  rpc(network: keyof EngineOptions['endpoints']) {
    const endpoint = this.options.endpoints[network];
    if (!endpoint) throw new ResearchError('NETWORK_UNCONFIGURED', 'This network endpoint is not configured.');
    return new JsonClient(endpoint, this.options.fetcher, 15000, this.options.budget);
  }
  async discover(input: Input<'flashloan_discover_arbitrage_pools'>, signal?: AbortSignal) {
    const native = input.network === 'sui' && this.options.sui && this.options.sui.deployments.length;
    const result = await this.dex.discover(input, signal, Boolean(native));
    if (!native) return result;
    const excluded = new Set(input.exclude_tokens.map(normalizeCoinType));
    const extra = await this.suiReader().inventory(input.tokens.map(normalizeCoinType).filter((t) => !excluded.has(t)), input.native_cursors, input.native_page_size, input.native_max_pages, signal);
    const pools = new Map(result.pools.map((p) => [p.id, p]));
    for (const p of extra.pools) { const previous = pools.get(p.id); pools.set(p.id, previous ? { ...previous, protocol: p.protocol, provenance: [...previous.provenance, ...p.provenance] } : p); }
    result.pools = [...pools.values()].sort((a, b) => a.id.localeCompare(b.id));
    result.coverage.push(...extra.coverage); result.diagnostics.push(...extra.diagnostics);
    for (const token of result.token_results) { const matches = token.disposition === 'EXCLUDED' ? [] : result.pools.filter((p) => p.asset_ids.includes(token.token)); token.pool_ids = matches.map((p) => p.id); token.discovered_count = matches.length; token.liquidity_eligible_count = matches.filter((p) => p.liquidity_eligible).length; }
    if (result.coverage.length && result.coverage.every((c) => c.status === 'FAILED')) throw new ResearchError('DISCOVERY_UNAVAILABLE', 'No discovery source succeeded.', true);
    result.outcome = result.diagnostics.length || result.coverage.some((c) => !c.retrieval_complete) ? 'PARTIAL' : result.pools.length ? 'SUCCESS' : 'EMPTY';
    return inventorySchema.parse(result);
  }
  async snapshot(input: Input<'flashloan_ingest_l2_tickmap_and_reserves'>, signal?: AbortSignal, maxTicks?: number, atBlock?: string) {
    this.requireResearch(input.network);
    return new EvmReader(this.rpc(input.network), input.network, this.options.deployments).snapshot(input, signal, maxTicks, atBlock);
  }
  async canonical(snapshot: EvmSnapshot, signal?: AbortSignal) {
    this.requireResearch(snapshot.network);
    const block = await this.rpc(snapshot.network).rpc<{ hash: string } | null>('eth_getBlockByNumber', [snapshot.block.number, false], signal);
    if (!block || block.hash !== snapshot.block.hash) throw new ResearchError('REORG', 'Snapshot block is no longer canonical.');
  }
  async size(raw: unknown, id: string, asset: string, policy: RiskPolicy, signal?: AbortSignal, compute?: ComputeAdapter) {
    const snapshot = evmSnapshotSchema.parse(raw);
    this.requireResearch(snapshot.network);
    if (snapshot.lender.asset !== asset) throw new ResearchError('INVALID_ASSET', 'Borrow asset does not match the snapshot lender.');
    const task: ComputeTask = { kind: 'solve', snapshot, asset, policy };
    const solution = (compute ? await compute(task, signal) : computeInline(task)) as ReturnType<typeof solve>;
    return { ...solution, snapshot_id: id, snapshot, borrow_asset: asset, policy };
  }
  simulate(plan: unknown, input: Input<'flashloan_simulate_atomic_revm'>, signal?: AbortSignal) {
    const network = evmNetwork.parse((plan as { snapshot: { network: string } }).snapshot.network);
    this.requireResearch(network);
    return simulatePlan(new EvmReader(this.rpc(network), network, this.options.deployments), plan, input, this.options.engine, signal);
  }
  xrplDiscover(input: Input<'xrpl_discover_arbitrage_routes'>, signal?: AbortSignal) { return new XrplReader(this.rpc('xrpl')).discover(input, signal); }
  async xrplSimulate(snapshot: XrplSnapshot, transaction?: Record<string, unknown>, signal?: AbortSignal, compute?: ComputeAdapter) {
    if (!transaction && compute) return { status: 'ESTIMATE_ONLY', snapshot_ledger_hash: snapshot.ledger_hash, funding_mode: snapshot.funding.mode, ...await compute({ kind: 'xrpl', snapshot }, signal) as ReturnType<typeof xrplCycles>, warnings: snapshot.warnings, atomicity_proven: false };
    return new XrplReader(this.rpc('xrpl')).simulate(snapshot, transaction, signal);
  }
}
