import { z } from 'zod';
import { address, uint, v4KeySchema, ResearchError, hash, type RiskPolicy } from './contracts';
import { bytes32 } from './networks';

export const Q96 = 1n << 96n;
const MAX_UINT256 = (1n << 256n) - 1n;
const multipliers = [
  'fffcb933bd6fad37aa2d162d1a594001','fff97272373d413259a46990580e213a','fff2e50f5f656932ef12357cf3c7fdcc','ffe5caca7e10e4e61c3624eaa0941cd0',
  'ffcb9843d60f6159c9db58835c926644','ff973b41fa98c081472e6896dfb254c0','ff2ea16466c96a3843ec78b326b52861','fe5dee046a99a2a811c461f1969c3053',
  'fcbe86c7900a88aedcffc83b479aa3a4','f987a7253ac413176f2b074cf7815e54','f3392b0822b70005940c7a398e4b70f3','e7159475a2c29b7443b29c7fa6e889d9',
  'd097f3bdfd2022b8845ad8f792aa5825','a9f746462d870fdf8a65dc1f90e061e5','70d869a156d2a1b890bb3df62baf32f7','31be135f97d08fd981231505542fcfa6',
  '9aa508b5b7a84e1c677de54f3e99bc9','5d6af8dedb81196699c329225ee604','2216e584f5fa1ea926041bedfe98','48a170391f7dc42444e8fa2',
].map((v) => BigInt('0x' + v));

export function sqrtAtTick(tick: number): bigint {
  if (!Number.isInteger(tick) || Math.abs(tick) > 887272) throw new ResearchError('TICK_OUT_OF_RANGE', 'Tick outside protocol limits.');
  let ratio = 1n << 128n; const abs = Math.abs(tick);
  for (let bit = 0; bit < multipliers.length; bit++) if (abs & (1 << bit)) ratio = ratio * multipliers[bit] >> 128n;
  if (tick > 0) ratio = MAX_UINT256 / ratio;
  return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}
export function ceilDiv(a: bigint, b: bigint): bigint { if (b <= 0n) throw new ResearchError('INVALID_LIQUIDITY', 'Nonpositive divisor.'); return (a + b - 1n) / b; }
export function bitmapPosition(tick: number, spacing: number) {
  if (!Number.isInteger(tick) || !Number.isInteger(spacing) || spacing <= 0) throw new ResearchError('INVALID_TICK_SPACING', 'Invalid tick spacing.');
  const compressed = Math.floor(tick / spacing); const word = Math.floor(compressed / 256);
  return { compressed, word, bit: compressed - word * 256 };
}
export function initializedTicks(word: number, bitmap: bigint, spacing: number): number[] {
  const out: number[] = [];
  for (let bit = 0; bit < 256; bit++) if (bitmap & (1n << BigInt(bit))) { const tick = (word * 256 + bit) * spacing; if (Math.abs(tick) <= 887272) out.push(tick); }
  return out;
}
export const saltKind = z.enum(['V3_FEE', 'SPACING', 'ALGEBRA', 'V2_PACKED']);
/** S1 canonicality: the pool address is the CREATE2 image of a reviewed (deployer, salt, init code hash). */
export const canonicalityProofSchema = z.object({ kind: z.literal('create2'), chain_id: z.number().int().positive(), adapter_version: z.string().min(1), factory: address, deployer: address, init_code_hash: z.string().regex(/^0x[0-9a-f]{64}$/), salt_kind: saltKind, salt_args: z.array(z.string().min(1)).min(2).max(3), salt: z.string().regex(/^0x[0-9a-f]{64}$/) }).strict();
export type CanonicalityProof = z.infer<typeof canonicalityProofSchema>;
// Optional fields are set only off the legacy path (non-exact quote model / factory-derived pool), so pinned outputs are unchanged.
const base = { address: z.union([address, bytes32]), token0: address, token1: address, decimals0: z.number().int().min(0).max(36), decimals1: z.number().int().min(0).max(36), fee_pips: z.number().int().min(0).max(999999), code_hash: z.string(), adapter_version: z.string(), quote_capability: z.literal('estimate').optional(), canonicality: canonicalityProofSchema.optional() };
export const poolSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('wrap'), wrapped_native: address, direction: z.enum(['wrap', 'unwrap']) }).strict(),
  z.object({ ...base, kind: z.literal('v2'), reserve0: uint, reserve1: uint, stable: z.boolean().default(false) }).strict(),
  z.object({ ...base, kind: z.literal('clmm'), v4: z.object({ manager: address, key: v4KeySchema, protocol_fee: z.number().int().min(0).max(16777215) }).strict().optional(), sqrt_price_x96: uint, tick: z.number().int().min(-887272).max(887272), liquidity: uint, tick_spacing: z.number().int().positive(), word_min: z.number().int(), word_max: z.number().int(), ticks: z.array(z.object({ tick: z.number().int(), liquidity_net: z.string().regex(/^-?[0-9]+$/) }).strict()).max(10000) }).strict(),
]);
export type Pool = z.infer<typeof poolSchema>;
export type Quote = { amount_out: bigint; pool: Pool; spot_out: bigint };

/**
 * Capability matrix (review file 11 §A): which local quote model is exact for a pool family.
 * `exact` may be sized; `estimate` may be sized but the result must be labelled INCONCLUSIVE; `none` is discovery-only.
 */
export type QuoteCapability = 'exact' | 'estimate' | 'none';
export type QuoteFamily = 'UNISWAP_V2' | 'UNISWAP_V3' | 'UNISWAP_V4' | 'WRAPPED_NATIVE' | 'ALGEBRA' | 'AERODROME_VOLATILE' | 'AERODROME_STABLE' | 'AERODROME_CLMM' | 'AAVE_V3' | 'BALANCER_V2' | 'UNISWAP_V3_FLASH';
/** Adapter versions whose quotePool output equals the venue's on-chain QuoterV2 (live parity, tests/flashloan-arb-integrity.test.ts). */
export const QUOTE_PARITY_EXACT: ReadonlySet<string> = new Set(['uniswap-v3', 'pancake-v3']);
export function quoteCapability(family: QuoteFamily, adapterVersion: string, facts: { hooked?: boolean; dynamic_fee?: boolean } = {}): QuoteCapability {
  switch (family) {
    case 'WRAPPED_NATIVE': case 'AERODROME_VOLATILE': return 'exact';
    case 'UNISWAP_V2': return facts.dynamic_fee ? 'none' : 'exact'; // fixed fee_pips from the reviewed template
    case 'UNISWAP_V4': return facts.hooked || facts.dynamic_fee ? 'none' : 'exact';
    case 'UNISWAP_V3': return /^pancake/.test(adapterVersion) ? (QUOTE_PARITY_EXACT.has(adapterVersion) ? 'exact' : 'estimate') : 'exact';
    case 'AERODROME_CLMM': return QUOTE_PARITY_EXACT.has(adapterVersion) ? 'exact' : 'estimate'; // Slipstream: fee module, no parity yet
    case 'ALGEBRA': case 'AERODROME_STABLE': return 'estimate'; // dynamic/directional fee; stable curve
    default: return 'none'; // lenders are not swap venues
  }
}
/** The same matrix applied to a snapshot pool (family inferred from kind and adapter version), never better than its own label. */
export function poolQuoteCapability(pool: Pool): QuoteCapability {
  const version = pool.adapter_version;
  const inferred = pool.kind === 'wrap' ? quoteCapability('WRAPPED_NATIVE', version)
    : pool.kind === 'v2' ? quoteCapability(pool.stable ? 'AERODROME_STABLE' : 'UNISWAP_V2', version, { dynamic_fee: /dynamic|deltaswap/i.test(version) })
    : pool.v4 ? quoteCapability('UNISWAP_V4', version, { hooked: BigInt(pool.v4.key.hooks) !== 0n, dynamic_fee: pool.v4.key.fee === 0x800000 })
    : quoteCapability(/^algebra/i.test(version) ? 'ALGEBRA' : /^slipstream/i.test(version) ? 'AERODROME_CLMM' : 'UNISWAP_V3', version);
  return inferred === 'exact' && pool.quote_capability === 'estimate' ? 'estimate' : inferred;
}
function stableK(x: bigint, y: bigint): bigint { return x * y * (x * x + y * y); }

/** Every call returns a new state; sequential routes cannot accidentally reuse old reserves. */
export function quotePool(pool: Pool, tokenIn: string, amount: bigint): Quote {
  if (amount < 0n || amount > MAX_UINT256) throw new ResearchError('INVALID_AMOUNT', 'Input outside uint256.');
  if (poolQuoteCapability(pool) === 'none') throw new ResearchError('QUOTE_UNSUPPORTED', 'No exact or estimate quote model for this pool family; it is discovery-only.');
  const zero = tokenIn === pool.token0;
  if (!zero && tokenIn !== pool.token1) throw new ResearchError('INVALID_ROUTE', 'Input token is not in pool.');
  const protocolFee = pool.kind === 'clmm' && pool.v4 ? (zero ? pool.v4.protocol_fee & 4095 : pool.v4.protocol_fee >> 12) : 0;
  const combinedFee = pool.fee_pips + protocolFee - Math.floor(pool.fee_pips * protocolFee / 1000000);
  if (pool.kind === 'wrap') {
    if (zero !== (pool.direction === 'unwrap')) throw new ResearchError('INVALID_ROUTE', 'Wrapped-native edge has the wrong direction.');
    return { amount_out: amount, spot_out: amount, pool };
  }
  const fee = BigInt(combinedFee), net = amount * (1000000n - fee) / 1000000n;
  if (pool.kind === 'v2') {
    const x = BigInt(zero ? pool.reserve0 : pool.reserve1), y = BigInt(zero ? pool.reserve1 : pool.reserve0);
    if (x <= 0n || y <= 0n) throw new ResearchError('INVALID_LIQUIDITY', 'Empty pool.');
    const weighted = amount * (1000000n - fee);
    let out = weighted * y / (x * 1000000n + weighted);
    let spotOut = weighted * y / (x * 1000000n);
    if (pool.stable) {
      const sx = 10n ** BigInt(zero ? pool.decimals0 : pool.decimals1), sy = 10n ** BigInt(zero ? pool.decimals1 : pool.decimals0);
      const nx = x * 10n ** 18n / sx, ny = y * 10n ** 18n / sy, nextX = (x + net) * 10n ** 18n / sx;
      const k = stableK(nx, ny); let lo = 0n, hi = ny;
      while (lo < hi) { const mid = (lo + hi) / 2n; if (stableK(nextX, mid) < k) lo = mid + 1n; else hi = mid; }
      out = (ny - lo) * sy / 10n ** 18n;
      spotOut = net * ny * (3n * nx * nx + ny * ny) * sy / (nx * (nx * nx + 3n * ny * ny) * sx);
      // This integer curve is an estimate; native stable-pool parity is required for verification.
    }
    return { amount_out: out, spot_out: spotOut, pool: { ...pool, reserve0: (zero ? x + amount : y - out).toString(), reserve1: (zero ? y - out : x + amount).toString() } };
  }
  let price = BigInt(pool.sqrt_price_x96), liquidity = BigInt(pool.liquidity), tick = pool.tick, remaining = amount, output = 0n;
  const spot = zero ? net * price * price / Q96 / Q96 : net * Q96 * Q96 / (price * price);
  const boundaries = pool.ticks.filter((t) => zero ? t.tick <= tick : t.tick > tick).sort((a, b) => zero ? b.tick - a.tick : a.tick - b.tick);
  const edgeTick = Math.max(-887272, Math.min(887272, (zero ? pool.word_min * 256 : (pool.word_max + 1) * 256) * pool.tick_spacing));
  const steps: Array<{ tick: number; liquidity_net: string; edge?: boolean }> = [...boundaries, { tick: edgeTick, liquidity_net: '0', edge: true }];
  for (const boundary of steps) {
    if (remaining === 0n) break;
    const target = sqrtAtTick(boundary.tick);
    if (zero ? target > price : target < price) continue;
    if (liquidity < 0n) throw new ResearchError('INVALID_LIQUIDITY', 'Negative active liquidity.');
    if (liquidity === 0n) {
      if (boundary.edge) throw new ResearchError('INSUFFICIENT_TICK_COVERAGE', 'No initialized liquidity within loaded bitmap words.');
      price = target; const delta = BigInt(boundary.liquidity_net); liquidity += zero ? -delta : delta;
      if (liquidity < 0n || liquidity >= 1n << 128n) throw new ResearchError('INVALID_LIQUIDITY', 'Tick crossing produced invalid liquidity.');
      tick = zero ? boundary.tick - 1 : boundary.tick; continue;
    }
    const needed = zero ? ceilDiv(liquidity * (price - target) * Q96, price * target) : ceilDiv(liquidity * (target - price), Q96);
    const available = remaining * (1000000n - fee) / 1000000n;
    const crosses = available >= needed;
    const next = crosses ? target : zero ? ceilDiv(liquidity * Q96 * price, liquidity * Q96 + available * price) : price + available * Q96 / liquidity;
    const used = zero ? ceilDiv(liquidity * (price - next) * Q96, price * next) : ceilDiv(liquidity * (next - price), Q96);
    output += zero ? liquidity * (price - next) / Q96 : liquidity * (next - price) * Q96 / (next * price);
    remaining -= crosses ? used + ceilDiv(used * fee, 1000000n - fee) : remaining;
    price = next;
    if (crosses) {
      if (boundary.edge && remaining > 0n) throw new ResearchError('INSUFFICIENT_TICK_COVERAGE', 'Quote exhausted loaded bitmap words.');
      const delta = BigInt(boundary.liquidity_net); liquidity += zero ? -delta : delta;
      if (liquidity < 0n || liquidity >= 1n << 128n) throw new ResearchError('INVALID_LIQUIDITY', 'Tick crossing produced invalid liquidity.');
      tick = zero ? boundary.tick - 1 : boundary.tick;
    }
  }
  if (remaining > 0n) throw new ResearchError('INSUFFICIENT_TICK_COVERAGE', 'Incomplete tick traversal.');
  // Recompute tick by binary search so a subsequent route sees the actual terminal interval.
  let lo = -887272, hi = 887272;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (sqrtAtTick(mid) <= price) lo = mid; else hi = mid - 1; }
  if (sqrtAtTick(lo) !== price || tick !== lo - 1) tick = lo;
  return { amount_out: output, spot_out: spot, pool: { ...pool, sqrt_price_x96: price.toString(), liquidity: liquidity.toString(), tick } };
}

export type Route = { id: string; hops: Array<{ pool: string; token_in: string; token_out: string }> };
export function closedRoutes(pools: Pool[], asset: string): Route[] { return enumerateClosedRoutes(pools, asset, { maxHops: 4, maxRoutes: 64 }).routes; }
/**
 * Directed closed-route DFS with explicit bounds (file 11 #12): `maxNodes` counts every pool edge examined, so a dense
 * graph stops with `exhausted: true` instead of exploding. Both directions of a cycle are distinct routes.
 */
export function enumerateClosedRoutes(pools: Pool[], asset: string, bounds: { maxHops: number; maxRoutes: number; maxNodes?: number }) {
  const routes: Route[] = []; let nodes = 0, exhausted = false;
  const limit = bounds.maxNodes ?? Infinity;
  const visit = (token: string, hops: Route['hops'], used: Set<string>) => {
    if (hops.length === bounds.maxHops || routes.length >= bounds.maxRoutes) return;
    for (const p of pools) {
      if (routes.length >= bounds.maxRoutes) break;
      if (nodes >= limit) { exhausted = true; return; }
      nodes++;
      if (used.has(p.address) || (p.token0 !== token && p.token1 !== token) || p.kind === 'wrap' && (p.direction === 'unwrap' ? token !== p.token0 : token !== p.token1)) continue;
      const next = p.token0 === token ? p.token1 : p.token0;
      const step = [...hops, { pool: p.address, token_in: token, token_out: next }];
      if (next === asset && step.length >= 2) routes.push({ id: hash(step), hops: step });
      else if (!hops.some((h) => h.token_in === next)) visit(next, step, new Set([...used, p.address]));
    }
  };
  visit(asset, [], new Set());
  return { routes, nodes_visited: nodes, exhausted: exhausted || routes.length >= bounds.maxRoutes };
}
export function quoteRoute(route: Route, initial: Map<string, Pool>, amount: bigint, impactBps: number) {
  const state = new Map(initial); let output = amount;
  for (const hop of route.hops) {
    const pool = state.get(hop.pool); if (!pool) throw new ResearchError('INVALID_ROUTE', 'Unknown pool.');
    const quote = quotePool(pool, hop.token_in, output);
    if (quote.spot_out > 0n && (quote.spot_out - quote.amount_out) * 10000n > quote.spot_out * BigInt(impactBps)) throw new ResearchError('PRICE_IMPACT_LIMIT', 'Route exceeds price-impact limit.');
    state.set(hop.pool, quote.pool); output = quote.amount_out;
  }
  return { output, state };
}

/** A Uniswap-V3-style flash lender is locked during its callback, so routes may not swap through the lender pool. */
export function lenderRoutablePools(pools: Pool[], lender: { provider?: string; address: string }): Pool[] {
  return lender.provider === 'UNISWAP_V3_FLASH' ? pools.filter((p) => p.address !== lender.address) : pools;
}
function isqrt(n: bigint): bigint { if (n < 2n) return n; let x = n, y = (x + 1n) / 2n; while (y < x) { x = y; y = (x + n / x) / 2n; } return x; }
export const DEPTH_BANDS_BPS = [50, 100, 200] as const;
export type DepthBand = { bps: number; amount0_in: bigint; amount1_in: bigint; complete: boolean };
/**
 * In-range depth (PRD-B): the fee-free input of token0 that moves the price down by `bps`, and of token1 that moves it
 * up by `bps`, integrated across loaded initialized ticks (CLMM) or from reserves (CPMM). A band that runs past the
 * loaded bitmap words is clipped there and marked incomplete. Stable curves and wrap edges have no band (null).
 */
export function depthBands(pool: Pool, bands: readonly number[] = DEPTH_BANDS_BPS): DepthBand[] | null {
  if (pool.kind === 'wrap' || pool.kind === 'v2' && pool.stable) return null;
  const S = 10n ** 18n, factor = (bps: number, up: boolean) => isqrt((up ? 10000n + BigInt(bps) : 10000n - BigInt(bps)) * S * S / 10000n);
  if (pool.kind === 'v2') {
    const x = BigInt(pool.reserve0), y = BigInt(pool.reserve1);
    if (x <= 0n || y <= 0n) return null;
    // x*y=k: price y/x falls by f when x grows to x/sqrt(f); rises by g when y grows to y*sqrt(g).
    return bands.map((bps) => ({ bps, amount0_in: x * S / factor(bps, false) - x, amount1_in: y * factor(bps, true) / S - y, complete: true }));
  }
  const start = BigInt(pool.sqrt_price_x96), active = BigInt(pool.liquidity);
  const lowEdge = Math.max(-887272, pool.word_min * 256 * pool.tick_spacing), highEdge = Math.min(887272, (pool.word_max + 1) * 256 * pool.tick_spacing);
  const down = pool.ticks.filter((t) => t.tick <= pool.tick).sort((a, b) => b.tick - a.tick);
  const up = pool.ticks.filter((t) => t.tick > pool.tick).sort((a, b) => a.tick - b.tick);
  const walk = (target: bigint, zero: boolean) => {
    let price = start, liquidity = active, amount = 0n;
    const steps = [...(zero ? down : up), { tick: zero ? lowEdge : highEdge, liquidity_net: '0', edge: true as const }];
    for (const step of steps) {
      const boundary = sqrtAtTick(step.tick), stop = zero ? (boundary > target ? boundary : target) : (boundary < target ? boundary : target);
      if (zero ? stop < price : stop > price) {
        if (liquidity > 0n) amount += zero ? liquidity * (price - stop) * Q96 / (price * stop) : liquidity * (stop - price) / Q96;
        price = stop;
      }
      if (price === target) return { amount, complete: true };
      if ('edge' in step) return { amount, complete: false };
      const delta = BigInt(step.liquidity_net); liquidity += zero ? -delta : delta;
      if (liquidity < 0n) throw new ResearchError('INVALID_LIQUIDITY', 'Tick crossing produced negative liquidity.');
    }
    return { amount, complete: false };
  };
  return bands.map((bps) => {
    const lo = walk(start * factor(bps, false) / S, true), hi = walk(start * factor(bps, true) / S, false);
    return { bps, amount0_in: lo.amount, amount1_in: hi.amount, complete: lo.complete && hi.complete };
  });
}
export type SearchOptions = { targets: string[]; deadline_ms: number; refine?: boolean };
export function solve(allPools: Pool[], asset: string, lender: { capacity: string; fee_numerator: string; fee_denominator: string; address: string; provider?: string }, policy: RiskPolicy, options?: SearchOptions) {
  const pools = lenderRoutablePools(allPools, lender);
  const started = performance.now(), timeBudgetMs = options ? Math.min(5000, options.deadline_ms) : 5000; let timeLimited = false;
  const capabilities = pools.map((p) => [p.address, poolQuoteCapability(p)] as const);
  if (capabilities.some(([, c]) => c === 'none')) throw new ResearchError('QUOTE_UNSUPPORTED', 'Sizing refuses discovery-only pools (quote capability none).');
  const estimatePools = capabilities.filter(([, c]) => c === 'estimate').map(([a]) => a);
  const enumerated = closedRoutes(pools, asset);
  const routes = options ? enumerated.filter((r) => r.hops.some((h) => options.targets.includes(h.token_in) || options.targets.includes(h.token_out))).sort((a, b) => a.id.localeCompare(b.id)) : enumerated;
  const evaluatedRoutes = new Set<string>();
  type Solution = { principal: string; allocations: Array<{ route: Route; amount: string }>; unused: string; expected_output: string; expected_profit: string; lender_fee: string };
  const targetResults = new Map<string, { asset: string; net_raw: string; principal_raw: string; route_ids: string[]; solution?: Solution }>();
  let phaseLimit = options?.refine ? Math.max(1, Math.floor(policy.max_evaluations * 0.75)) : policy.max_evaluations;
  const initial = new Map(pools.map((p) => [p.address, p]));
  const cap = BigInt(lender.capacity) < BigInt(policy.max_principal) ? BigInt(lender.capacity) : BigInt(policy.max_principal);
  let evaluations = 0; let best: { principal: string; allocations: Array<{ route: Route; amount: string }>; unused: string; expected_output: string; expected_profit: string; lender_fee: string } | undefined;
  const rejected = new Map<string, number>();
  const evaluate = (principal: bigint, chosen: Route[], amounts: bigint[]) => {
    if (performance.now() - started >= timeBudgetMs) { timeLimited = true; return; }
    if (evaluations >= phaseLimit) return; evaluations++;
    const deployed = amounts.reduce((a, b) => a + b, 0n);
    if (principal === 0n || deployed > principal || deployed * 10000n < principal * BigInt(policy.min_deployment_bps) || amounts.some((v) => v <= 0n || v * 10000n < principal * BigInt(policy.min_weight_bps))) return;
    try {
      let state = initial, out = principal - deployed;
      for (let i = 0; i < chosen.length; i++) { if (options) evaluatedRoutes.add(chosen[i].id); const q = quoteRoute(chosen[i], state, amounts[i], policy.max_price_impact_bps); out += q.output; state = q.state; }
      const fee = ceilDiv(principal * BigInt(lender.fee_numerator), BigInt(lender.fee_denominator));
      const profit = out - principal - fee - BigInt(policy.network_cost);
      if (options) for (const target of options.targets) {
        if (!chosen.some((r) => r.hops.some((h) => h.token_in === target || h.token_out === target))) continue;
        const previous = targetResults.get(target);
        if (!previous || profit > BigInt(previous.net_raw)) targetResults.set(target, { asset: target, net_raw: profit.toString(), principal_raw: principal.toString(), route_ids: chosen.map((r) => r.id), ...(options.refine ? { solution: { principal: principal.toString(), allocations: chosen.map((route, i) => ({ route, amount: amounts[i].toString() })), unused: (principal - deployed).toString(), expected_output: out.toString(), expected_profit: profit.toString(), lender_fee: fee.toString() } } : {}) });
      }
      if ((options ? profit < BigInt(policy.min_profit) : profit <= BigInt(policy.min_profit)) || best && profit <= BigInt(best.expected_profit)) return;
      best = { principal: principal.toString(), allocations: chosen.map((route, i) => ({ route, amount: amounts[i].toString() })), unused: (principal - deployed).toString(), expected_output: out.toString(), expected_profit: profit.toString(), lender_fee: fee.toString() };
    } catch (e) { if (!(e instanceof ResearchError)) throw e; rejected.set(e.code, (rejected.get(e.code) ?? 0) + 1); }
  };
  // Enumerate bounded subsets and compare route order against sequential state.
  const subsets: Route[][] = [];
  const enumerate = (at: number, chosen: Route[]) => {
    if (chosen.length) subsets.push(chosen);
    if (chosen.length >= policy.max_routes || subsets.length >= phaseLimit) return;
    for (let i = at; i < routes.length && subsets.length < phaseLimit; i++) enumerate(i + 1, [...chosen, routes[i]]);
  };
  enumerate(0, []);
  if (options) {
    // Fair first pass: attempt a route through every target before refining allocations.
    for (const target of options.targets) {
      const route = routes.find((r) => r.hops.some((h) => h.token_in === target || h.token_out === target));
      if (route) evaluate(cap / 32n || cap, [route], [cap / 32n || cap]);
    }
    const vectors = function* (n: number, remaining = 4, prefix: number[] = []): Generator<number[]> {
      if (n === 1) { yield [...prefix, remaining]; return; }
      for (let w = 0; w <= remaining; w++) yield* vectors(n - 1, remaining - w, [...prefix, w]);
    };
    const permutations = function* (indices: number[]): Generator<number[]> {
      if (!indices.length) { yield []; return; }
      for (const i of indices) for (const rest of permutations(indices.filter((j) => j !== i))) yield [i, ...rest];
    };
    const seen = new Set<string>();
    for (let scale = 1; scale <= 32 && evaluations < phaseLimit && !timeLimited; scale++) {
      const principal = cap * BigInt(scale) / 32n;
      for (const subset of subsets) {
        for (const weights of vectors(subset.length)) {
          const active = subset.map((_, i) => i).filter((i) => weights[i] > 0);
          const amounts = active.map((i) => principal * BigInt(weights[i]) / 4n);
          amounts[amounts.length - 1] += principal - amounts.reduce((a, b) => a + b, 0n);
          const poolsUsed = active.flatMap((i) => subset[i].hops.map((h) => h.pool));
          const orders = new Set(poolsUsed).size < poolsUsed.length ? permutations(active.map((_, i) => i)) : [active.map((_, i) => i)];
          for (const order of orders) {
            if (evaluations >= phaseLimit || timeLimited) break;
            const chosen = order.map((i) => subset[active[i]]), orderedAmounts = order.map((i) => amounts[i]);
            const key = principal + ':' + chosen.map((r, i) => r.id + ':' + orderedAmounts[i]).join(',');
            if (seen.has(key)) continue; seen.add(key);
            evaluate(principal, chosen, orderedAmounts);
          }
          if (evaluations >= phaseLimit || timeLimited) break;
        }
        if (evaluations >= phaseLimit || timeLimited) break;
      }
    }
  } else {
  // Interleave principal scales across subsets to avoid spending the entire budget on route 1.
  for (let scale = 1; scale <= 32 && evaluations < phaseLimit && !timeLimited; scale++) {
    const principal = cap * BigInt(scale) / 32n;
    for (const subset of subsets) {
      if (evaluations >= phaseLimit || timeLimited) break;
      const each = principal / BigInt(subset.length); const amounts = subset.map((_, i) => i === subset.length - 1 ? principal - each * BigInt(i) : each);
      evaluate(principal, subset, amounts);
      if (subset.length > 1 && evaluations < phaseLimit) evaluate(principal, [...subset].reverse(), [...amounts].reverse());
    }
  }
  }
  const coarseLimited = Boolean(options?.refine && evaluations >= phaseLimit);
  if (options?.refine) {
    phaseLimit = policy.max_evaluations;
    // Refine successful allocations with conserved one-way transfers at finer quanta.
    // Every failed replay consumes the same evaluation counter as a coarse attempt.
    for (const denominator of [16n, 64n, 256n, 1024n]) {
      if (!best || evaluations >= phaseLimit || timeLimited) break;
      const seed: Solution = best;
      const principal = BigInt(seed.principal), step = principal / denominator || 1n;
      for (let from = 0; from < seed.allocations.length; from++) {
        for (let to = 0; to < seed.allocations.length; to++) {
          if (from === to || evaluations >= phaseLimit || timeLimited) continue;
          const amounts = seed.allocations.map((a) => BigInt(a.amount));
          if (amounts[from] <= step) continue;
          amounts[from] -= step; amounts[to] += step;
          evaluate(principal, seed.allocations.map((a) => a.route), amounts);
        }
      }
    }
  }
  // Estimate-tier pools are marked so callers label the result INCONCLUSIVE; exact-only results are unchanged.
  return { ...(estimatePools.length ? { quote_capability: 'estimate' as const, estimate_pool_ids: estimatePools } : {}), ...(options ? { target_results: [...targetResults.values()], evaluated_route_ids: [...evaluatedRoutes], route_catalog: routes, route_enumeration_truncated: enumerated.length >= 64 } : {}), status: best ? 'FEASIBLE' : timeLimited || coarseLimited || evaluations >= policy.max_evaluations || rejected.has('INSUFFICIENT_TICK_COVERAGE') ? 'INCONCLUSIVE' : 'NO_OPPORTUNITY', solution: best ?? null, routes_considered: routes.length, evaluations, rejected_evaluations: Object.fromEntries(rejected), search: { classification: 'BOUNDED_HEURISTIC', termination: timeLimited ? 'TIME_BUDGET' : coarseLimited || evaluations >= policy.max_evaluations ? 'EVALUATION_BUDGET' : 'GRID_COMPLETE', time_budget_ms: timeBudgetMs, max_principal: cap.toString(), global_optimum_proven: false }, cost_assumptions: { network_cost: policy.network_cost }, policy_hash: hash(policy) };
}
