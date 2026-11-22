// @vitest-environment node
// EDGE-01 seam (PRD-A′ sizing → executor calldata) for docs/features/flashloan-mcp-arb-upgrade-map.md.
// A8 (review file 11, finding #6): Morpho Blue lender, on-chain Balancer fee, Pancake/Slipstream swap adapter, V3-flash self-route lock.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, keccak256, parseAbi, toFunctionSelector, type Hex } from 'viem';
import { z } from 'zod';
import { EvmReader, deploymentSchema, type Deployment, type Header } from '../src/lib/mcp/flashloan/evm';
import { JsonClient } from '../src/lib/mcp/flashloan/transport';
import { compilePlan, type Plan } from '../src/lib/mcp/flashloan/simulation';
import { solve, type Pool } from '../src/lib/mcp/flashloan/math';
import { operationSchemas, riskPolicy } from '../src/lib/mcp/flashloan/contracts';

afterEach(() => { vi.unstubAllEnvs(); });
const CODE = '0x6000' as Hex, BLOCK = '0x' + 'a'.repeat(64);
const HEADER: Header = { number: '0x10', hash: BLOCK, timestamp: '0x1', parentHash: '0x' + 'c'.repeat(64), gasLimit: '0x100000', miner: '0x' + '0'.repeat(40) };
const MORPHO = '0x6c247b1f6182318877311737bac0844baa518f5e', VAULT = '0xba12222222228d8ba445958a75a0704d566bf2c8', COLLECTOR = '0x' + '7'.repeat(40);
const USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831', WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1';
const word = (v: bigint | string) => '0x' + BigInt(v).toString(16).padStart(64, '0');
const sel = (signature: string) => toFunctionSelector(signature);
const pinned = (address: string, adapter: Deployment['adapter']): Deployment => deploymentSchema.parse({ network: 'arbitrum', address, adapter, code_hash: keccak256(CODE), version: adapter.toLowerCase() });

/** Direct eth_call mock; undefined answer = revert. Records every call. */
function mockRpc(answer: (to: string, data: string) => string | undefined) {
  const calls: Array<{ to: string; data: string }> = [];
  const handle = (r: { id: number; method: string; params: unknown[] }) => {
    if (r.method === 'eth_chainId') return { jsonrpc: '2.0', id: r.id, result: '0xa4b1' };
    if (r.method === 'eth_getBlockByNumber') return { jsonrpc: '2.0', id: r.id, result: HEADER };
    if (r.method === 'eth_getCode') return { jsonrpc: '2.0', id: r.id, result: CODE };
    const { to, data } = r.params[0] as { to: string; data: string }; calls.push({ to: to.toLowerCase(), data });
    const v = answer(to.toLowerCase(), data);
    return v === undefined ? { jsonrpc: '2.0', id: r.id, error: { code: 3, message: 'execution reverted' } } : { jsonrpc: '2.0', id: r.id, result: v };
  };
  const fetcher: typeof fetch = async (_url, init) => { const body = JSON.parse(String(init?.body)); return Response.json(Array.isArray(body) ? body.map(handle) : handle(body)); };
  return { client: new JsonClient('https://rpc.test', fetcher), calls };
}
const lenderSnapshot = (reader: EvmReader, provider: string, address: string, asset: string) =>
  reader.snapshot({ idempotency_key: 'm4', network: 'arbitrum', pools: [], lender: { provider, address, asset } } as unknown as Parameters<EvmReader['snapshot']>[0]);

describe('A8 Morpho Blue lender state', () => {
  it('reads capacity as balanceOf(asset, morpho) with a zero fee and never calls a fee getter', async () => {
    const { client, calls } = mockRpc((to, data) => to === USDC && data === sel('balanceOf(address)') + MORPHO.slice(2).padStart(64, '0') ? word(370_891_482_870n) : undefined);
    const snapshot = await lenderSnapshot(new EvmReader(client, 'arbitrum', [pinned(MORPHO, 'MORPHO_BLUE')]), 'MORPHO_BLUE', MORPHO, USDC);
    expect(snapshot.lender).toMatchObject({ provider: 'MORPHO_BLUE', capacity: '370891482870', fee_numerator: '0', fee_denominator: '1' });
    expect(calls.map((c) => c.data.slice(0, 10))).toEqual([sel('balanceOf(address)')]);
  });
  it('refuses an unreviewed Morpho runtime (no pinned deployment)', async () => {
    const { client } = mockRpc(() => word(1n));
    await expect(lenderSnapshot(new EvmReader(client, 'arbitrum', []), 'MORPHO_BLUE', MORPHO, USDC)).rejects.toMatchObject({ code: expect.stringMatching(/UNSUPPORTED|MISMATCH/) });
  });
  it('admits MORPHO_BLUE in the ingest schema only behind FLASHLOAN_ARB_LENDERS_V1', () => {
    const input = { idempotency_key: 'm4', network: 'arbitrum', pools: [{ address: USDC, adapter: 'UNISWAP_V3' }], lender: { provider: 'MORPHO_BLUE', address: MORPHO, asset: USDC } };
    expect(operationSchemas.flashloan_ingest_l2_tickmap_and_reserves.safeParse(input).success).toBe(false);
    const off = JSON.stringify(z.toJSONSchema(operationSchemas.flashloan_ingest_l2_tickmap_and_reserves, { io: 'input', target: 'draft-7' }));
    expect(off).not.toContain('MORPHO_BLUE');
    vi.stubEnv('FLASHLOAN_ARB_LENDERS_V1', 'true');
    expect(operationSchemas.flashloan_ingest_l2_tickmap_and_reserves.safeParse(input).success).toBe(true);
  });
});

describe('A8 Balancer V2 fee is read on-chain', () => {
  it('uses ProtocolFeesCollector.getFlashLoanFeePercentage() and ignores any configured fee', async () => {
    const { client, calls } = mockRpc((to, data) => to === VAULT && data === sel('getProtocolFeesCollector()') ? word(COLLECTOR) : to === COLLECTOR && data === sel('getFlashLoanFeePercentage()') ? word(5n * 10n ** 14n) : to === WETH ? word(10n ** 21n) : undefined);
    const configured = deploymentSchema.parse({ ...pinned(VAULT, 'BALANCER_V2'), fee_pips: 0 });
    const snapshot = await lenderSnapshot(new EvmReader(client, 'arbitrum', [configured]), 'BALANCER_V2', VAULT, WETH);
    expect(snapshot.lender).toMatchObject({ fee_numerator: (5n * 10n ** 14n).toString(), fee_denominator: (10n ** 18n).toString(), capacity: (10n ** 21n).toString() });
    expect(calls.some((c) => c.to === COLLECTOR && c.data === sel('getFlashLoanFeePercentage()'))).toBe(true);
  });
});

const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), Q96 = 1n << 96n;
const clmm = (id: string, version: string): Pool => ({ kind: 'clmm', address: '0x' + id.repeat(40), token0: A, token1: B, decimals0: 18, decimals1: 18, fee_pips: 500, code_hash: 'test', adapter_version: version, sqrt_price_x96: Q96.toString(), tick: 0, liquidity: (10n ** 24n).toString(), tick_spacing: 1, word_min: -1, word_max: 0, ticks: [] });
const v2 = (id: string, r0: bigint, r1: bigint): Pool => ({ kind: 'v2', address: '0x' + id.repeat(40), token0: A, token1: B, decimals0: 18, decimals1: 18, fee_pips: 3000, code_hash: 'test', adapter_version: 'fixture', reserve0: r0.toString(), reserve1: r1.toString(), stable: false });
const executorAbi = parseAbi(['function execute(address source,uint8 provider,address token,uint256 amount,(address pool,address tokenIn,address tokenOut,uint8 kind,uint256 amountIn,uint256 minOut)[] steps,uint256 minProfit) returns(uint256 profit)']);
function plan(provider: string, lender: string, pools: Pool[]): Plan {
  const [first, second] = pools;
  return { snapshot_id: 'x', borrow_asset: A, policy: { network_cost: '0', min_profit: '0' }, solution: { principal: '1000', expected_profit: '0', allocations: [{ amount: '1000', route: { id: 'r', hops: [{ pool: first.address, token_in: A, token_out: B }, { pool: second.address, token_in: B, token_out: A }] } }] },
    snapshot: { network: 'arbitrum', chain_id: 42161, block: HEADER, pools, lender: { provider, address: lender, asset: A, capacity: '1000000', fee_numerator: '0', fee_denominator: '1', code_hash: keccak256(CODE) }, coverage: [], warnings: [] } } as Plan;
}

describe('A8 compilePlan provider mapping and swap adapter', () => {
  const pancake = clmm('a', 'pancake-v3'), slipstream = clmm('b', 'slipstream-v1');
  it.each([['AAVE_V3', 0], ['BALANCER_V2', 1], ['UNISWAP_V3_FLASH', 2], ['MORPHO_BLUE', 3]] as const)('%s → executor provider %i', (provider, id) => {
    const { data } = compilePlan(plan(provider, '0x' + '9'.repeat(40), [pancake, slipstream]), '0x' + '8'.repeat(40));
    const args = decodeFunctionData({ abi: executorAbi, data: data as Hex }).args;
    expect(args[1]).toBe(id);
    // Pancake V3 and Slipstream pools share the Concentrated swap ABI (kind 1); their callbacks are pancakeV3SwapCallback / uniswapV3SwapCallback.
    expect(args[4].map((s) => [s.pool.toLowerCase(), s.kind])).toEqual([[pancake.address, 1], [slipstream.address, 1]]);
  });
  it('rejects an unknown lender and a route through the V3-flash lender pool', () => {
    expect(() => compilePlan(plan('EULER', '0x' + '9'.repeat(40), [pancake, slipstream]), '0x' + '8'.repeat(40))).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_LENDER' }));
    expect(() => compilePlan(plan('UNISWAP_V3_FLASH', pancake.address, [pancake, slipstream]), '0x' + '8'.repeat(40))).toThrow(expect.objectContaining({ code: 'LENDER_POOL_LOCK' }));
    expect(() => compilePlan(plan('MORPHO_BLUE', pancake.address, [pancake, slipstream]), '0x' + '8'.repeat(40))).not.toThrow();
  });
});

describe('A8 V3-flash lender self-route exclusion in solve', () => {
  it('excludes every route that swaps through the lender pool, only for UNISWAP_V3_FLASH', () => {
    const cheap = v2('3', 10n ** 24n, 2n * 10n ** 24n), dear = v2('4', 2n * 10n ** 24n, 10n ** 24n), other = v2('5', 10n ** 24n, 10n ** 24n);
    const policy = riskPolicy.parse({ max_principal: (10n ** 22n).toString(), network_cost: '0', max_evaluations: 200 });
    const lender = { capacity: (10n ** 23n).toString(), fee_numerator: '0', fee_denominator: '1', address: cheap.address };
    const touches = (r: ReturnType<typeof solve>) => (r.route_catalog ?? []).some((route) => route.hops.some((h) => h.pool === cheap.address)) || JSON.stringify(r.solution ?? null).includes(cheap.address);
    const search = { targets: [B], deadline_ms: 2000 };
    const locked = solve([cheap, dear, other], A, { ...lender, provider: 'UNISWAP_V3_FLASH' }, policy, search);
    expect(touches(locked)).toBe(false);
    expect(locked.route_catalog!.length).toBeGreaterThan(0);
    expect(touches(solve([cheap, dear, other], A, { ...lender, provider: 'MORPHO_BLUE' }, policy, search))).toBe(true);
    console.log(JSON.stringify({ event: 'flashloan.arb.edge', marker: 'FLARB_EDGE_01', passed: true }));
  });
});

// Live: FLASHLOAN_LIVE=1. Reads Morpho USDC/WETH capacity and the Balancer V2 flash fee on Arbitrum at one block.
const live = process.env.FLASHLOAN_LIVE === '1';
const rpcUrl = process.env.FLASHLOAN_ARBITRUM_RPC ?? 'https://arb1.arbitrum.io/rpc';
describe.skipIf(!live)('Arbitrum 0-fee lenders (live)', () => {
  it('Morpho capacity and Balancer fee through EvmReader.snapshot', async () => {
    const client = new JsonClient(rpcUrl, fetch, 20000);
    const code = async (a: string) => keccak256(await client.rpc<Hex>('eth_getCode', [a, 'latest']));
    const morpho = deploymentSchema.parse({ network: 'arbitrum', address: MORPHO, adapter: 'MORPHO_BLUE', code_hash: await code(MORPHO), version: 'morpho-blue' });
    const vault = deploymentSchema.parse({ network: 'arbitrum', address: VAULT, adapter: 'BALANCER_V2', code_hash: await code(VAULT), version: 'balancer-v2' });
    const reader = new EvmReader(client, 'arbitrum', [morpho, vault]);
    const usdc = await lenderSnapshot(reader, 'MORPHO_BLUE', MORPHO, USDC), weth = await lenderSnapshot(reader, 'MORPHO_BLUE', MORPHO, WETH), bal = await lenderSnapshot(reader, 'BALANCER_V2', VAULT, WETH);
    console.log(JSON.stringify({ event: 'flashloan.arb.live_lenders', block: Number(BigInt(usdc.block.number)), morpho_code_hash: morpho.code_hash, morpho_usdc: usdc.lender.capacity, morpho_weth: weth.lender.capacity, balancer_fee: bal.lender.fee_numerator + '/' + bal.lender.fee_denominator, balancer_weth: bal.lender.capacity }));
    expect(BigInt(usdc.lender.capacity)).toBeGreaterThan(0n);
    expect(BigInt(weth.lender.capacity)).toBeGreaterThan(0n);
    expect(bal.lender.fee_denominator).toBe((10n ** 18n).toString());
  }, 120_000);
});
