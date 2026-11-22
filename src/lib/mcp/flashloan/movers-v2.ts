import { decodeEventLog, parseAbi, type Hex } from 'viem';
import { z } from 'zod';
import { DexScreener } from './discovery';
import { ResearchError } from './contracts';
import { address, CHAINS, evmNetwork } from './networks';
import type { ResearchEngine } from './engine';
import type { InventoryReaderV3, NativeInventorySeed } from './inventory-v3';
import { boundedJson, boundedEvmLogs } from './transport';
import { RequestBudget } from './discovery';
import { assetId, emptyCoverage, moverTokenV2Schema, usdSchema, type CoverageV8, type InventoryV3 } from './v8-contracts';

const geckoBudget = new RequestBudget(2100);
const finite = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : null;
const usd = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && usdSchema.safeParse(String(value)).success ? String(value) : typeof value === 'string' && usdSchema.safeParse(value).success ? value : null;
const marketSchema = z.object({ chainId: z.string(), pairAddress: z.string().max(1024), dexId: z.string().max(128), baseToken: z.object({ address, symbol: z.string().max(128).optional(), name: z.string().max(256).optional() }), liquidity: z.object({ usd: z.number().finite().nonnegative() }).nullish(), priceChange: z.record(z.string(), z.unknown()).nullish(), volume: z.record(z.string(), z.unknown()).nullish(), txns: z.record(z.string(), z.unknown()).nullish(), pairCreatedAt: z.number().finite().nullish(), info: z.object({ socials: z.array(z.object({ url: z.string().max(2048) })).max(16).optional() }).nullish() });
export type MarketV2 = z.infer<typeof marketSchema>;
export type CandidateSources = { tokens: string[]; sources: Map<string, Set<string>>; markets: Map<string, MarketV2>; coverage: CoverageV8; native_pools: NativeInventorySeed[] };
const creationAbi = parseAbi(['event PairCreated(address indexed token0,address indexed token1,address pair,uint256 pairCount)', 'event PoolCreated(address indexed token0,address indexed token1,uint24 indexed fee,int24 tickSpacing,address pool)', 'event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)']);

/** Host-owned adapters only: provider data cannot select an endpoint, RPC method, or procedure. */
export async function collectCandidates(engine: ResearchEngine, reader: InventoryReaderV3, seeds: string[], excluded: string[]): Promise<CandidateSources> {
  const network = reader.network, budget = reader.budget, sources = new Map<string, Set<string>>(), markets = new Map<string, MarketV2>(), coverage = emptyCoverage();
  const native_pools: NativeInventorySeed[] = [];
  const excludedSeen = new Set<string>();
  const controller = new AbortController(), abort = () => controller.abort();
  budget.signal.addEventListener('abort', abort, { once: true }); if (budget.signal.aborted) abort();
  const sourceTimer = setTimeout(abort, Math.max(1, Math.min(6000, budget.remainingMs()))), sourceSignal = controller.signal;
  const dex = new DexScreener(engine.options.fetcher, undefined, undefined, budget);
  const add = (raw: unknown, source: string) => { const parsed = address.safeParse(raw); if (!parsed.success) return false; if (excluded.includes(parsed.data)) { excludedSeen.add(parsed.data); coverage.excluded_counts.CALLER_EXCLUDED = excludedSeen.size; return false; } const set = sources.get(parsed.data) ?? new Set<string>(); set.add(source); if (sources.size < 1000 || sources.has(parsed.data)) sources.set(parsed.data, set); else { coverage.truncated = true; coverage.deferred_counts.CANDIDATE_LIMIT = (coverage.deferred_counts.CANDIDATE_LIMIT ?? 0) + 1; } return true; };
  seeds.forEach((token) => add(token, 'seed'));
  const source = async (name: string, work: () => Promise<{ raw: number; valid: number; status?: 'UNSUPPORTED'; reason?: string }>) => {
    try { const result = await work(); coverage.source_results.push({ source: name, status: result.status ?? 'SUCCESS', raw_count: result.raw, valid_count: result.valid, truncated: false, reason: result.reason ?? null }); }
    catch (error) { coverage.source_results.push({ source: name, status: 'FAILED', raw_count: 0, valid_count: 0, truncated: true, reason: sourceSignal.aborted && !budget.signal.aborted ? 'SOURCE_DEADLINE' : error instanceof ResearchError ? error.code : 'INVALID_RESPONSE' }); }
  };
  let marketAttempts = 0;
  const data = (path: string) => dex.marketData(path, sourceSignal, { deadlineMs: Date.now() + Math.min(6000, budget.remainingMs()), timeoutMs: Math.min(3000, budget.remainingMs()), onAttempt: () => { if (++marketAttempts > 16) throw new ResearchError('SOURCE_BUDGET', 'Market request budget exhausted.'); } });
  try {
  await Promise.all([
    source('dexscreener.search', async () => { const raw = await data('/latest/dex/search?q=' + encodeURIComponent(network)); const rows = (raw as { pairs?: unknown })?.pairs; if (!Array.isArray(rows) || rows.length > 1000) throw new ResearchError('INVALID_RESPONSE', 'Invalid search result.'); let valid = 0; for (const row of rows) if (row?.chainId === network && add(row?.baseToken?.address, 'dexscreener.search')) valid++; return { raw: rows.length, valid }; }),
    ...[['/token-profiles/latest/v1', 'dexscreener.profile'], ['/token-boosts/latest/v1', 'dexscreener.boost']].map(([path, name]) => source(name, async () => { const rows = await data(path); if (!Array.isArray(rows) || rows.length > 1000) throw new ResearchError('INVALID_RESPONSE', 'Invalid feed result.'); let valid = 0; for (const row of rows) if (row?.chainId === network && add(row?.tokenAddress, name)) valid++; return { raw: rows.length, valid }; })),
    source('geckoterminal.trending', async () => {
      const id = ({ ethereum: 'eth', base: 'base', arbitrum: 'arbitrum', robinhood: null } as const)[network];
      if (!id) return { raw: 0, valid: 0, status: 'UNSUPPORTED', reason: 'PROVIDER_NETWORK_UNSUPPORTED' };
      await geckoBudget.acquire(sourceSignal); budget.rpc();
      const response = await (engine.options.fetcher ?? fetch)('https://api.geckoterminal.com/api/v2/networks/' + id + '/trending_pools', { redirect: 'error', signal: sourceSignal });
      if (!response.ok) { await response.body?.cancel(); throw new ResearchError('SOURCE_UNAVAILABLE', 'GeckoTerminal HTTP ' + response.status, response.status === 429 || response.status >= 500); }
      const result = await boundedJson(response, 1_000_000, sourceSignal) as { data?: unknown[] };
      if (!Array.isArray(result.data) || result.data.length > 1000) throw new ResearchError('INVALID_RESPONSE', 'Invalid trending result.');
      let valid = 0;
      for (const row of result.data as Array<{ relationships?: { base_token?: { data?: { id?: string } } } }>) { const raw = row.relationships?.base_token?.data?.id; if (raw?.startsWith(id + '_') && add(raw.slice(id.length + 1), 'geckoterminal.trending')) valid++; }
      return { raw: result.data.length, valid };
    }),
    source('onchain.pool_created', async () => {
      const block = await reader.header(sourceSignal), head = BigInt(block.number); let raw = 0, valid = 0;
      const reviewed = reader.registry.network(network).venues.filter((v) => v.status === 'reviewed');
      const configured = reviewed.filter((v) => ['V2', 'V3', 'V4'].includes(v.family));
      const unsupported = reviewed.length - configured.length;
      if (unsupported) { coverage.excluded_counts.ONCHAIN_UNSUPPORTED_FAMILY = unsupported; coverage.source_results.push({ source: 'onchain.pool_created.unsupported_families', status: 'UNSUPPORTED', raw_count: unsupported, valid_count: 0, truncated: false, reason: 'CREATION_ADAPTER_UNSUPPORTED' }); }
      if (!configured.length) return { raw: 0, valid: 0, status: 'UNSUPPORTED', reason: 'NO_REVIEWED_CREATION_VENUES' };
      const venues = configured.slice(0, 8);
      if (configured.length > venues.length) { coverage.truncated = true; coverage.deferred_counts.ONCHAIN_VENUE_LIMIT = configured.length - venues.length; }
      for (const venue of venues) for (let page = 0; page < 5; page++) {
        const end = head - BigInt(page * 200); if (end < 0n) break;
        const start = end > 199n ? end - 199n : 0n;
        const logs = await boundedEvmLogs<{ address: string; topics: Hex[]; data: Hex; blockNumber: Hex; removed?: boolean }>(engine.rpc(network), { address: venue.factory, fromBlock: '0x' + start.toString(16), toBlock: '0x' + end.toString(16) }, sourceSignal);
        raw += logs.length;
        for (const log of logs) {
          if (log.removed || log.address?.toLowerCase() !== venue.factory || BigInt(log.blockNumber) < start || BigInt(log.blockNumber) > end) continue;
          try {
            const event = decodeEventLog({ abi: creationAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data }); const args = event.args;
            const sourceName = event.eventName === 'Initialize' ? 'onchain.v4_initialize' : 'onchain.pool_created';
            const token0 = 'token0' in args ? args.token0 : args.currency0, token1 = 'token1' in args ? args.token1 : args.currency1;
            if (add(token0, sourceName)) valid++; add(token1, sourceName);
            if (native_pools.length >= 400) { coverage.truncated = true; coverage.deferred_counts.NATIVE_POOL_LIMIT = (coverage.deferred_counts.NATIVE_POOL_LIMIT ?? 0) + 1; continue; }
            const reference = event.eventName === 'Initialize' ? { kind: 'evm_v4' as const, chainId: CHAINS[network], manager: venue.factory, poolId: event.args.id } : { kind: 'evm_contract' as const, chainId: CHAINS[network], address: event.eventName === 'PairCreated' ? event.args.pair.toLowerCase() : event.args.pool.toLowerCase() };
            native_pools.push({ network, venue_id: venue.id, reference, asset_ids: [assetId(network, token0.toLowerCase()), assetId(network, token1.toLowerCase())], provenance: [{ source: sourceName + ':' + venue.factory + ':' + log.blockNumber, provider_pool_id: event.eventName === 'Initialize' ? event.args.id : reference.kind === 'evm_contract' ? reference.address : '', observed_at: new Date().toISOString() }] });
          } catch { /* Unrelated manager/factory logs are deliberately filtered locally. */ }
        }
        if (start === 0n) break;
      }
      return { raw, valid };
    }),
  ]);
  // Unsupported is its own source disposition, never a second fabricated success.
  coverage.source_results = coverage.source_results.map((r) => r.source === 'onchain.pool_created' ? { ...r, truncated: r.truncated || Boolean(coverage.deferred_counts.ONCHAIN_VENUE_LIMIT), reason: r.reason ?? 'RECENT_1000_BLOCK_WINDOW' } : r);
  const ordered = [...sources].sort(([a, sa], [b, sb]) => Number(sb.has('seed')) - Number(sa.has('seed')) || a.localeCompare(b));
  const tokens = ordered.slice(0, 30).map(([id]) => id); coverage.tokens_considered = sources.size;
  if (ordered.length > tokens.length) { coverage.truncated = true; coverage.deferred_counts.TOKEN_LIMIT = ordered.length - tokens.length; }
  if (tokens.length) await source('dexscreener.metrics', async () => {
    const rows = await data('/tokens/v1/' + network + '/' + tokens.join(','));
    if (!Array.isArray(rows) || rows.length > 1000) throw new ResearchError('INVALID_RESPONSE', 'Invalid token metrics.');
    let valid = 0;
    for (const row of rows) { const result = marketSchema.safeParse(row); if (!result.success || result.data.chainId !== network || !tokens.includes(result.data.baseToken.address)) continue; const market = result.data, previous = markets.get(market.baseToken.address); if (!previous || (market.liquidity?.usd ?? 0) > (previous.liquidity?.usd ?? 0) || market.liquidity?.usd === previous.liquidity?.usd && market.pairAddress < previous.pairAddress) markets.set(market.baseToken.address, market); valid++; }
    return { raw: rows.length, valid };
  });
  return { tokens, sources, markets, coverage, native_pools };
  } finally { clearTimeout(sourceTimer); budget.signal.removeEventListener('abort', abort); }
}

export function rankMovers(reader: InventoryReaderV3, candidates: CandidateSources, inventory: InventoryV3, limit: number) {
  const tokens: z.infer<typeof moverTokenV2Schema>[] = [], dispositions: Array<{ token_id: string; exclusions: string[] }> = [];
  const weights = reader.registry.config.score_weights;
  for (const token of candidates.tokens) {
    const token_id = assetId(reader.network, token), pools = inventory.pools.filter((p) => p.liquidity_eligible && p.asset_ids.includes(token_id)), exclusions: string[] = [];
    if (pools.length < 2) exclusions.push('SINGLE_POOL');
    const market = candidates.markets.get(token), created = market?.pairCreatedAt;
    const age = created !== undefined && created !== null && created >= 0 && created <= Date.now() ? (Date.now() - created) / 3600000 : null;
    if (age !== null && age < 1) exclusions.push('AGE_LT_MIN');
    if (!pools.length) { const observed = inventory.pools.filter((p) => p.asset_ids.includes(token_id)); exclusions.push(observed.length && observed.every((p) => p.flags.zero_active_liquidity) ? 'ZERO_LIQ_ONLY' : 'NO_ELIGIBLE_POOLS'); }
    if (exclusions.length) { dispositions.push({ token_id, exclusions }); continue; }
    const sources = [...(candidates.sources.get(token) ?? [])].sort(), paid = sources.length > 0 && sources.every((s) => s === 'dexscreener.boost');
    const txns = market?.txns?.m5 as { buys?: unknown; sells?: unknown } | undefined;
    const buys = finite(txns?.buys), sells = finite(txns?.sells);
    const validBuys = buys !== null && Number.isInteger(buys) && buys >= 0 ? buys : null, validSells = sells !== null && Number.isInteger(sells) && sells >= 0 ? sells : null;
    const imbalance = validBuys === null || validSells === null ? null : validBuys + validSells ? (validBuys - validSells) / (validBuys + validSells) : 0;
    const change = finite(market?.priceChange?.h1), venues = new Set(pools.map((p) => p.protocol)).size;
    const signals = { change_m5_pct: finite(market?.priceChange?.m5), change_h1_pct: change, change_h24_pct: finite(market?.priceChange?.h24), volume_m5_usd: usd(market?.volume?.m5), volume_h24_usd: usd(market?.volume?.h24), volume_spike_z: null, buys_m5: validBuys, sells_m5: validSells, imbalance_m5: imbalance, pools_with_active_liquidity: pools.length, venues, age_hours: age, paid_visibility_only: paid, socials_declared: market?.info?.socials?.map((s) => s.url) ?? [] };
    const score = weights.imbalance * Math.abs(imbalance ?? 0) + weights.liquidity * Math.log(pools.length) + weights.venues * Math.log1p(venues) + weights.change * Math.min(Math.abs(change ?? 0) / 10, 3) - weights.paid_penalty * Number(paid);
    tokens.push(moverTokenV2Schema.parse({ rank: 0, token_id, symbol: market?.baseToken.symbol ?? null, name: market?.baseToken.name ?? null, sources, signals, missing_signals: Object.entries(signals).filter(([, value]) => value === null).map(([key]) => key), exclusions: [], score }));
  }
  tokens.sort((a, b) => b.score - a.score || a.token_id.localeCompare(b.token_id));
  const selected = tokens.slice(0, limit).map((t, i) => ({ ...t, rank: i + 1 }));
  const coverage = { ...inventory.coverage, source_results: [...candidates.coverage.source_results, ...inventory.coverage.source_results].slice(0, 128), tokens_considered: candidates.coverage.tokens_considered, tokens_watched: selected.length, excluded_counts: { ...inventory.coverage.excluded_counts, ...candidates.coverage.excluded_counts }, deferred_counts: { ...inventory.coverage.deferred_counts, ...candidates.coverage.deferred_counts }, truncated: inventory.coverage.truncated || candidates.coverage.truncated || tokens.length > limit };
  if (tokens.length > limit) coverage.deferred_counts.RANK_LIMIT = tokens.length - limit;
  for (const disposition of dispositions) for (const reason of disposition.exclusions) coverage.excluded_counts[reason] = (coverage.excluded_counts[reason] ?? 0) + 1;
  return { network: reader.network, chain_id: CHAINS[reader.network], outcome: (inventory.outcome === 'PARTIAL' || coverage.truncated || coverage.source_results.some((s) => s.status !== 'SUCCESS') ? 'PARTIAL' : selected.length ? 'SUCCESS' : 'EMPTY') as 'PARTIAL' | 'SUCCESS' | 'EMPTY', tokens: selected, dispositions, coverage };
}
