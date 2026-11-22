import { z } from 'zod';
import { ResearchError, hash, type Input } from './contracts';
import { address, bytes32, coinType, suiObjectId, chainCatalog } from './networks';
import { boundedJson, delay, type RoundBudget } from './transport';

const pairSchema = z.object({ chainId: z.string(), dexId: z.string().min(1).max(128), pairAddress: z.string().min(1).max(1024), labels: z.array(z.string()).nullish(), baseToken: z.object({ address: z.string(), symbol: z.string().optional() }), quoteToken: z.object({ address: z.string(), symbol: z.string().optional() }), priceUsd: z.string().nullish(), liquidity: z.object({ usd: z.number().finite().nonnegative().optional() }).nullish() });
export type DiscoveryPair = z.infer<typeof pairSchema>;
const capability = z.object({ status: z.enum(['unverified', 'unsupported']), reason: z.string() }).strict();
export const inventoryPoolSchema = z.object({
  id: z.string(), reference: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('evm_contract'), chainId: z.number().int(), address }).strict(),
    z.object({ kind: z.literal('evm_v4'), chainId: z.number().int(), manager: address, poolId: bytes32 }).strict(),
    z.object({ kind: z.literal('sui_object'), network: z.literal('mainnet'), objectId: suiObjectId }).strict(),
    z.object({ kind: z.literal('provider_opaque'), network: z.string(), provider: z.string(), providerPoolId: z.string() }).strict(),
  ]),
  asset_ids: z.tuple([z.string(), z.string()]), protocol: z.string(), labels: z.array(z.string()),
  liquidity_usd: z.string().nullable(), price_usd: z.string().nullable(),
  liquidity_eligible: z.boolean().nullable(), eligibility_reasons: z.array(z.string()),
  capabilities: z.object({ state: capability, quote: capability, funding: capability, simulation: capability }).strict(),
  provenance: z.array(z.object({ source: z.string(), provider_pool_id: z.string(), observed_at: z.string() }).strict()),
}).strict();
export const inventorySchema = z.object({
  schema_version: z.literal('flashloan.inventory.v2'), network: z.string(), observed_at: z.string(), outcome: z.enum(['SUCCESS', 'EMPTY', 'PARTIAL']),
  pools: z.array(inventoryPoolSchema),
  token_results: z.array(z.object({ token: z.string(), disposition: z.enum(['INCLUDED', 'EXCLUDED']), pool_ids: z.array(z.string()), discovered_count: z.number().int(), liquidity_eligible_count: z.number().int(), route_status: z.literal('NOT_EVALUATED') }).strict()),
  coverage: z.array(z.object({ source: z.string(), token: z.string(), scope: z.enum(['provider_response', 'protocol_registry']), status: z.enum(['SUCCESS', 'FAILED']), raw_count: z.number().int(), valid_count: z.number().int(), retrieval_complete: z.boolean(), exhaustive: z.literal(false), next_cursor: z.string().nullable(), observed_at: z.string() }).strict()),
  diagnostics: z.array(z.object({ code: z.string(), source: z.string(), token: z.string(), retryable: z.boolean() }).strict()), warnings: z.array(z.string()),
}).strict();
export type PoolInventory = z.infer<typeof inventorySchema>;
/** Serialized smooth token reservation: concurrent callers cannot overspend a bucket. */
export class RequestBudget {
  private tail = Promise.resolve();
  private next = 0;
  constructor(private readonly spacingMs = 210, private readonly clock = Date.now) {}
  acquire(signal?: AbortSignal): Promise<void> {
    const pending = this.tail.then(async () => { signal?.throwIfAborted(); const wait = Math.max(0, this.next - this.clock()); if (wait) await delay(wait, signal); this.next = this.clock() + this.spacingMs; });
    this.tail = pending.catch(() => undefined);
    return pending;
  }
}
const providerBudget = new RequestBudget();
const feedBudget = new RequestBudget(1050);
type MarketRequest = { onAttempt: () => void; timeoutMs?: number; deadlineMs: number };
export class DexScreener {
  private readonly buckets: { pairs: RequestBudget; feeds: RequestBudget };
  private readonly inflight = new Map<string, Promise<unknown>>();
  constructor(private readonly fetcher: typeof fetch = fetch, budget = providerBudget, feeds = feedBudget, private readonly roundBudget?: RoundBudget) { this.buckets = { pairs: budget, feeds }; }
  /** Bounded mover requests share the inventory limiter without changing inventory retries. */
  marketData(path: string, signal: AbortSignal, options: MarketRequest): Promise<unknown> {
    if (!/^\/(token-profiles\/latest\/v1|token-boosts\/(latest|top)\/v1|latest\/dex\/search\?q=|tokens\/v1\/)/.test(path)) throw new ResearchError('INVALID_INPUT', 'Unsupported market endpoint.');
    return this.get(path, signal, options);
  }
  private async get(path: string, signal?: AbortSignal, market?: MarketRequest): Promise<unknown> {
    // Requests with different cancellation lifetimes never share a promise.
    const key = signal ? undefined : path;
    if (key && this.inflight.has(key)) return this.inflight.get(key)!;
    const request = (async () => {
      const attempts = market ? 2 : 3;
      for (let attempt = 0; attempt < attempts; attempt++) {
        await (market && /token-(profiles|boosts)/.test(path) ? this.buckets.feeds : this.buckets.pairs).acquire(signal);
        signal?.throwIfAborted();
        market?.onAttempt();
        this.roundBudget?.rpc();
        const controller = new AbortController(); const abort = () => controller.abort();
        const timer = setTimeout(abort, Math.min(market?.timeoutMs ?? 15000, this.roundBudget?.remainingMs() ?? Infinity)); signal?.addEventListener('abort', abort, { once: true });
        try {
          const response = await this.fetcher(`https://api.dexscreener.com${path}`, { redirect: 'error', signal: controller.signal });
          if (response.status === 429 || response.status >= 500) {
            if (attempt === attempts - 1) throw new ResearchError('DISCOVERY_UNAVAILABLE', 'DexScreener retry budget exhausted.', true);
            const header = response.headers.get('retry-after');
            const retryAfter = header === null ? NaN : /^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now();
            await response.body?.cancel();
            if (market && Number.isFinite(retryAfter) && retryAfter >= market.deadlineMs - Date.now()) throw new ResearchError('SCAN_BUDGET_EXPIRED', 'Retry-After exceeds the remaining scan budget.', true);
            await delay(market && Number.isFinite(retryAfter) ? Math.max(0, retryAfter) : Math.min(5000, Number(header) * 1000 || 250 * 2 ** attempt), signal); continue;
          }
          if (!response.ok) throw new ResearchError('DISCOVERY_REJECTED', `DexScreener returned HTTP ${response.status}.`);
          return await boundedJson(response, 4_000_000, controller.signal);
        } catch (e) {
          if (signal?.aborted) { this.roundBudget?.check(); throw new ResearchError('CANCELLED', 'Discovery cancelled.'); }
          // A child request timeout is a dependency failure, not caller cancellation.
          if (market && controller.signal.aborted) {
            if (attempt === attempts - 1) throw new ResearchError('DEPENDENCY_TIMEOUT', 'Market request timed out.', true);
          } else if (e instanceof ResearchError) throw e;
          if (attempt === attempts - 1) throw new ResearchError('DISCOVERY_UNAVAILABLE', 'Discovery request interrupted.', true);
          await delay(250 * 2 ** attempt, signal);
        }
        finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
      }
      throw new ResearchError('DISCOVERY_UNAVAILABLE', 'Discovery unavailable.');
    })();
    if (key) this.inflight.set(key, request);
    try { return await request; } finally { if (key) this.inflight.delete(key); }
  }
  async discover(input: Omit<Input<'flashloan_discover_arbitrage_pools'>, 'native_cursors' | 'native_page_size' | 'native_max_pages'>, signal?: AbortSignal, allowFailedSources = false): Promise<PoolInventory> {
    const observed_at = new Date().toISOString(), source = 'dexscreener:token-pairs/v1';
    const tokenSchema = input.network === 'sui' ? coinType : address;
    const normalize = (t: string) => tokenSchema.parse(t);
    const excluded = new Set(input.exclude_tokens.map(normalize));
    const tokens = [...new Set(input.tokens.map(normalize))];
    const pools = new Map<string, z.infer<typeof inventoryPoolSchema>>();
    const coverage: PoolInventory['coverage'] = [], diagnostics: PoolInventory['diagnostics'] = [];
    const diagnostic = (code: string, token: string, retryable = false) => { if (diagnostics.length < 64) diagnostics.push({ code, source, token, retryable }); };
    let successes = 0, failures = 0;
    for (const token of tokens.filter((t) => !excluded.has(t))) {
      signal?.throwIfAborted();
      try {
        // The batch-token endpoint returns selected pairs, not a token's inventory.
        const raw = await this.get(`/token-pairs/v1/${chainCatalog[input.network].provider_id}/${encodeURIComponent(token)}`, signal);
        if (!Array.isArray(raw) || raw.length > 1000) throw new ResearchError('INVALID_RESPONSE', 'Expected a bounded pool array.');
        let valid = 0;
        for (const value of raw) {
          const parsed = pairSchema.safeParse(value);
          if (!parsed.success) { diagnostic('MALFORMED_PROVIDER_RECORD', token); continue; }
          const p = parsed.data;
          if (p.chainId !== chainCatalog[input.network].provider_id) { diagnostic('WRONG_CHAIN', token); continue; }
          const a = tokenSchema.safeParse(p.baseToken.address), b = tokenSchema.safeParse(p.quoteToken.address);
          if (!a.success || !b.success || a.data === b.data) { diagnostic('MALFORMED_ASSET_ID', token); continue; }
          if (a.data !== token && b.data !== token) { diagnostic('UNRELATED_PAIR', token); continue; }
          const evmAddress = address.safeParse(p.pairAddress), object = suiObjectId.safeParse(p.pairAddress);
          // A bytes32 provider ID does not establish its PoolManager or PoolKey.
          const reference = input.network === 'sui' && object.success ? { kind: 'sui_object' as const, network: 'mainnet' as const, objectId: object.data }
            : input.network !== 'sui' && evmAddress.success ? { kind: 'evm_contract' as const, chainId: chainCatalog[input.network].chain_id, address: evmAddress.data }
            : { kind: 'provider_opaque' as const, network: input.network, provider: 'dexscreener', providerPoolId: p.pairAddress };
          const id = hash(reference), usd = p.liquidity?.usd;
          const eligible = usd === undefined ? null : usd >= input.min_liquidity_usd;
          const state = { status: 'unverified' as const, reason: 'NATIVE_STATE_NOT_VERIFIED' };
          const record = inventoryPoolSchema.parse({ id, reference, asset_ids: [a.data, b.data], protocol: p.dexId, labels: p.labels ?? [], liquidity_usd: usd === undefined ? null : String(usd), price_usd: p.priceUsd ?? null, liquidity_eligible: eligible, eligibility_reasons: eligible === null ? ['LIQUIDITY_UNKNOWN'] : eligible ? [] : ['BELOW_LIQUIDITY_THRESHOLD'], capabilities: { state, quote: state, funding: state, simulation: state }, provenance: [{ source, provider_pool_id: p.pairAddress, observed_at }] });
          const previous = pools.get(id);
          if (previous && previous.asset_ids.some((asset) => !record.asset_ids.includes(asset))) { diagnostic('CONFLICTING_POOL_ID', token); continue; }
          pools.set(id, previous ?? record); valid++;
        }
        successes++;
        coverage.push({ source, token, scope: 'provider_response', status: 'SUCCESS', raw_count: raw.length, valid_count: valid, retrieval_complete: true, exhaustive: false, next_cursor: null, observed_at });
      } catch (e) {
        if (signal?.aborted || e instanceof ResearchError && e.code === 'CANCELLED') throw e;
        failures++; diagnostic(e instanceof ResearchError ? e.code : 'DISCOVERY_UNAVAILABLE', token, e instanceof ResearchError && e.retryable);
        coverage.push({ source, token, scope: 'provider_response', status: 'FAILED', raw_count: 0, valid_count: 0, retrieval_complete: false, exhaustive: false, next_cursor: null, observed_at });
      }
    }
    if (failures && !successes && !allowFailedSources) throw new ResearchError('DISCOVERY_UNAVAILABLE', 'No token inventory source succeeded.', true);
    const records = [...pools.values()].sort((a, b) => a.id.localeCompare(b.id));
    const token_results = tokens.map((token) => { const found = excluded.has(token) ? [] : records.filter((p) => p.asset_ids.includes(token)); return { token, disposition: excluded.has(token) ? 'EXCLUDED' as const : 'INCLUDED' as const, pool_ids: found.map((p) => p.id), discovered_count: found.length, liquidity_eligible_count: found.filter((p) => p.liquidity_eligible).length, route_status: 'NOT_EVALUATED' as const }; });
    return inventorySchema.parse({ schema_version: 'flashloan.inventory.v2', network: input.network, observed_at, outcome: failures || diagnostics.length ? 'PARTIAL' : records.length ? 'SUCCESS' : 'EMPTY', pools: records, token_results, coverage, diagnostics, warnings: ['Provider responses are not an exhaustive chain inventory.', 'Liquidity eligibility does not establish a connected route or available flash funding.'] });
  }
}
