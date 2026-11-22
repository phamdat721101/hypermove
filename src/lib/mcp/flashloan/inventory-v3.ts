import { decodeEventLog, keccak256, parseAbi, type Hex } from 'viem';
import { z } from 'zod';
import { ResearchError, hash } from './contracts';
import { EvmReader, encodeCall, words, venueLookup, type Header, type MembershipClaim } from './evm';
import type { ResearchEngine } from './engine';
import type { PoolInventory } from './discovery';
import { DiscoveryRegistry, type Venue, type RegistrySeed } from './discovery-registry';
import { canonicalPoolId, resolveV4PoolKeys, type V4KeyResolution } from './pool-resolution';
import { RoundBudget, boundedEvmLogs } from './transport';
import { quoteCapability, type QuoteFamily } from './math';
import { CHAINS, address, evmNetwork } from './networks';
import { assetId, assetMetadataSchema, inventoryPoolV3Schema, inventoryV3Schema, poolKeyV8Schema, usdSchema, emptyCoverage, type InventoryV3, type InventoryPoolV3 } from './v8-contracts';

const ZERO = '0x' + '0'.repeat(40);
const initializeAbi = parseAbi(['event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)']);
const initializeTopic = keccak256(new TextEncoder().encode('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)'));
type Log = { address: string; topics: Hex[]; data: Hex; blockNumber: Hex; blockHash: Hex; transactionHash: Hex; logIndex: Hex; removed?: boolean };
const wordAddress = (word: bigint) => address.parse('0x' + word.toString(16).padStart(40, '0'));
const unknown = (reason: string) => ({ status: 'unverified' as const, reason });
const SCALE = 10n ** 18n;
export function decimalRaw(value: string): bigint { const [whole, fraction = ''] = usdSchema.parse(value).split('.'); return BigInt(whole) * SCALE + BigInt((fraction + '0'.repeat(18)).slice(0, 18)); }
export function decimalString(value: bigint): string { const fraction = (value % SCALE).toString().padStart(18, '0').replace(/0+$/, ''); return (value / SCALE).toString() + (fraction ? '.' + fraction : ''); }
export function decimalNumber(value: number): string {
  if (value < 1e-18) return '0'; // USD screening precision is 18 decimal places.
  const text = String(value); if (!text.includes('e')) return text;
  const [coefficient, power] = text.split('e'), digits = coefficient.replace('.', ''), point = (coefficient.split('.')[0].length) + Number(power);
  return point <= 0 ? '0.' + '0'.repeat(-point) + digits : point >= digits.length ? digits + '0'.repeat(point - digits.length) : digits.slice(0, point) + '.' + digits.slice(point);
}
type Prefetched = { ok: true; tokens: [string, string]; reads: Map<string, bigint[]> } | { ok: false; error: ResearchError };
const asResearchError = (error: unknown) => error instanceof ResearchError ? error : new ResearchError('STATE_UNAVAILABLE', 'Batched state read failed.');
function checkedDecimals(value: bigint) { const n = Number(value); if (!Number.isInteger(n) || n < 0 || n > 36) throw new ResearchError('UNSUPPORTED_DECIMALS', 'Discovery supports decimals 0 through 36.'); return n; }
/** Per-pool Multicall3 members for a non-V4 reviewed venue; undefined when no discovery state adapter exists. */
function statePlan(venue: Venue): string[] | undefined {
  if (['V2', 'SOLIDLY_VOLATILE', 'SOLIDLY_STABLE'].includes(venue.family)) return ['token0()', 'token1()', 'factory()', 'getReserves()'];
  if (venue.family !== 'V3' && venue.family !== 'ALGEBRA') return undefined;
  const algebra = venue.family === 'ALGEBRA', spacing = venue.pool_lookup === 'getPoolSpacing';
  return ['token0()', 'token1()', 'factory()', algebra ? 'globalState()' : 'slot0()', 'liquidity()', ...(algebra ? [] : ['fee()']), ...(spacing ? ['tickSpacing()'] : [])];
}
/** Capability matrix applied to a discovery pool (venue family + venue id as adapter version). */
export function venueQuoteCapability(venue: Venue, feeMode: InventoryPoolV3['fee_mode']) {
  const family: QuoteFamily = venue.family === 'V4' ? 'UNISWAP_V4' : venue.family === 'ALGEBRA' ? 'ALGEBRA' : venue.family === 'SOLIDLY_STABLE' ? 'AERODROME_STABLE' : venue.family === 'SOLIDLY_VOLATILE' ? 'AERODROME_VOLATILE'
    : venue.family === 'V2' ? 'UNISWAP_V2' : venue.pool_lookup === 'getPoolSpacing' ? 'AERODROME_CLMM' : 'UNISWAP_V3';
  return quoteCapability(family, venue.id, { hooked: feeMode === 'hooked', dynamic_fee: feeMode === 'dynamic' && family !== 'ALGEBRA' || /deltaswap|dynamic/i.test(venue.id) });
}
export type NativeInventorySeed = RegistrySeed & { provenance?: InventoryPoolV3['provenance'] };
export function virtualDepth(state: NonNullable<InventoryPoolV3['state']>, decimals: number, usd: string, side: 0 | 1): string {
  let numerator: bigint, denominator = 10n ** BigInt(decimals);
  if (state.sqrt_price_x96 !== undefined && state.active_liquidity !== undefined) {
    const sqrt = BigInt(state.sqrt_price_x96), liquidity = BigInt(state.active_liquidity);
    if (sqrt === 0n) return '0';
    numerator = 2n * liquidity * (side ? sqrt : 2n ** 96n);
    denominator *= side ? 2n ** 96n : sqrt;
  } else numerator = 2n * BigInt(side ? state.reserve1 ?? '0' : state.reserve0 ?? '0');
  return decimalString(numerator * decimalRaw(usd) / denominator);
}

/** Request-scoped reader: immutable evidence is shared, mutable state is never cached across requests. */
export class InventoryReaderV3 {
  readonly registry: DiscoveryRegistry;
  private readerValue?: EvmReader;
  private headerValue?: Header;
  private readonly code = new Map<string, Promise<Hex>>();
  private readonly metadata = new Map<string, Promise<number>>();
  private readonly initializationLogs = new Map<string, Promise<Log[]>>();
  private readonly prefetched = new Map<string, Prefetched>();
  private decimalsBatchFailure?: string;
  /** Index mode (file 11 #16): selected V4 pool ids per manager, resolved together once per round. */
  private readonly v4Wanted = new Map<string, Set<string>>();
  private readonly v4Resolved = new Map<string, Promise<Map<string, V4KeyResolution>>>();
  constructor(readonly engine: ResearchEngine, readonly network: z.infer<typeof evmNetwork>, readonly budget: RoundBudget) {
    this.registry = engine.options.discoveryRegistry ?? new DiscoveryRegistry();
  }
  get reader() { return this.readerValue ??= new EvmReader(this.engine.rpc(this.network), this.network, this.engine.options.deployments); }
  async header(signal = this.budget.signal) { return this.headerValue ??= await this.reader.header(signal); }
  private runtime(to: string, block: Header) {
    let result = this.code.get(to);
    if (!result) { result = this.reader.rpc.rpc<Hex>('eth_getCode', [to, { blockHash: block.hash, requireCanonical: true }], this.budget.signal); this.code.set(to, result); }
    return result;
  }
  private async attest(to: string, expected: string, block: Header) { const code = await this.runtime(to, block); if (code === '0x' || keccak256(code) !== expected) throw new ResearchError('DEPLOYMENT_MISMATCH', 'Discovery runtime does not match reviewed evidence.'); }
  private decimals(token: string, block: Header) {
    let result = this.metadata.get(token);
    if (!result) { result = token === ZERO ? Promise.resolve(18) : this.reader.call(token, 'decimals()', [], block, this.budget.signal).then((v) => checkedDecimals(v[0])); this.metadata.set(token, result); }
    return result;
  }
  private async logs(venue: Venue, poolId: string, block: Header) {
    const locator = this.engine.options.initializations?.find((l) => l.network === this.network && l.manager === venue.factory && l.poolId === poolId);
    const key = venue.factory + ':' + (locator?.blockHash ?? 'recent');
    let pending = this.initializationLogs.get(key);
    if (!pending) {
      pending = (async () => {
        const head = BigInt(block.number), start = venue.initialization_block === undefined ? (head > 9999n ? head - 9999n : 0n) : BigInt(venue.initialization_block);
        const rows: Log[] = [];
        const read = async (filter: object) => {
          const raw = await boundedEvmLogs<Log>(this.reader.rpc, { address: venue.factory, ...filter }, this.budget.signal);
          const range = filter as { blockHash?: string; fromBlock?: string; toBlock?: string };
          rows.push(...raw.filter((l) => !l.removed && l.address?.toLowerCase() === venue.factory && l.topics?.[0] === initializeTopic && BigInt(l.blockNumber) <= head && (!range.blockHash || l.blockHash === range.blockHash) && (!range.fromBlock || BigInt(l.blockNumber) >= BigInt(range.fromBlock)) && (!range.toBlock || BigInt(l.blockNumber) <= BigInt(range.toBlock))));
        };
        if (locator) await read({ blockHash: locator.blockHash });
        else for (let page = 0; page < 5 && start + BigInt(page * 2000) <= head; page++) { const from = start + BigInt(page * 2000); await read({ fromBlock: '0x' + from.toString(16), toBlock: '0x' + (from + 1999n < head ? from + 1999n : head).toString(16) }); }
        return rows;
      })();
      this.initializationLogs.set(key, pending);
    }
    const matches = (await pending).filter((l) => l.topics[1] === poolId);
    if (matches.length !== 1) throw new ResearchError('UNRESOLVED_POOL_KEY', 'Exactly one canonical initialization is required; configure a locator for older pools.');
    const log = matches[0], canonical = await this.reader.rpc.rpc<Header | null>('eth_getBlockByNumber', [log.blockNumber, false], this.budget.signal);
    if (!canonical || canonical.hash !== log.blockHash || !/^0x[0-9a-f]{64}$/.test(log.transactionHash) || !/^0x[0-9a-f]+$/.test(log.logIndex)) throw new ResearchError('BLOCK_REORG', 'Initialization provenance is not canonical.');
    return log;
  }
  private async indexedKey(venue: Venue, poolId: string, block: Header) {
    const resolve = (ids: string[]) => {
      const start = venue.initialization_block === undefined ? (BigInt(block.number) > 9999n ? BigInt(block.number) - 9999n : 0n) : BigInt(venue.initialization_block);
      return resolveV4PoolKeys({ rpc: this.reader.rpc, index: this.engine.options.initializeIndex!, budget: this.budget, start, locators: this.engine.options.initializations?.filter((l) => l.network === this.network) }, CHAINS[this.network], venue.factory, ids, block);
    };
    let pending = this.v4Resolved.get(venue.factory);
    if (!pending) { pending = resolve([...(this.v4Wanted.get(venue.factory) ?? new Set([poolId]))]); this.v4Resolved.set(venue.factory, pending); }
    const result = (await pending).get(poolId) ?? (await resolve([poolId])).get(poolId)!;
    if (!result.ok) throw new ResearchError(result.code, result.reason);
    return result.entry;
  }
  /**
   * A2'': read every selected non-V4 pool in Multicall3 batches with per-member outcomes, then verify factory
   * membership in one more batch, then unique-token decimals once per round. A failed member excludes only its own
   * pool, with an explicit reason; a failure of the whole call is attributed to every pool it covered.
   */
  private async prefetch(items: Array<{ pool: InventoryPoolV3; venue?: Venue }>, block: Header) {
    const plans = items.flatMap(({ pool, venue }) => {
      const sigs = venue?.status === 'reviewed' && venue.family !== 'V4' && pool.reference.kind === 'evm_contract' ? statePlan(venue) : undefined;
      return sigs ? [{ pool, venue: venue!, to: (pool.reference as { address: string }).address, sigs }] : [];
    });
    if (!plans.length) return;
    const fail = (list: typeof plans, error: ResearchError) => { for (const { pool } of list) this.prefetched.set(pool.id, { ok: false, error }); };
    let settled;
    try { settled = await this.reader.batchSettled(plans.flatMap((p) => p.sigs.map((signature) => ({ to: p.to, signature }))), block, this.budget.signal); }
    catch (error) { fail(plans, asResearchError(error)); return; }
    const claims: Array<{ plan: typeof plans[number]; claim: MembershipClaim; tokens: [string, string]; reads: Map<string, bigint[]> }> = [];
    let at = 0;
    for (const plan of plans) {
      const results = settled.slice(at, at += plan.sigs.length);
      try {
        const failed = results.findIndex((r) => !r.ok);
        if (failed >= 0) throw new ResearchError('MULTICALL_MEMBER_FAILED', plan.sigs[failed] + ' ' + (results[failed] as { reason: string }).reason);
        const reads = new Map(plan.sigs.map((sig, i) => [sig, (results[i] as { words: bigint[] }).words]));
        const tokens: [string, string] = [wordAddress(reads.get('token0()')![0]), wordAddress(reads.get('token1()')![0])];
        if (wordAddress(reads.get('factory()')![0]) !== plan.venue.factory || tokens[0] === tokens[1] || tokens.includes(ZERO)) throw new ResearchError('DEPLOYMENT_MISMATCH', 'Pool factory or assets mismatch.');
        const lookup = venueLookup(plan.venue);
        const param = lookup === 'getPoolFee' ? reads.get('fee()')![0] : lookup === 'getPoolSpacing' ? BigInt.asIntN(24, reads.get('tickSpacing()')![0]) : undefined;
        if (lookup === 'getPoolSpacing' && (param! <= 0n || param! > 32767n)) throw new ResearchError('INVALID_POOL', 'Invalid factory tick spacing.');
        claims.push({ plan, tokens, reads, claim: { pool: plan.to, factory: plan.venue.factory, lookup, token0: tokens[0], token1: tokens[1], param } });
      } catch (error) { fail([plan], asResearchError(error)); }
    }
    if (!claims.length) return;
    try {
      const membership = await this.reader.verifyFactoryMembership(claims.map((c) => c.claim), block, this.budget.signal);
      membership.forEach((result, i) => this.prefetched.set(claims[i].plan.pool.id, result.ok ? { ok: true, tokens: claims[i].tokens, reads: claims[i].reads } : { ok: false, error: new ResearchError(result.code, result.reason) }));
    } catch (error) { fail(claims.map((c) => c.plan), asResearchError(error)); return; }
    const tokens = [...new Set(claims.flatMap((c) => c.tokens))].filter((t) => t !== ZERO && !this.metadata.has(t));
    if (!tokens.length) return;
    let decimals;
    // A whole-batch failure leaves decimals uncached: `decimals()` then reads per token and reports its own error.
    try { decimals = await this.reader.batchSettled(tokens.map((to) => ({ to, signature: 'decimals()' })), block, this.budget.signal); }
    catch (error) { this.decimalsBatchFailure = asResearchError(error).code; return; }
    tokens.forEach((token, i) => {
      const result = decimals[i]; if (!result.ok) return; // per-token fallback re-reads and reports its own reason
      let value: Promise<number>;
      try { value = Promise.resolve(checkedDecimals(result.words[0])); } catch (error) { value = Promise.reject(error); value.catch(() => undefined); /* observed when the pool awaits it */ }
      this.metadata.set(token, value);
    });
  }
  private async readPool(pool: InventoryPoolV3, venue: Venue, block: Header) {
    await this.attest(venue.factory, venue.factory_code_hash, block);
    const batch = async (calls: Array<{ to: string; signature: string; args?: Array<string | bigint> }>) => (await this.reader.rpc.batch<string>(calls.map((c) => ({ method: 'eth_call', params: [{ to: c.to, data: encodeCall(c.signature, c.args ?? []) }, { blockHash: block.hash, requireCanonical: true }] })), this.budget.signal)).map(words);
    let tokens: [string, string];
    if (venue.family === 'V4') {
      const ref = pool.reference;
      const id = ref.kind === 'evm_v4' ? ref.poolId : ref.kind === 'provider_opaque' ? ref.providerPoolId : '';
      if (!/^0x[0-9a-f]{64}$/.test(id)) throw new ResearchError('UNRESOLVED_POOL_KEY', 'V4 provider identity must be a pool ID.');
      const args = this.engine.options.initializeIndex ? await this.indexedKey(venue, id, block).then((e) => ({ ...e, id: e.pool_id }))
        : await this.logs(venue, id, block).then((log) => decodeEventLog({ abi: initializeAbi, topics: log.topics as [Hex, ...Hex[]], data: log.data }).args);
      const key = poolKeyV8Schema.parse({ currency0: args.currency0, currency1: args.currency1, fee: args.fee, tickSpacing: args.tickSpacing, hooks: args.hooks });
      if (args.id !== id || canonicalPoolId(key) !== id || pool.pool_key && canonicalPoolId(pool.pool_key) !== id) throw new ResearchError('POOL_ID_MISMATCH', 'PoolKey disagrees with canonical initialization.');
      if (!venue.state_view || !venue.state_view_code_hash) throw new ResearchError('STATE_UNAVAILABLE', 'StateView evidence is missing.');
      await this.attest(venue.state_view, venue.state_view_code_hash, block);
      const [slot, liquidity] = await batch([{ to: venue.state_view, signature: 'getSlot0(bytes32)', args: [id] }, { to: venue.state_view, signature: 'getLiquidity(bytes32)', args: [id] }]);
      if (!slot[0] || slot.length < 4 || liquidity.length < 1) throw new ResearchError('STATE_UNAVAILABLE', 'Uninitialized or malformed V4 state.');
      tokens = [key.currency0, key.currency1]; pool.pool_key = key;
      pool.reference = { kind: 'evm_v4', chainId: CHAINS[this.network], manager: venue.factory, poolId: id }; pool.id = hash(pool.reference);
      pool.fee_mode = key.hooks !== ZERO ? 'hooked' : key.fee === 0x800000 ? 'dynamic' : 'static';
      pool.state = { block: BigInt(block.number).toString(), block_hash: block.hash, sqrt_price_x96: slot[0].toString(), tick: Number(BigInt.asIntN(24, slot[1])), active_liquidity: liquidity[0].toString(), lp_fee_pips: Number(slot[3]) };
      if (key.hooks !== ZERO) { const code = await this.runtime(key.hooks, block); if (code === '0x') throw new ResearchError('HOOK_CODE_UNAVAILABLE', 'Hook has no runtime.'); const code_hash = keccak256(code); pool.hook = { address: key.hooks, code_hash, allowlisted: this.registry.network(this.network).hooks.some((h) => h.address === key.hooks && h.code_hash === code_hash && h.status === 'allowlisted') }; }
    } else {
      if (pool.reference.kind !== 'evm_contract') throw new ResearchError('UNSUPPORTED_POOL_VERSION', 'A contract address is required.');
      const to = pool.reference.address;
      const code = await this.runtime(to, block);
      if (code === '0x' || venue.pool_code_hash && keccak256(code) !== venue.pool_code_hash) throw new ResearchError('DEPLOYMENT_MISMATCH', 'Pool runtime mismatch.');
      const fetched = this.prefetched.get(pool.id);
      if (!fetched) throw new ResearchError('UNSUPPORTED_POOL_VERSION', 'No reviewed discovery state adapter for this family.');
      if (!fetched.ok) throw fetched.error;
      tokens = fetched.tokens; const reads = fetched.reads;
      if (['V2', 'SOLIDLY_VOLATILE', 'SOLIDLY_STABLE'].includes(venue.family)) {
        const reserves = reads.get('getReserves()')!;
        if (reserves.length < 2) throw new ResearchError('STATE_UNAVAILABLE', 'Malformed reserves.');
        pool.state = { block: BigInt(block.number).toString(), block_hash: block.hash, reserve0: reserves[0].toString(), reserve1: reserves[1].toString() };
      } else {
        const slot = reads.get(venue.family === 'ALGEBRA' ? 'globalState()' : 'slot0()')!, liquidity = reads.get('liquidity()')!;
        const fee = venue.family === 'ALGEBRA' ? slot[2] : reads.get('fee()')![0];
        if (!slot[0] || slot.length < 2 || liquidity.length < 1 || fee === undefined) throw new ResearchError('STATE_UNAVAILABLE', 'Malformed concentrated-liquidity state.');
        pool.state = { block: BigInt(block.number).toString(), block_hash: block.hash, sqrt_price_x96: slot[0].toString(), tick: Number(BigInt.asIntN(24, slot[1])), active_liquidity: liquidity[0].toString(), lp_fee_pips: Number(fee) };
      }
      pool.fee_mode = venue.family === 'ALGEBRA' ? 'dynamic' : 'static';
    }
    const canonicalAssets = tokens.map((t) => assetId(this.network, t)) as [string, string];
    if (canonicalAssets.some((a) => !pool.asset_ids.includes(a))) throw new ResearchError('CURRENCY_MISMATCH', 'Provider currencies differ from on-chain currencies.');
    pool.asset_ids = canonicalAssets;
    return Promise.all(tokens.map((token) => this.decimals(token, block)));
  }
  async inventory(base: PoolInventory, tokens: string[], excluded: string[], minDepth: number, native: NativeInventorySeed[] = []): Promise<InventoryV3> {
    // Final canonicality verification gets its own reserved capacity; without it an exhausted read
    // budget made the check fail and erased every successfully read pool (D1).
    const finalCheck = this.budget.reserveFinal(2, 2500);
    try { return await this.collect(finalCheck, base, tokens, excluded, minDepth, native); }
    finally { finalCheck.release(); }
  }
  private async collect(finalCheck: ReturnType<RoundBudget['reserveFinal']>, base: PoolInventory, tokens: string[], excluded: string[], minDepth: number, native: NativeInventorySeed[]): Promise<InventoryV3> {
    const started = performance.now(), callsAtStart = this.budget.rpcCallsUsed;
    const observed_at = new Date().toISOString(), coverage = emptyCoverage(), config = this.registry.network(this.network);
    coverage.tokens_considered = tokens.length;
    coverage.source_results = base.coverage.map((c) => ({ source: c.source + ':' + c.token, status: c.status, raw_count: c.raw_count, valid_count: c.valid_count, truncated: !c.retrieval_complete, reason: c.status === 'FAILED' ? 'DISCOVERY_UNAVAILABLE' : null })).slice(0, 100);
    const prices = new Map<string, z.infer<typeof assetMetadataSchema>['usd_price']>();
    const candidates: Array<{ pool: InventoryPoolV3; venue?: Venue }> = [];
    const add = (reference: InventoryPoolV3['reference'], ids: [string, string], protocol: string, labels: string[], provenance: InventoryPoolV3['provenance'], liquidity: string | null, venue?: Venue) => {
      if (ids.some((id) => excluded.some((t) => id === assetId(this.network, t)))) return;
      candidates.push({ pool: { id: hash(reference), reference, asset_ids: ids, protocol, family: venue?.family ?? 'OTHER', labels: labels.slice(0, 32), fee_mode: 'unknown', depth: { reported_liquidity_usd: liquidity && usdSchema.safeParse(liquidity).success ? liquidity : null, virtual_depth_usd: null }, flags: { zero_active_liquidity: false, stale_price_suspect: false }, liquidity_eligible: null, eligibility_reasons: [], capabilities: { state: unknown('NATIVE_STATE_NOT_VERIFIED'), quote: unknown('QUOTE_NOT_VERIFIED'), funding: unknown('FUNDING_NOT_VERIFIED'), simulation: unknown('SIMULATION_NOT_VERIFIED') }, provenance: provenance.slice(0, 16) }, venue });
    };
    for (const p of base.pools) {
      if (p.reference.kind === 'sui_object') continue;
      if (p.price_usd && usdSchema.safeParse(p.price_usd).success && decimalRaw(p.price_usd) > 0n) prices.set(assetId(this.network, p.asset_ids[0]), { value: p.price_usd, source: p.provenance[0]?.source ?? 'dexscreener', observed_at: p.provenance[0]?.observed_at ?? observed_at });
      const v4Reference = p.reference.kind === 'evm_v4' || p.reference.kind === 'provider_opaque' && /^0x[0-9a-f]{64}$/i.test(p.reference.providerPoolId);
      const venue = config.venues.find((v) => (v.family === 'V4') === v4Reference && (v.id === p.protocol || v.provider_ids.includes(p.protocol)));
      add(p.reference as InventoryPoolV3['reference'], p.asset_ids.map((t) => assetId(this.network, t)) as [string, string], p.protocol, p.labels, p.provenance, p.liquidity_usd, venue);
    }
    for (const seed of ([...this.registry.config.pools, ...native] as NativeInventorySeed[]).filter((p) => p.network === this.network && p.asset_ids.some((a) => tokens.some((t) => a === assetId(this.network, t))))) add(seed.reference, seed.asset_ids, seed.venue_id, [], seed.provenance ?? [{ source: 'reviewed-registry', provider_pool_id: hash(seed.reference), observed_at }], null, config.venues.find((v) => v.id === seed.venue_id));
    const unique = new Map<string, typeof candidates[number]>();
    for (const item of candidates) { const prior = unique.get(item.pool.id); if (prior && prior.pool.asset_ids.some((a) => !item.pool.asset_ids.includes(a))) { prior.venue = undefined; prior.pool.eligibility_reasons.push('CONFLICTING_POOL_ID'); } else if (!prior) unique.set(item.pool.id, item); else prior.pool.provenance = [...prior.pool.provenance, ...item.pool.provenance].slice(0, 16); }
    // Read the pools that matter first: reviewed seeds, then anchor-anchor pairs, then reported depth.
    // Ordering by id hash spent the read budget on arbitrary pools (D3). Output order stays id-sorted below.
    const anchors = new Set(config.anchors);
    const priority = (c: typeof candidates[number]) => [
      c.pool.provenance.some((p) => p.source === 'reviewed-registry') ? 0 : 1,
      c.pool.asset_ids.every((a) => anchors.has(a)) ? 0 : 1,
      -Number(c.pool.depth.reported_liquidity_usd ?? 0),
    ];
    const all = [...unique.values()].sort((a, b) => { const pa = priority(a), pb = priority(b); for (let i = 0; i < pa.length; i++) if (pa[i] !== pb[i]) return pa[i] - pb[i]; return a.pool.id.localeCompare(b.pool.id); });
    coverage.pools_considered = all.length;
    const selected = all.slice(0, 400); coverage.truncated = all.length > selected.length;
    if (coverage.truncated) coverage.deferred_counts.POOL_LIMIT = all.length - selected.length;
    const assets = new Map<string, z.infer<typeof assetMetadataSchema>>();
    let block: Header | undefined;
    try { block = await this.header(); } catch { coverage.source_results.push({ source: 'rpc:state', status: 'FAILED', raw_count: 0, valid_count: 0, truncated: false, reason: 'STATE_UNAVAILABLE' }); }
    // A2'': one batched read pass over the selected pools; workers below only verify runtime and assemble state.
    if (block && this.budget.remainingMs() >= 1500) await this.prefetch(selected, block);
    if (this.engine.options.initializeIndex) for (const { pool, venue } of selected) {
      const id = pool.reference.kind === 'evm_v4' ? pool.reference.poolId : pool.reference.kind === 'provider_opaque' ? pool.reference.providerPoolId : '';
      if (venue?.family === 'V4' && venue.status === 'reviewed' && /^0x[0-9a-f]{64}$/.test(id)) { const ids = this.v4Wanted.get(venue.factory) ?? new Set<string>(); ids.add(id); this.v4Wanted.set(venue.factory, ids); }
    }
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, selected.length) }, async () => {
      while (next < selected.length) {
        const { pool, venue } = selected[next++];
        try {
          if (!block) throw new ResearchError('STATE_UNAVAILABLE', 'Pinned state unavailable.');
          if (!venue || venue.status !== 'reviewed') throw new ResearchError('UNSUPPORTED_POOL_VERSION', 'Reviewed venue evidence is required.');
          if (this.budget.remainingMs() < 1500 || this.budget.rpcCallsUsed >= this.budget.limits.maxRpcCalls - 64) throw new ResearchError('STATE_BUDGET', 'Reserve final canonicality time and RPC budget.');
          const decimals = await this.readPool(pool, venue, block);
          pool.asset_ids.forEach((id, i) => { assets.set(id, { asset_id: id, address: id.endsWith('/slip44:60') ? null : id.split('/erc20:')[1], decimals: decimals[i], usd_price: prices.get(id) ?? null }); });
          pool.capabilities.state = { status: 'available', reason: 'PINNED_CANONICAL_STATE' };
          const quote = venueQuoteCapability(venue, pool.fee_mode);
          if (pool.hook) pool.capabilities.quote = { status: 'simulation_only', reason: 'HOOK_REQUIRES_EXECUTION_QUOTE' };
          else if (quote === 'none') pool.capabilities.quote = venue.family === 'V4' ? { status: 'simulation_only', reason: 'DYNAMIC_FEE_REQUIRES_EXECUTION_QUOTE' } : { status: 'unsupported', reason: 'QUOTE_CAPABILITY_NONE' };
          else if (quote === 'estimate') pool.capabilities.quote = { status: 'unverified', reason: 'QUOTE_ESTIMATE_ONLY' };
          pool.flags.zero_active_liquidity = pool.state!.active_liquidity !== undefined ? BigInt(pool.state!.active_liquidity) === 0n : BigInt(pool.state!.reserve0 ?? '0') === 0n || BigInt(pool.state!.reserve1 ?? '0') === 0n;
          const side = [1, 0].find((i) => { const price = prices.get(pool.asset_ids[i]); return price && Date.now() - Date.parse(price.observed_at) <= 120000 && Date.parse(price.observed_at) <= Date.now(); });
          if (side !== undefined) pool.depth.virtual_depth_usd = virtualDepth(pool.state!, decimals[side], prices.get(pool.asset_ids[side])!.value, side as 0 | 1);
          else { pool.flags.stale_price_suspect = pool.asset_ids.some((id) => prices.has(id)); pool.eligibility_reasons.push('USD_VALUATION_UNAVAILABLE'); }
          if (pool.flags.zero_active_liquidity) pool.eligibility_reasons.push('ZERO_ACTIVE_LIQUIDITY');
          if (pool.depth.virtual_depth_usd !== null && decimalRaw(pool.depth.virtual_depth_usd) < decimalRaw(decimalNumber(minDepth))) pool.eligibility_reasons.push('BELOW_VIRTUAL_DEPTH_THRESHOLD');
          pool.liquidity_eligible = pool.eligibility_reasons.length === 0;
          inventoryPoolV3Schema.parse(pool);
        } catch (error) {
          delete pool.state; pool.depth.virtual_depth_usd = null; pool.liquidity_eligible = false;
          pool.capabilities.state = unknown('STATE_UNAVAILABLE');
          const code = error instanceof ResearchError ? error.code : 'STATE_UNAVAILABLE';
          pool.eligibility_reasons.push(code === 'UNSUPPORTED_POOL_VERSION' ? code : 'STATE_UNAVAILABLE', ...(code === 'UNSUPPORTED_POOL_VERSION' ? [] : [code]));
          if (pool.reference.kind === 'provider_opaque') pool.eligibility_reasons.push('UNRESOLVED_POOL_KEY');
          if (['STATE_BUDGET', 'RESOLUTION_BUDGET', 'ROUND_DEADLINE', 'CANCELLED'].includes(code)) { coverage.truncated = true; coverage.deferred_counts.STATE_BUDGET = (coverage.deferred_counts.STATE_BUDGET ?? 0) + 1; }
        }
      }
    }));
    const readMs = performance.now() - started, callsBeforeFinal = this.budget.rpcCallsUsed;
    let finalOutcome: 'VERIFIED' | 'BLOCK_REORG' | 'HEADER_MISSING' | 'CHECK_UNAVAILABLE' | 'SKIPPED' = 'SKIPPED';
    if (block) {
      const pinned = block;
      try {
        const canonical = await finalCheck.run(() => this.reader.rpc.rpc<Header | null>('eth_getBlockByNumber', [pinned.number, false], this.budget.signal));
        finalOutcome = !canonical ? 'HEADER_MISSING' : canonical.hash !== pinned.hash ? 'BLOCK_REORG' : 'VERIFIED';
      } catch { finalOutcome = 'CHECK_UNAVAILABLE'; }
      if (finalOutcome === 'BLOCK_REORG' || finalOutcome === 'HEADER_MISSING') {
        // The pinned block is provably not canonical (or the node no longer has it): every read is stale.
        const reason = finalOutcome === 'BLOCK_REORG' ? 'BLOCK_REORG' : 'CANONICALITY_UNVERIFIED';
        for (const { pool } of selected) { delete pool.state; pool.depth.virtual_depth_usd = null; pool.liquidity_eligible = false; pool.capabilities.state = unknown(reason); pool.eligibility_reasons.push(reason); }
        block = undefined; coverage.truncated = true;
      } else if (finalOutcome === 'CHECK_UNAVAILABLE') {
        // Each read already pinned `{blockHash, requireCanonical:true}`; only a reorg *during* the round is
        // unproven. Keep the verified reads and report the gap instead of discarding them.
        coverage.source_results.push({ source: 'rpc:canonical', status: 'FAILED', raw_count: 0, valid_count: 0, truncated: true, reason: 'CANONICALITY_CHECK_UNAVAILABLE' });
        coverage.truncated = true;
      }
    }
    // A0 budget ledger: measure where the round's calls and time go before tuning any limit.
    console.info(JSON.stringify({ event: 'flashloan.inventory_round', network: this.network, pools_considered: all.length, pools_selected: selected.length,
      pools_read: selected.filter(({ pool }) => pool.state).length, read_calls: callsBeforeFinal - callsAtStart, final_calls: this.budget.rpcCallsUsed - callsBeforeFinal,
      read_ms: Math.round(readMs), total_ms: Math.round(performance.now() - started), final_outcome: finalOutcome, deferred: coverage.deferred_counts, ...(this.decimalsBatchFailure ? { decimals_batch_failure: this.decimalsBatchFailure } : {}) }));
    const canonicalPools = new Map<string, InventoryPoolV3>();
    for (const { pool } of selected) {
      const prior = canonicalPools.get(pool.id);
      if (!prior) canonicalPools.set(pool.id, pool);
      else { const preferred = prior.liquidity_eligible ? prior : pool; preferred.provenance = [...new Map([...prior.provenance, ...pool.provenance].map((p) => [hash(p), p])).values()].slice(0, 16); canonicalPools.set(pool.id, preferred); }
    }
    const pools = [...canonicalPools.values()].sort((a, b) => a.id.localeCompare(b.id)); // stable id order for consumers
    for (const pool of pools) for (const code of new Set(pool.eligibility_reasons)) coverage.excluded_counts[code] = (coverage.excluded_counts[code] ?? 0) + 1;
    coverage.pools_watched = pools.filter((p) => p.liquidity_eligible).length;
    const partial = base.outcome === 'PARTIAL' || coverage.truncated || coverage.source_results.some((s) => s.status !== 'SUCCESS') || pools.some((p) => p.eligibility_reasons.some((r) => !['ZERO_ACTIVE_LIQUIDITY', 'BELOW_VIRTUAL_DEPTH_THRESHOLD'].includes(r)));
    return inventoryV3Schema.parse({ schema_version: 'flashloan.inventory.v3', network: this.network, chain_id: CHAINS[this.network], observed_at, block: block ? { number: BigInt(block.number).toString(), hash: block.hash, timestamp: BigInt(block.timestamp).toString() } : null, registry_version: this.registry.version, outcome: partial ? 'PARTIAL' : pools.length ? 'SUCCESS' : 'EMPTY', assets: [...assets.values()].sort((a, b) => a.asset_id.localeCompare(b.asset_id)), pools, token_results: [...new Set(tokens)].map((token) => { const id = assetId(this.network, token), matches = pools.filter((p) => p.asset_ids.includes(id)); return { token_id: id, disposition: excluded.includes(token) ? 'EXCLUDED' : 'INCLUDED', pool_ids: matches.map((p) => p.id), discovered_count: matches.length, liquidity_eligible_count: matches.filter((p) => p.liquidity_eligible).length }; }), coverage, warnings: ['Virtual depth is a screening metric, not executable capacity. Consumers must re-read state at their own pinned block.'] });
  }
}
