import { z } from 'zod';
import { DexScreener } from './discovery';
import { address, coinType, chainCatalog } from './networks';
import { ResearchError } from './contracts';

export const moverNetwork = z.enum(['base', 'arbitrum', 'robinhood', 'sui']);
type Network = z.infer<typeof moverNetwork>;
export const moverInputSchema = z.object({
  networks: z.array(moverNetwork).min(1).max(4).refine((v) => new Set(v).size === v.length, 'Duplicate networks.').default(['base', 'arbitrum', 'robinhood', 'sui']),
  direction: z.enum(['both', 'gainers', 'losers']).default('both'),
  min_change_24h_pct: z.number().finite().min(10).default(10),
  limit_per_chain: z.number().int().min(1).max(10).default(10),
  min_liquidity_usd: z.number().finite().nonnegative().default(15000),
  seed_tokens: z.partialRecord(moverNetwork, z.array(z.string().min(1).max(1024)).max(30)).default({}),
}).strict().superRefine((input, ctx) => {
  for (const [network, tokens] of Object.entries(input.seed_tokens)) {
    if (!input.networks.includes(network as Network)) ctx.addIssue({ code: 'custom', path: ['seed_tokens', network], message: 'Seed network was not requested.' });
    for (const token of tokens ?? []) if (!(network === 'sui' ? coinType : address).safeParse(token).success) ctx.addIssue({ code: 'custom', path: ['seed_tokens', network], message: 'Invalid network-specific token identifier.' });
  }
});
export type MoverInput = z.infer<typeof moverInputSchema>;
const count = z.number().int().nonnegative();
const decimal = z.string().max(128).refine((v) => /^(?:\d+(?:\.\d+)?|\d+(?:\.\d+)?e[+-]?\d+)$/i.test(v) && Number.isFinite(Number(v)) && Number(v) >= 0);
const sourceSchema = z.object({ source: z.string(), status: z.enum(['SUCCESS', 'FAILED']), fetched_at: z.string().datetime(), attempts: count, raw_count: count, valid_count: count, truncated: z.boolean() }).strict();
const diagnosticSchema = z.object({ code: z.string(), source: z.string(), token_id: z.string().optional(), retryable: z.boolean() }).strict();
const tokenMoverSchema = z.object({
  rank: z.number().int().min(1).max(10), token_id: z.string(), name: z.string().nullable(), symbol: z.string().nullable(),
  price_change_24h_pct: z.number().finite(), direction: z.enum(['gain', 'loss']), price_usd: decimal, liquidity_usd: decimal, volume_24h_usd: decimal.nullable(),
  representative_market: z.object({ provider_pair_id: z.string(), dex_id: z.string(), quote_token_id: z.string(), pair_created_at: z.string().datetime(), fetched_at: z.string().datetime(), provider_updated_at: z.null(), selection: z.literal('highest_liquidity_observed'), metric: z.literal('dexscreener.priceChange.h24') }).strict(),
  discovery_sources: z.array(z.string()),
}).strict();
const chainMoversSchema = z.object({
  network: moverNetwork, chain_id: z.number().int().nullable(), environment: z.literal('mainnet'), outcome: z.enum(['SUCCESS', 'EMPTY', 'PARTIAL', 'UNAVAILABLE']), tokens: z.array(tokenMoverSchema).max(10),
  coverage: z.object({ scope: z.literal('bounded_discovery'), exhaustive: z.literal(false), candidate_count: count, scanned_count: count, eligible_count: count, matched_count: count, returned_count: count, truncated_candidate_count: count, excluded_counts: z.record(z.string(), count), source_results: z.array(sourceSchema).max(13) }).strict(),
  diagnostics: z.array(diagnosticSchema).max(64),
}).strict();
export const moversResultSchema = z.object({ schema_version: z.literal('flashloan.movers.v1'), provider: z.literal('dexscreener'), started_at: z.string().datetime(), completed_at: z.string().datetime(), parameters: moverInputSchema, chains: z.array(chainMoversSchema).min(1).max(4), warnings: z.array(z.string()) }).strict();
export type MoversResult = z.infer<typeof moversResultSchema>;
type ChainResult = MoversResult['chains'][number];
type TokenMover = ChainResult['tokens'][number];
const marketSchema = z.object({
  chainId: z.string(), dexId: z.string().min(1).max(128), pairAddress: z.string().min(1).max(1024),
  baseToken: z.object({ address: z.string(), name: z.unknown().optional(), symbol: z.unknown().optional() }), quoteToken: z.object({ address: z.string() }),
  priceUsd: z.string().max(128).nullish(), liquidity: z.object({ usd: z.number().finite().nonnegative().optional() }).nullish(),
  volume: z.unknown().optional(), priceChange: z.unknown().optional(), pairCreatedAt: z.number().finite().nullish(),
});
type Market = z.infer<typeof marketSchema> & { fetched_at: string };
const searches: Record<Network, string[]> = { base: ['base', 'WETH USDC'], arbitrum: ['arbitrum', 'ARB USDC'], robinhood: ['robinhood', 'USDG'], sui: ['sui', 'SUI USDC'] };
const feeds = ['/token-profiles/latest/v1', '/token-boosts/latest/v1', '/token-boosts/top/v1'];
const normalize = (network: Network, token: string) => (network === 'sui' ? coinType : address).parse(token);
const compareText = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const reportedChange = (p: Market): unknown => p.priceChange === null || p.priceChange === undefined ? undefined : typeof p.priceChange === 'object' && !Array.isArray(p.priceChange) ? (p.priceChange as { h24?: unknown }).h24 : NaN;
const volume = (p: Market) => {
  const value = p.volume && typeof p.volume === 'object' ? (p.volume as { h24?: unknown }).h24 : undefined;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : -1;
};
const metadata = (value: unknown, max: number) => typeof value === 'string' && value.length <= max ? value : null;
const compareMarkets = (a: Market, b: Market) => b.liquidity!.usd! - a.liquidity!.usd! || volume(b) - volume(a) || compareText(a.pairAddress, b.pairAddress);

/** Fixed worker pool: queued tasks do not open extra requests when cancellation wins. */
async function parallel(tasks: Array<() => Promise<void>>) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, tasks.length) }, async () => { while (next < tasks.length) await tasks[next++](); }));
}

/** Discovery -> metrics -> representative selection -> filtering -> ranking. No persistence. */
export async function getTokenMovers(dex: DexScreener, raw: MoverInput, signal?: AbortSignal, budgetMs = 24000): Promise<MoversResult> {
  const input = moverInputSchema.parse(raw), started = Date.now(), started_at = new Date(started).toISOString();
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, budgetMs);
  let attempts = 0;
  const states = input.networks.map((network) => ({
    network, candidates: new Map<string, Set<string>>(), selected: [] as string[], markets: new Map<string, Market>(), poolAssets: new Map<string, string>(), conflictingPools: new Set<string>(), metricSuccesses: 0,
    result: { network, chain_id: network === 'sui' ? null : chainCatalog[network].chain_id, environment: 'mainnet', outcome: 'EMPTY', tokens: [], coverage: { scope: 'bounded_discovery', exhaustive: false, candidate_count: 0, scanned_count: 0, eligible_count: 0, matched_count: 0, returned_count: 0, truncated_candidate_count: 0, excluded_counts: {}, source_results: [] }, diagnostics: [] } as ChainResult,
  }));
  type State = typeof states[number];
  const diagnostic = (state: State, code: string, source: string, retryable = false, token_id?: string) => { if (state.result.diagnostics.length < 64) state.result.diagnostics.push({ code, source, retryable, ...(token_id ? { token_id } : {}) }); };
  const candidate = (state: State, token: unknown, source: string) => {
    try {
      if (typeof token !== 'string') throw new Error('Invalid identifier.');
      const id = normalize(state.network, token), sources = state.candidates.get(id) ?? new Set<string>();
      sources.add(source); state.candidates.set(id, sources); return true;
    } catch { diagnostic(state, 'MALFORMED_ASSET_ID', source); return false; }
  };
  const collect = async (path: string, targets: State[], consume: (rows: unknown[], fetched: string) => number[]) => {
    let localAttempts = 0;
    try {
      const data = await dex.marketData(path, controller.signal, { deadlineMs: started + budgetMs, timeoutMs: Math.max(1, Math.min(5000, budgetMs - (Date.now() - started))), onAttempt: () => {
        if (attempts >= 24) throw new ResearchError('SCAN_REQUEST_BUDGET', 'Mover request budget exhausted.');
        attempts++; localAttempts++;
      } });
      const rows = path.startsWith('/latest/dex/search') ? (data as { pairs?: unknown })?.pairs : data;
      if (!Array.isArray(rows) || rows.length > 1000) throw new ResearchError('INVALID_RESPONSE', 'Expected a bounded market array.');
      const fetched = new Date().toISOString(), valid = consume(rows, fetched);
      targets.forEach((state, i) => state.result.coverage.source_results.push({ source: path, status: 'SUCCESS', fetched_at: fetched, attempts: localAttempts, raw_count: rows.length, valid_count: valid[i], truncated: false }));
    } catch (error) {
      const code = controller.signal.aborted ? 'SCAN_BUDGET_EXPIRED' : error instanceof ResearchError ? error.code : 'DISCOVERY_UNAVAILABLE';
      for (const state of targets) {
        diagnostic(state, code, path, controller.signal.aborted || !(error instanceof ResearchError) || error.retryable);
        state.result.coverage.source_results.push({ source: path, status: 'FAILED', fetched_at: new Date().toISOString(), attempts: localAttempts, raw_count: 0, valid_count: 0, truncated: false });
      }
    }
  };
  try {
    // Priority is applied after collection, so completion order cannot bias the cap.
    for (const state of states) for (const token of input.seed_tokens[state.network] ?? []) candidate(state, token, 'caller');
    await parallel([
      ...feeds.map((path) => () => collect(path, states, (rows) => states.map((state) => {
        let valid = 0;
        for (const row of rows) {
          if (!row || typeof row !== 'object') { diagnostic(state, 'MALFORMED_PROVIDER_RECORD', path); continue; }
          const value = row as { chainId?: unknown; tokenAddress?: unknown };
          if (typeof value.chainId !== 'string' || !value.chainId || typeof value.tokenAddress !== 'string') { diagnostic(state, 'MALFORMED_PROVIDER_RECORD', path); continue; }
          if (value.chainId === state.network && candidate(state, value.tokenAddress, path)) valid++;
        }
        return valid;
      }))),
      ...states.flatMap((state) => searches[state.network].map((query) => {
        const path = '/latest/dex/search?q=' + encodeURIComponent(query);
        return () => collect(path, [state], (rows) => {
          let valid = 0;
          for (const row of rows) {
            const parsed = marketSchema.safeParse(row);
            if (!parsed.success) { diagnostic(state, 'MALFORMED_PROVIDER_RECORD', path); continue; }
            if (parsed.data.chainId !== state.network) continue;
            if (candidate(state, parsed.data.baseToken.address, path)) valid++;
            candidate(state, parsed.data.quoteToken.address, path);
          }
          return [valid];
        });
      })),
    ]);
    const priority = (sources: Set<string>) => sources.has('caller') ? 0 : [...sources].some((s) => s.startsWith('/latest/dex/search')) ? 1 : sources.has(feeds[0]) ? 2 : sources.has(feeds[1]) ? 3 : 4;
    for (const state of states) {
      const ordered = [...state.candidates].sort(([a, sa], [b, sb]) => priority(sa) - priority(sb) || compareText(a, b));
      state.selected = ordered.slice(0, 60).map(([token]) => token);
      state.result.coverage.candidate_count = ordered.length;
      state.result.coverage.truncated_candidate_count = Math.max(0, ordered.length - 60);
    }
    await parallel(states.flatMap((state) => Array.from({ length: Math.ceil(state.selected.length / 30) }, (_, i) => {
      const batch = state.selected.slice(i * 30, (i + 1) * 30), requested = new Set(batch);
      const path = '/tokens/v1/' + state.network + '/' + batch.map(encodeURIComponent).join(',');
      return () => collect(path, [state], (rows, fetched_at) => {
        state.metricSuccesses++; state.result.coverage.scanned_count += batch.length;
        let valid = 0;
        for (const row of rows) {
          const parsed = marketSchema.safeParse(row);
          if (!parsed.success) { diagnostic(state, 'MALFORMED_PROVIDER_RECORD', path); continue; }
          const p = parsed.data;
          if (p.chainId !== state.network) { diagnostic(state, 'WRONG_CHAIN', path); continue; }
          try {
            p.baseToken.address = normalize(state.network, p.baseToken.address); p.quoteToken.address = normalize(state.network, p.quoteToken.address);
          } catch { diagnostic(state, 'MALFORMED_ASSET_ID', path); continue; }
          if (!requested.has(p.baseToken.address)) continue; // Never reuse a quote token's metric.
          if (p.baseToken.address === p.quoteToken.address) { diagnostic(state, 'MALFORMED_ASSET_ID', path); continue; }
          valid++;
          const identity = p.baseToken.address + '/' + p.quoteToken.address;
          const previousAssets = state.poolAssets.get(p.pairAddress);
          if (previousAssets && previousAssets !== identity) {
            state.conflictingPools.add(p.pairAddress); state.markets.delete(p.pairAddress);
            diagnostic(state, 'CONFLICTING_POOL_ID', path); continue;
          }
          state.poolAssets.set(p.pairAddress, identity);
          if (state.conflictingPools.has(p.pairAddress)) continue;
          const price = p.priceUsd === null || p.priceUsd === undefined ? NaN : Number(p.priceUsd);
          const created = p.pairCreatedAt;
          if (!p.priceUsd || !decimal.safeParse(p.priceUsd).success || !Number.isFinite(price) || price <= 0 || !p.liquidity?.usd || created === null || created === undefined || created < 0 || created > started - 86400000) continue;
          const market = { ...p, fetched_at };
          if (p.volume !== null && p.volume !== undefined && volume(market) < 0) diagnostic(state, 'INVALID_VOLUME', path);
          state.markets.set(p.pairAddress, market);
        }
        return [valid];
      });
    })));
    signal?.throwIfAborted();
    for (const state of states) {
      const { result } = state, excluded = result.coverage.excluded_counts;
      const skip = (reason: string) => { excluded[reason] = (excluded[reason] ?? 0) + 1; };
      const matches: TokenMover[] = [];
      const representatives = new Map<string, Market>();
      for (const p of state.markets.values()) {
        const previous = representatives.get(p.baseToken.address);
        if (!previous || compareMarkets(p, previous) < 0) representatives.set(p.baseToken.address, p);
      }
      for (const token of state.selected) {
        const p = representatives.get(token);
        if (!p) { skip('NO_ELIGIBLE_BASE_MARKET'); continue; }
        if (p.liquidity!.usd! < input.min_liquidity_usd) { skip('BELOW_LIQUIDITY_THRESHOLD'); continue; }
        const change = reportedChange(p);
        if (change === null || change === undefined) { skip('MISSING_24H_CHANGE'); continue; }
        if (typeof change !== 'number' || !Number.isFinite(change) || change < -100) { skip('INVALID_24H_CHANGE'); continue; }
        result.coverage.eligible_count++;
        const qualifies = input.direction === 'gainers' ? change >= input.min_change_24h_pct : input.direction === 'losers' ? change <= -input.min_change_24h_pct : Math.abs(change) >= input.min_change_24h_pct;
        if (!qualifies) { skip('BELOW_CHANGE_THRESHOLD'); continue; }
        matches.push({ rank: 1, token_id: token, name: metadata(p.baseToken.name, 256), symbol: metadata(p.baseToken.symbol, 128), price_change_24h_pct: change, direction: change > 0 ? 'gain' : 'loss', price_usd: p.priceUsd!, liquidity_usd: String(p.liquidity!.usd), volume_24h_usd: volume(p) < 0 ? null : String(volume(p)), representative_market: { provider_pair_id: p.pairAddress, dex_id: p.dexId, quote_token_id: p.quoteToken.address, pair_created_at: new Date(p.pairCreatedAt!).toISOString(), fetched_at: p.fetched_at, provider_updated_at: null, selection: 'highest_liquidity_observed', metric: 'dexscreener.priceChange.h24' }, discovery_sources: [...state.candidates.get(token)!].sort(compareText) });
      }
      matches.sort((a, b) => Math.abs(b.price_change_24h_pct) - Math.abs(a.price_change_24h_pct) || Number(b.liquidity_usd) - Number(a.liquidity_usd) || Number(b.volume_24h_usd ?? -1) - Number(a.volume_24h_usd ?? -1) || compareText(a.token_id, b.token_id));
      result.tokens = matches.slice(0, input.limit_per_chain).map((p, i) => ({ ...p, rank: i + 1 }));
      result.coverage.matched_count = matches.length; result.coverage.returned_count = result.tokens.length;
      const failed = result.coverage.source_results.some((s) => s.status === 'FAILED');
      const unavailable = state.selected.length ? state.metricSuccesses === 0 : result.coverage.source_results.every((s) => s.status === 'FAILED');
      result.outcome = unavailable ? 'UNAVAILABLE' : failed || result.diagnostics.length || result.coverage.truncated_candidate_count ? 'PARTIAL' : result.tokens.length ? 'SUCCESS' : 'EMPTY';
    }
    const output = moversResultSchema.safeParse({ schema_version: 'flashloan.movers.v1', provider: 'dexscreener', started_at, completed_at: new Date().toISOString(), parameters: { ...input, seed_tokens: Object.fromEntries(Object.entries(input.seed_tokens).map(([network, tokens]) => [network, [...new Set(tokens!.map((t) => normalize(network as Network, t)))]])) }, chains: states.map((s) => s.result), warnings: ['Top movers are ranked only within this bounded scan; chain-wide coverage is not exhaustive.', 'Profiles and boosts introduce selection bias. The representative is the deepest returned base-token market, not necessarily the deepest market on chain.', 'Provider-reported 24h changes are market-derived; retrieval time does not establish provider price freshness or arbitrage viability.'] });
    if (!output.success) throw new ResearchError('INVALID_OUTPUT', 'Mover output failed schema verification.');
    return output.data;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
