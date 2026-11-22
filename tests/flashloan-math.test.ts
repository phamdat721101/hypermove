import { describe, it, expect } from 'vitest';
import { bitmapPosition, initializedTicks, sqrtAtTick, Q96, quotePool, closedRoutes, quoteRoute, solve, type Pool } from '../src/lib/mcp/flashloan/math';
import { operationSchemas, riskPolicy } from '../src/lib/mcp/flashloan/contracts';
import { decimal, decimalText, quoteXrpl, assetKey, xrplCycles } from '../src/lib/mcp/flashloan/xrpl';

const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40);
export function v2(id = '3', reserve0 = '1000000', reserve1 = '2000000'): Pool {
  return { kind: 'v2', address: '0x' + id.repeat(40), token0: A, token1: B, decimals0: 18, decimals1: 18, fee_pips: 3000, code_hash: 'test', adapter_version: 'fixture', reserve0, reserve1, stable: false };
}
describe('exact pool math', () => {
  it('compresses negative ticks with floor semantics', () => { expect(bitmapPosition(-1, 10)).toEqual({ compressed: -1, word: -1, bit: 255 }); expect(initializedTicks(-1, 1n << 255n, 10)).toEqual([-10]); });
  it('matches canonical TickMath boundary values', () => { expect(sqrtAtTick(0)).toBe(Q96); expect(sqrtAtTick(-887272)).toBe(4295128739n); expect(sqrtAtTick(887272)).toBe(1461446703485210103287273052203988822378723970342n); expect(() => sqrtAtTick(887273)).toThrow(); });
  it('quotes V2 with integer rounding, both directions and immutable reserves', () => { const pool = v2(); const q = quotePool(pool, A, 1000n); expect(q.amount_out).toBe(1992n); expect(pool.kind === 'v2' && pool.reserve0).toBe('1000000'); expect(q.pool.kind === 'v2' && q.pool.reserve0).toBe('1001000'); expect(quotePool(pool, B, 1000n).amount_out).toBe(498n); });
  it('retains fractional V2 input fees until the output division', () => { expect(quotePool(v2(), A, 1n).amount_out).toBe(1n); });
  it('rejects empty liquidity, unknown token and negative amount', () => { expect(() => quotePool(v2('3', '0'), A, 1n)).toThrow(); expect(() => quotePool(v2(), 'wrong', 1n)).toThrow(); expect(() => quotePool(v2(), A, -1n)).toThrow(); });
  const clmm = (): Pool => ({ kind: 'clmm', address: '0x' + '5'.repeat(40), token0: A, token1: B, decimals0: 18, decimals1: 18, fee_pips: 3000, code_hash: 'test', adapter_version: 'fixture', sqrt_price_x96: Q96.toString(), tick: 0, liquidity: '1000000', tick_spacing: 1, word_min: -1, word_max: 0, ticks: [] });
  it('walks concentrated liquidity in both directions without floats', () => { expect(quotePool(clmm(), A, 100n).amount_out).toBe(98n); expect(quotePool(clmm(), B, 100n).amount_out).toBe(98n); });
  it('rejects exhausted tick coverage instead of quoting nonexistent liquidity', () => { expect(() => quotePool(clmm(), A, 1000000n)).toThrow('bitmap words'); });
  it('applies direction-specific liquidityNet and rejects underflow', () => { const p = clmm(); if (p.kind !== 'clmm') return; p.ticks = [{ tick: 0, liquidity_net: '1000001' }]; expect(() => quotePool(p, A, 100n)).toThrow('liquidity'); });
  it('evaluates stable-pool estimates with decimal normalization', () => { const pool = { ...v2(), stable: true, decimals0: 6, decimals1: 18, reserve0: '1000000000000', reserve1: '1000000000000000000000000' } as Pool; const q = quotePool(pool, A, 1000000n); expect(q.amount_out > 996000000000000000n).toBe(true); expect(q.amount_out <= 997000000000000000n).toBe(true); });
  it('builds closed paths and shares updated pool state', () => { const pools = [v2(), v2('4', '1000000', '1000000')]; const routes = closedRoutes(pools, A); expect(routes).toHaveLength(2); const state = new Map(pools.map((p) => [p.address, p])); const q1 = quoteRoute(routes[0], state, 1000n, 5000); const q2 = quoteRoute(routes[0], q1.state, 1000n, 5000); expect(q2.output).toBeLessThan(q1.output); });
  it('sizes below the removed dollar floors and reports a bounded search', () => { const result = solve([v2(), v2('4', '1000000', '1000000')], A, { capacity: '10000', fee_numerator: '9', fee_denominator: '10000', address: 'lender' }, riskPolicy.parse({ max_principal: '1000', network_cost: '1' })); expect(result.status).toBe('FEASIBLE'); expect(BigInt(result.solution!.expected_profit)).toBeGreaterThan(0n); expect(result.search.global_optimum_proven).toBe(false); expect(BigInt(result.solution!.principal)).toBeLessThanOrEqual(1000n); });
  it('enforces randomized route allocation bounds', () => { for (let i = 1; i <= 20; i++) { const result = solve([v2(), v2('4')], A, { capacity: String(i * 100), fee_numerator: '9', fee_denominator: '10000', address: 'lender' }, riskPolicy.parse({ max_principal: '10000', network_cost: '100000', max_evaluations: i })); expect(result.solution).toBeNull(); expect(result.evaluations).toBeLessThanOrEqual(i); } });
});
describe('canonical contracts and XRPL amounts', () => {
  it('accepts native XRPL and issuer-qualified assets through the public contract', () => { expect(operationSchemas.xrpl_discover_arbitrage_routes.safeParse({ idempotency_key: 'xrpl', network: 'xrpl', assets: [{ kind: 'xrp' }, { kind: 'issued', currency: 'USD', issuer: 'rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv' }], funding: { mode: 'hypothetical', balances: [{ asset: { kind: 'xrp' }, amount: '100' }] } }).success).toBe(true); });
  it('rejects nested malformed pools and injected owners', () => { expect(operationSchemas.flashloan_ingest_l2_tickmap_and_reserves.safeParse({ idempotency_key: 'a', network: 'base', pools: [{ address: 'bad', adapter: 'UNISWAP_V3' }], lender: { address: A, asset: B, provider: 'AAVE_V3' } }).success).toBe(false); expect(operationSchemas.flashloan_discover_arbitrage_pools.safeParse({ idempotency_key: 'a', network: 'base', tokens: [A], owner_id: 'other' }).success).toBe(false); });
  it('preserves exact native decimals and case-sensitive issued currencies', () => { expect(decimalText(decimal('1.234567890123456e-2'))).toBe('0.01234567890123456'); expect(decimalText(decimal('1e-20'))).toBe('0.00000000000000000001'); expect(assetKey({ kind: 'issued', currency: 'usd', issuer: 'issuer' })).not.toBe(assetKey({ kind: 'issued', currency: 'USD', issuer: 'issuer' })); });
  it('quotes funded book depth and refuses uncovered amounts', () => { const edge = { id: 'book', kind: 'book' as const, from: 'A', to: 'B', offers: [{ input: '2', output: '3' }], restrictions: [] }; expect(quoteXrpl(edge, '1')).toBe('1.5'); expect(() => quoteXrpl(edge, '3')).toThrow('depth'); });
  it('enumerates closed native cycles without reusing the same physical venue', () => { const result = xrplCycles({ network: 'xrpl', ledger_hash: 'ledger', ledger_index: 1, funding: { mode: 'hypothetical', balances: [] }, balances: { A: '10' }, edges: [{ id: 'ab', venue: 'one', kind: 'book', from: 'A', to: 'B', offers: [{ input: '10', output: '20' }], restrictions: [] }, { id: 'ba', venue: 'two', kind: 'book', from: 'B', to: 'A', offers: [{ input: '20', output: '12' }], restrictions: [] }], warnings: [], estimate_only: true }); expect(result.routes).toHaveLength(1); expect(result.routes[0].estimated_profit).toBe('0.2'); expect(result.routes[0].status).toBe('ESTIMATE_ONLY'); });
});


describe('candidate allocation search', () => {
  it('preserves legacy results and bounds target search including failed quotes', () => {
    const pools = [v2('3'), v2('4', '1000000', '1000000')];
    const lender = { capacity: '10000', fee_numerator: '9', fee_denominator: '10000', address: '0x' + '9'.repeat(40) };
    const policy = riskPolicy.parse({ max_principal: '10000', network_cost: '0', max_price_impact_bps: 5000, max_evaluations: 4 });
    const legacy = solve(pools, A, lender, policy);
    expect(legacy).not.toHaveProperty('route_catalog');
    const result = solve(pools, A, lender, policy, { targets: [B], deadline_ms: 1000 });
    expect(result.evaluations).toBeLessThanOrEqual(4);
    expect(result.evaluated_route_ids!.length).toBeGreaterThan(0);
    expect(result.route_catalog!.every((r) => r.hops.some((h) => h.token_in === B || h.token_out === B))).toBe(true);
    expect(result.search.global_optimum_proven).toBe(false);
    if (result.solution) expect(result.solution.allocations.reduce((n, a) => n + BigInt(a.amount), BigInt(result.solution.unused))).toBe(BigInt(result.solution.principal));
  });
});

it('finds unequal allocation that beats equal and singles against an independent V2 oracle', () => {
  const C = '0x' + '5'.repeat(40);
  const pools = [v2('3', '100000', '200000'), v2('4', '100000', '100000'), { ...v2('6', '300000', '600000'), token1: C }, { ...v2('7', '300000', '300000'), token1: C }];
  const lender = { capacity: '10000', fee_numerator: '0', fee_denominator: '10000', address: '0x' + '9'.repeat(40) };
  const policy = riskPolicy.parse({ max_principal: '10000', network_cost: '0', max_price_impact_bps: 5000, max_evaluations: 10000, max_routes: 2 });
  const result = solve(pools, A, lender, policy, { targets: [B, C], deadline_ms: 5000 });
  const swap = (amount: bigint, rin: bigint, rout: bigint) => amount * 997000n * rout / (rin * 1000000n + amount * 997000n);
  const cycle = (amount: bigint, scale: bigint) => swap(swap(amount, 100000n * scale, 200000n * scale), 100000n * scale, 100000n * scale);
  const oracle = (a: bigint) => cycle(a, 1n) + cycle(10000n - a, 3n) - 10000n;
  expect(oracle(2500n)).toBeGreaterThan(oracle(5000n));
  expect(oracle(2500n)).toBeGreaterThan(oracle(0n));
  expect(oracle(2500n)).toBeGreaterThan(oracle(10000n));
  expect(BigInt(result.solution!.expected_profit)).toBe(oracle(2500n));
  expect(result.solution!.allocations.map((a) => a.amount).sort()).toEqual(['2500', '7500']);
  console.log(JSON.stringify({ event: 'flashloan.candidate_research.edge', edge: 'EDGE-02', passed: true }));
});


it('applies shared-pool branch state in order against independently calculated outputs', () => {
  const pools = [v2('3', '100000', '200000'), v2('4', '100000', '170000'), v2('5', '300000', '300000')];
  const route = (sell: string) => ({ id: sell, hops: [{ pool: pools[0].address, token_in: A, token_out: B }, { pool: '0x' + sell.repeat(40), token_in: B, token_out: A }] });
  const initial = new Map(pools.map((p) => [p.address, p]));
  const first = quoteRoute(route('4'), initial, 2500n, 5000);
  const second = quoteRoute(route('5'), first.state, 7500n, 5000);
  const reverseFirst = quoteRoute(route('5'), initial, 7500n, 5000);
  const reverseSecond = quoteRoute(route('4'), reverseFirst.state, 2500n, 5000);
  expect(first.output + second.output).toBe(15440n);
  expect(reverseFirst.output + reverseSecond.output).toBe(15671n);
  expect(pools[0].kind === 'v2' && pools[0].reserve0).toBe('100000');
});
