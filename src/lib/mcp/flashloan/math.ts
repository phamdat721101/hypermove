import { z } from 'zod';
import { address, uint, ResearchError, hash, type RiskPolicy } from './contracts';

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
const base = { address, token0: address, token1: address, decimals0: z.number().int().min(0).max(36), decimals1: z.number().int().min(0).max(36), fee_pips: z.number().int().min(0).max(999999), code_hash: z.string(), adapter_version: z.string() };
export const poolSchema = z.discriminatedUnion('kind', [
  z.object({ ...base, kind: z.literal('v2'), reserve0: uint, reserve1: uint, stable: z.boolean().default(false) }).strict(),
  z.object({ ...base, kind: z.literal('clmm'), sqrt_price_x96: uint, tick: z.number().int().min(-887272).max(887272), liquidity: uint, tick_spacing: z.number().int().positive(), word_min: z.number().int(), word_max: z.number().int(), ticks: z.array(z.object({ tick: z.number().int(), liquidity_net: z.string().regex(/^-?[0-9]+$/) }).strict()).max(10000) }).strict(),
]);
export type Pool = z.infer<typeof poolSchema>;
export type Quote = { amount_out: bigint; pool: Pool; spot_out: bigint };
function stableK(x: bigint, y: bigint): bigint { return x * y * (x * x + y * y); }

/** Every call returns a new state; sequential routes cannot accidentally reuse old reserves. */
export function quotePool(pool: Pool, tokenIn: string, amount: bigint): Quote {
  if (amount < 0n || amount > MAX_UINT256) throw new ResearchError('INVALID_AMOUNT', 'Input outside uint256.');
  const zero = tokenIn === pool.token0;
  if (!zero && tokenIn !== pool.token1) throw new ResearchError('INVALID_ROUTE', 'Input token is not in pool.');
  const fee = BigInt(pool.fee_pips), net = amount * (1000000n - fee) / 1000000n;
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
export function closedRoutes(pools: Pool[], asset: string): Route[] {
  const routes: Route[] = [];
  const visit = (token: string, hops: Route['hops'], used: Set<string>) => {
    if (hops.length === 4 || routes.length >= 64) return;
    for (const p of pools) {
      if (routes.length >= 64) break;
      if (used.has(p.address) || (p.token0 !== token && p.token1 !== token)) continue;
      const next = p.token0 === token ? p.token1 : p.token0;
      const step = [...hops, { pool: p.address, token_in: token, token_out: next }];
      if (next === asset && step.length >= 2) routes.push({ id: hash(step), hops: step });
      else if (!hops.some((h) => h.token_in === next)) visit(next, step, new Set([...used, p.address]));
    }
  };
  visit(asset, [], new Set()); return routes;
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

export function solve(pools: Pool[], asset: string, lender: { capacity: string; fee_numerator: string; fee_denominator: string; address: string }, policy: RiskPolicy) {
  const started = performance.now(), timeBudgetMs = 5000; let timeLimited = false;
  const routes = closedRoutes(pools, asset); const initial = new Map(pools.map((p) => [p.address, p]));
  const cap = BigInt(lender.capacity) < BigInt(policy.max_principal) ? BigInt(lender.capacity) : BigInt(policy.max_principal);
  let evaluations = 0; let best: { principal: string; allocations: Array<{ route: Route; amount: string }>; unused: string; expected_output: string; expected_profit: string; lender_fee: string } | undefined;
  const rejected = new Map<string, number>();
  const evaluate = (principal: bigint, chosen: Route[], amounts: bigint[]) => {
    if (performance.now() - started >= timeBudgetMs) { timeLimited = true; return; }
    if (evaluations >= policy.max_evaluations) return; evaluations++;
    const deployed = amounts.reduce((a, b) => a + b, 0n);
    if (principal === 0n || deployed > principal || deployed * 10000n < principal * BigInt(policy.min_deployment_bps) || amounts.some((v) => v <= 0n || v * 10000n < principal * BigInt(policy.min_weight_bps))) return;
    try {
      let state = initial, out = principal - deployed;
      for (let i = 0; i < chosen.length; i++) { const q = quoteRoute(chosen[i], state, amounts[i], policy.max_price_impact_bps); out += q.output; state = q.state; }
      const fee = ceilDiv(principal * BigInt(lender.fee_numerator), BigInt(lender.fee_denominator));
      const profit = out - principal - fee - BigInt(policy.network_cost);
      if (profit <= BigInt(policy.min_profit) || best && profit <= BigInt(best.expected_profit)) return;
      best = { principal: principal.toString(), allocations: chosen.map((route, i) => ({ route, amount: amounts[i].toString() })), unused: (principal - deployed).toString(), expected_output: out.toString(), expected_profit: profit.toString(), lender_fee: fee.toString() };
    } catch (e) { if (!(e instanceof ResearchError)) throw e; rejected.set(e.code, (rejected.get(e.code) ?? 0) + 1); }
  };
  // Enumerate bounded subsets and compare route order against sequential state.
  const subsets: Route[][] = [];
  const enumerate = (at: number, chosen: Route[]) => {
    if (chosen.length) subsets.push(chosen);
    if (chosen.length >= policy.max_routes || subsets.length >= policy.max_evaluations) return;
    for (let i = at; i < routes.length && subsets.length < policy.max_evaluations; i++) enumerate(i + 1, [...chosen, routes[i]]);
  };
  enumerate(0, []);
  // Interleave principal scales across subsets to avoid spending the entire budget on route 1.
  for (let scale = 1; scale <= 32 && evaluations < policy.max_evaluations && !timeLimited; scale++) {
    const principal = cap * BigInt(scale) / 32n;
    for (const subset of subsets) {
      if (evaluations >= policy.max_evaluations || timeLimited) break;
      const each = principal / BigInt(subset.length); const amounts = subset.map((_, i) => i === subset.length - 1 ? principal - each * BigInt(i) : each);
      evaluate(principal, subset, amounts);
      if (subset.length > 1 && evaluations < policy.max_evaluations) evaluate(principal, [...subset].reverse(), [...amounts].reverse());
    }
  }
  return { status: best ? 'FEASIBLE' : timeLimited || evaluations >= policy.max_evaluations || rejected.has('INSUFFICIENT_TICK_COVERAGE') ? 'INCONCLUSIVE' : 'NO_OPPORTUNITY', solution: best ?? null, routes_considered: routes.length, evaluations, rejected_evaluations: Object.fromEntries(rejected), search: { classification: 'BOUNDED_HEURISTIC', termination: timeLimited ? 'TIME_BUDGET' : evaluations >= policy.max_evaluations ? 'EVALUATION_BUDGET' : 'GRID_COMPLETE', time_budget_ms: timeBudgetMs, max_principal: cap.toString(), global_optimum_proven: false }, cost_assumptions: { network_cost: policy.network_cost }, policy_hash: hash(policy) };
}
