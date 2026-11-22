// @vitest-environment node
// EDGE-01 (seam: discovery → sizing integrity) for docs/features/flashloan-mcp-arb-upgrade-map.md.
// A2'' batchSettled · A5' CREATE2 derivation proof · capability matrix · quote parity (review file 11 §A).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { decodeFunctionData, encodeFunctionResult, keccak256, parseAbi, toFunctionSelector, type Hex } from 'viem';
import { EvmReader, deploymentSchema, verifyCreate2Derivation, type Deployment, type Header } from '../src/lib/mcp/flashloan/evm';
import { JsonClient } from '../src/lib/mcp/flashloan/transport';
import { ResearchEngine } from '../src/lib/mcp/flashloan/engine';
import { quoteCapability, poolQuoteCapability, quotePool, solve, type Pool } from '../src/lib/mcp/flashloan/math';
import { riskPolicy } from '../src/lib/mcp/flashloan/contracts';
import { fixtureV8, A8, Q8, P8, P82, F8, CODE8, BLOCK8 } from './fixtures/flashloan-v8';

afterEach(() => { vi.restoreAllMocks(); });
const marker = () => console.log(JSON.stringify({ event: 'flashloan.arb.edge', marker: 'FLARB_EDGE_01', passed: true }));
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const aggregate3 = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
const word = (...values: Array<bigint | number | string>) => '0x' + values.map((v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, '0')).join('');
const HEADER: Header = { number: '0x10', hash: BLOCK8, timestamp: '0x1', parentHash: '0x' + 'c'.repeat(64), gasLimit: '0x100000', miner: A8 };

/** Minimal JSON-RPC mock: direct eth_call and Multicall3 members share one answer table; undefined = revert. */
function mockRpc(chainId: number, answer: (to: string, data: string) => string | undefined) {
  const subcalls: Array<{ to: string; data: string }> = [];
  const handle = (request: { id: number; method: string; params: unknown[] }) => {
    const { method, params } = request;
    if (method === 'eth_chainId') return { jsonrpc: '2.0', id: request.id, result: '0x' + chainId.toString(16) };
    if (method === 'eth_getBlockByNumber') return { jsonrpc: '2.0', id: request.id, result: HEADER };
    if (method === 'eth_getCode') return { jsonrpc: '2.0', id: request.id, result: CODE8 };
    const { to, data } = params[0] as { to: string; data: string };
    if (to === MULTICALL3) {
      const members = decodeFunctionData({ abi: aggregate3, data: data as Hex }).args[0];
      const result = encodeFunctionResult({ abi: aggregate3, functionName: 'aggregate3', result: members.map((m) => { subcalls.push({ to: m.target.toLowerCase(), data: m.callData }); const v = answer(m.target.toLowerCase(), m.callData); return v === undefined ? { success: false, returnData: '0x' as Hex } : { success: true, returnData: v as Hex }; }) });
      return { jsonrpc: '2.0', id: request.id, result };
    }
    subcalls.push({ to, data }); const v = answer(to, data);
    return v === undefined ? { jsonrpc: '2.0', id: request.id, error: { code: 3, message: 'execution reverted' } } : { jsonrpc: '2.0', id: request.id, result: v };
  };
  const fetcher: typeof fetch = async (_url, init) => { const body = JSON.parse(String(init?.body)); return Response.json(Array.isArray(body) ? body.map(handle) : handle(body)); };
  return { client: new JsonClient('https://rpc.test', fetcher), subcalls };
}
const sel = (signature: string) => toFunctionSelector(signature);

describe('A2″ EvmReader.batchSettled', () => {
  it('returns a per-member outcome and never throws on one failed member; batch() stays strict', async () => {
    const { client } = mockRpc(8453, (to, data) => data.startsWith(sel('getReserves()')) && to === P82 ? undefined : data.startsWith(sel('token1()')) ? '0x1234' : word(7));
    const reader = new EvmReader(client, 'base', []);
    const calls = [{ to: P8, signature: 'getReserves()' }, { to: P82, signature: 'getReserves()' }, { to: P8, signature: 'token1()' }];
    const settled = await reader.batchSettled(calls, HEADER);
    expect(settled).toEqual([{ ok: true, words: [7n] }, { ok: false, reason: 'SUBCALL_REVERTED' }, { ok: false, reason: 'INVALID_RPC_DATA' }]);
    await expect(reader.batch(calls, HEADER)).rejects.toMatchObject({ code: 'INCOMPLETE_MULTICALL' });
    await expect(reader.batch([calls[0], calls[2]], HEADER)).rejects.toMatchObject({ code: 'INVALID_RPC_DATA' });
    expect(await reader.batch([calls[0]], HEADER)).toEqual([[7n]]);
  });
  it('one failed multicall member excludes only its own pool, with an explicit reason (fixture G3)', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const fixture = fixtureV8({ failMember: P82 + ':' + sel('getReserves()') });
    const engine = new ResearchEngine({ endpoints: { base: 'https://rpc.test' }, deployments: [], discoveryRegistry: fixture.registry, fetcher: fixture.fetcher });
    const result = await engine.discoverV3({ network: 'base', tokens: [A8] });
    const byAddress = (a: string) => result.pools.find((p) => p.reference.kind === 'evm_contract' && p.reference.address === a)!;
    expect(byAddress(P8)).toMatchObject({ liquidity_eligible: true, state: { block_hash: BLOCK8 } });
    expect(byAddress(P82).liquidity_eligible).toBe(false);
    expect(byAddress(P82).state).toBeUndefined();
    expect(byAddress(P82).eligibility_reasons).toEqual(expect.arrayContaining(['STATE_UNAVAILABLE', 'MULTICALL_MEMBER_FAILED']));
    // State, membership and decimals are batched across pools: one aggregate3 each, decimals read once per unique token.
    const outer = fixture.calls.filter((c) => c.method === 'eth_call' && (c.params[0] as { to: string }).to === MULTICALL3);
    expect(outer).toHaveLength(3);
    expect(fixture.calls.filter((c) => c.method === 'eth_call' && (c.params[0] as { data: string }).data.startsWith(sel('decimals()')))).toHaveLength(2);
    marker();
  });
  it('attributes a malformed whole-batch response to every pool it covered', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const fixture = fixtureV8({ fault: 'bad-batch' });
    const engine = new ResearchEngine({ endpoints: { base: 'https://rpc.test' }, deployments: [], discoveryRegistry: fixture.registry, fetcher: fixture.fetcher });
    const result = await engine.discoverV3({ network: 'base', tokens: [A8] });
    expect(result.pools.every((p) => !p.liquidity_eligible && p.eligibility_reasons.includes('INCOMPLETE_MULTICALL'))).toBe(true);
  });
});

// Verified on Arbitrum 2026-11-22 (cast): token0, token1, fee or tickSpacing read from each sample pool; derivation equals the real address.
const WETH = '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', USDC = '0xaf88d065e77c8cc2239327c5edb3a432268e5831', ARB = '0x912ce59144191c1204e64559fe8253a0e49e6548', LINK = '0xf97f4df75117a78c1a5a0dbb814af92458539fb4';
const samples: Record<string, { pool: string; token0: string; token1: string; param?: bigint }> = {
  'uniswap-v3': { pool: '0xc6962004f452be9203591991d15f6b388e09e8d0', token0: WETH, token1: USDC, param: 500n },
  'pancake-v3': { pool: '0x9ffca51d23ac7f7df82da414865ef1055e5afcc3', token0: ARB, token1: USDC, param: 500n },
  'slipstream-v1': { pool: '0xbdf6749254c8760b42f38b9985baaf1cecf17617', token0: WETH, token1: ARB, param: 100n },
  'algebra-v1': { pool: '0xe8795cf9c2309ecfe05df028eb0f21d5d6e3a951', token0: WETH, token1: LINK },
  'sushi-v2': { pool: '0x7050a8908e2a60899d8788015148241f0993a3fd', token0: WETH, token1: LINK },
};
const templates = z.array(deploymentSchema).parse(JSON.parse(readFileSync(new URL('../services/flashloan/registry/arbitrum.deployments.json', import.meta.url), 'utf8')));

describe("A5' CREATE2 derivation proof", () => {
  it('the reviewed Arbitrum factory templates parse under deploymentSchema and derive their sample pools', () => {
    expect(templates.map((t) => t.adapter_version).sort()).toEqual(Object.keys(samples).sort());
    for (const t of templates) {
      expect(t.network).toBe('arbitrum'); expect(t.address).toBe(t.factory);
      const s = samples[t.adapter_version!];
      const proof = verifyCreate2Derivation({ deployer: t.deployer!, init_code_hash: t.init_code_hash!, salt_kind: t.salt_kind! }, s.pool, s.token0, s.token1, s.param);
      expect(proof.matches, t.adapter_version).toBe(true);
      expect(proof.derived).toBe(s.pool);
    }
    // Any other parameter (fee tier, spacing, token order) is a different address.
    const uni = templates.find((t) => t.adapter_version === 'uniswap-v3')!, s = samples['uniswap-v3'];
    expect(verifyCreate2Derivation({ deployer: uni.deployer!, init_code_hash: uni.init_code_hash!, salt_kind: 'V3_FEE' }, s.pool, s.token0, s.token1, 3000n).matches).toBe(false);
    expect(verifyCreate2Derivation({ deployer: uni.deployer!, init_code_hash: uni.init_code_hash!, salt_kind: 'V3_FEE' }, s.pool, s.token1, s.token0, 500n).matches).toBe(false);
  });
  it('rejects a partial factory template', () => {
    const t = templates[0];
    expect(deploymentSchema.safeParse({ ...t, init_code_hash: undefined }).success).toBe(false);
    expect(deploymentSchema.safeParse({ ...t, factory_code_hash: undefined }).success).toBe(false);
    const { deployer: _d, init_code_hash: _i, salt_kind: _s, ...pinned } = t; void _d; void _i; void _s;
    expect(deploymentSchema.safeParse(pinned).success).toBe(true);
  });

  // Synthetic V3_FEE template on Base: deployer D, init hash H; the derived address is the only CREATE2-canonical pool.
  const D = '0x' + 'd'.repeat(40), H = '0x' + 'e'.repeat(64), FACTORY = '0x' + '9'.repeat(40);
  const template = deploymentSchema.parse({ network: 'base', address: FACTORY, adapter: 'UNISWAP_V3', factory: FACTORY, factory_code_hash: keccak256(CODE8), code_hash: keccak256(CODE8), version: 'uniswap-v3', adapter_version: 'uniswap-v3', deployer: D, init_code_hash: H, salt_kind: 'V3_FEE' });
  const canonical = verifyCreate2Derivation({ deployer: D, init_code_hash: H, salt_kind: 'V3_FEE' }, '0x' + '0'.repeat(40), A8, Q8, 500n).derived;
  const v3Answer = (registered: string, factory = FACTORY) => (to: string, data: string) => {
    const s = data.slice(0, 10);
    if (s === sel('token0()')) return word(A8); if (s === sel('token1()')) return word(Q8); if (s === sel('factory()')) return word(factory);
    if (s === sel('fee()')) return word(500); if (s === sel('getPool(address,address,uint24)') && to === FACTORY) return word(registered);
    return undefined;
  };
  it('accepts an unpinned pool only with factory membership AND CREATE2 match, returning the canonicality proof', async () => {
    const { client } = mockRpc(8453, v3Answer(canonical));
    const deployment = await new EvmReader(client, 'base', [template]).attest(canonical, 'UNISWAP_V3', HEADER);
    expect(deployment).toMatchObject({ address: canonical, version: 'uniswap-v3', canonicality: { kind: 'create2', chain_id: 8453, adapter_version: 'uniswap-v3', factory: FACTORY, deployer: D, init_code_hash: H, salt_kind: 'V3_FEE', salt_args: [A8, Q8, '500'] } });
    expect(deploymentSchema.safeParse(deployment).success).toBe(true);
  });
  it('adversarial: the factory registers the pool but CREATE2 does not derive it → discovery-only, never sized (fixture G4)', async () => {
    const impostor = '0x' + '3'.repeat(40);
    const { client } = mockRpc(8453, v3Answer(impostor));
    const reader = new EvmReader(client, 'base', [template]);
    await expect(reader.attest(impostor, 'UNISWAP_V3', HEADER)).rejects.toMatchObject({ code: 'CREATE2_MISMATCH' });
    await expect(reader.pool({ address: impostor, adapter: 'UNISWAP_V3', word_range: 0 }, HEADER)).rejects.toMatchObject({ code: 'CREATE2_MISMATCH' });
    // The same registry/fixture pool is still discoverable: discovery checks membership, sizing additionally needs the proof.
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const fixture = fixtureV8();
    const inventory = await new ResearchEngine({ endpoints: { base: 'https://rpc.test' }, deployments: [], discoveryRegistry: fixture.registry, fetcher: fixture.fetcher }).discoverV3({ network: 'base', tokens: [A8] });
    expect(inventory.pools.find((p) => p.reference.kind === 'evm_contract' && p.reference.address === P8)?.liquidity_eligible).toBe(true);
    const v2Template = deploymentSchema.parse({ network: 'base', address: F8, adapter: 'UNISWAP_V2', factory: F8, factory_code_hash: keccak256(CODE8), code_hash: keccak256(CODE8), version: 'uniswap-v2', fee_pips: 3000, deployer: F8, init_code_hash: H, salt_kind: 'V2_PACKED' });
    const sizing = new EvmReader(new JsonClient('https://rpc.test', fixture.fetcher), 'base', [v2Template]);
    await expect(sizing.attest(P8, 'UNISWAP_V2', HEADER)).rejects.toMatchObject({ code: 'CREATE2_MISMATCH' });
    marker();
  });
  it('rejects a CREATE2-derivable pool whose factory does not register it, and an unreviewed factory', async () => {
    const unregistered = mockRpc(8453, v3Answer('0x' + '0'.repeat(40)));
    await expect(new EvmReader(unregistered.client, 'base', [template]).attest(canonical, 'UNISWAP_V3', HEADER)).rejects.toMatchObject({ code: 'DEPLOYMENT_MISMATCH' });
    const foreign = mockRpc(8453, v3Answer(canonical, '0x' + '8'.repeat(40)));
    await expect(new EvmReader(foreign.client, 'base', [template]).attest(canonical, 'UNISWAP_V3', HEADER)).rejects.toMatchObject({ code: 'DEPLOYMENT_MISMATCH' });
    const none = mockRpc(8453, v3Answer(canonical));
    await expect(new EvmReader(none.client, 'base', []).attest(canonical, 'UNISWAP_V3', HEADER)).rejects.toMatchObject({ code: 'UNSUPPORTED_POOL_VERSION' });
  });
  it('the spacing-salted (Slipstream) sizing verifier looks pools up with getPool(address,address,int24) (finding #5)', async () => {
    const spacingTemplate = deploymentSchema.parse({ ...template, adapter: 'AERODROME_CLMM', version: 'slipstream-v1', adapter_version: 'slipstream-v1', salt_kind: 'SPACING' });
    const pool = verifyCreate2Derivation({ deployer: D, init_code_hash: H, salt_kind: 'SPACING' }, '0x' + '0'.repeat(40), A8, Q8, 100n).derived;
    const { client, subcalls } = mockRpc(8453, (to, data) => {
      const s = data.slice(0, 10);
      if (s === sel('token0()')) return word(A8); if (s === sel('token1()')) return word(Q8); if (s === sel('factory()')) return word(FACTORY);
      if (s === sel('tickSpacing()')) return word(100); if (s === sel('getPool(address,address,int24)') && to === FACTORY) return word(pool);
      return undefined;
    });
    const deployment = await new EvmReader(client, 'base', [spacingTemplate]).attest(pool, 'AERODROME_CLMM', HEADER);
    expect(deployment.canonicality).toMatchObject({ salt_kind: 'SPACING', salt_args: [A8, Q8, '100'] });
    expect(subcalls.some((c) => c.data.startsWith(sel('getPool(address,address,int24)')))).toBe(true);
    expect(subcalls.some((c) => c.data.startsWith(sel('getPool(address,address,uint24)')))).toBe(false);
  });
});

describe('capability matrix (file 11 §A)', () => {
  it('follows the table', () => {
    expect(quoteCapability('UNISWAP_V3', 'uniswap-v3')).toBe('exact');
    expect(quoteCapability('UNISWAP_V3', 'pancake-v3')).toBe('exact'); // live QuoterV2 parity below
    expect(quoteCapability('UNISWAP_V3', 'pancake-v3-unreviewed')).toBe('estimate');
    expect(quoteCapability('AERODROME_CLMM', 'slipstream-v1')).toBe('estimate'); // no Slipstream quoter parity yet
    expect(quoteCapability('ALGEBRA', 'algebra-v1')).toBe('estimate');
    expect(quoteCapability('UNISWAP_V2', 'sushi-v2')).toBe('exact');
    expect(quoteCapability('UNISWAP_V2', 'deltaswap', { dynamic_fee: true })).toBe('none');
    expect(quoteCapability('UNISWAP_V4', 'v4')).toBe('exact');
    expect(quoteCapability('UNISWAP_V4', 'v4', { hooked: true })).toBe('none');
    expect(quoteCapability('UNISWAP_V4', 'v4', { dynamic_fee: true })).toBe('none');
    expect(quoteCapability('AAVE_V3', 'v3')).toBe('none');
  });
  const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40);
  const v2 = (id: string, reserve1: string, adapter_version = 'fixture'): Pool => ({ kind: 'v2', address: '0x' + id.repeat(40), token0: A, token1: B, decimals0: 18, decimals1: 18, fee_pips: 3000, code_hash: 'fixture', adapter_version, reserve0: '1000000000', reserve1, stable: false });
  const lender = { capacity: '10000000', fee_numerator: '0', fee_denominator: '10000', address: 'lender' };
  const policy = riskPolicy.parse({ max_principal: '10000000', network_cost: '0', max_evaluations: 64 });
  it('sizing refuses discovery-only (none) pools and quotePool never prices them', () => {
    const dynamic = v2('1', '2000000000', 'deltaswap-dynamic');
    expect(poolQuoteCapability(dynamic)).toBe('none');
    expect(() => quotePool(dynamic, A, 1000n)).toThrow(expect.objectContaining({ code: 'QUOTE_UNSUPPORTED' }));
    expect(() => solve([dynamic, v2('2', '1000000000')], A, lender, policy)).toThrow(expect.objectContaining({ code: 'QUOTE_UNSUPPORTED' }));
  });
  it('marks estimate-tier results so callers label them INCONCLUSIVE; exact-only results are unchanged', () => {
    const exact = solve([v2('1', '2000000000'), v2('2', '1000000000')], A, lender, policy);
    expect(exact).not.toHaveProperty('quote_capability');
    const stable = { ...v2('3', '1000000000'), stable: true } as Pool;
    const labelled = { ...v2('4', '2000000000'), quote_capability: 'estimate' as const };
    const marked = solve([labelled, stable], A, lender, policy);
    expect(marked).toMatchObject({ quote_capability: 'estimate', estimate_pool_ids: [labelled.address, stable.address] });
  });
  it('exposes non-exact quote capability on inventory pools inside the existing strict schema', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const fixture = fixtureV8({ cl: 'ALGEBRA' });
    const result = await new ResearchEngine({ endpoints: { base: 'https://rpc.test' }, deployments: [], discoveryRegistry: fixture.registry, fetcher: fixture.fetcher }).discoverV3({ network: 'base', tokens: [A8] });
    expect(result.pools.every((p) => p.capabilities.quote.reason === 'QUOTE_ESTIMATE_ONLY')).toBe(true);
    const v3 = fixtureV8({ cl: 'V3' });
    const exact = await new ResearchEngine({ endpoints: { base: 'https://rpc.test' }, deployments: [], discoveryRegistry: v3.registry, fetcher: v3.fetcher }).discoverV3({ network: 'base', tokens: [A8] });
    expect(exact.pools.every((p) => p.capabilities.quote.reason === 'QUOTE_NOT_VERIFIED')).toBe(true);
  });
});

// Live: FLASHLOAN_LIVE=1. Pool state and the venue's QuoterV2 are read at one pinned block; results must be equal.
const live = process.env.FLASHLOAN_LIVE === '1';
const rpcUrl = process.env.FLASHLOAN_ARBITRUM_RPC ?? 'https://arb1.arbitrum.io/rpc';
describe.skipIf(!live)('Arbitrum factory templates and quote parity (live)', () => {
  const reader = () => new EvmReader(new JsonClient(rpcUrl, fetch, 20000), 'arbitrum', templates as Deployment[]);
  it('every template derives its sample pool through EvmReader.attest at a pinned block', async () => {
    const r = reader(), block = await r.header();
    for (const t of templates) {
      const s = samples[t.adapter_version!];
      const deployment = await r.attest(s.pool, t.adapter, block);
      expect(deployment.canonicality, t.adapter_version).toMatchObject({ chain_id: 42161, factory: t.factory, deployer: t.deployer, init_code_hash: t.init_code_hash });
    }
  }, 120_000);
  const venues = [
    { name: 'uniswap-v3', quoter: '0x61ffe014ba17989e743c5f6cb21bf9697530b21e', pools: ['0xc6962004f452be9203591991d15f6b388e09e8d0', '0xc6f780497a95e246eb9449f5e4770916dcd6396a'] },
    { name: 'pancake-v3', quoter: '0xb048bbc1ee6b733fffcfb9e9cef7375518e25997', pools: ['0x9ffca51d23ac7f7df82da414865ef1055e5afcc3', '0x7fcdc35463e3770c2fb992716cd070b63540b947'] },
  ];
  const unit: Record<string, bigint> = { [WETH]: 10n ** 15n, [USDC]: 10n ** 5n, [ARB]: 10n ** 17n };
  it.each(venues)('$name: quotePool equals QuoterV2 for 2 pools × 3 sizes × both directions at one block', async ({ name, quoter, pools }) => {
    const r = reader(), block = await r.header(); const deltas: string[] = []; let compared = 0;
    for (const address of pools) {
      const pool = await r.pool({ address, adapter: 'UNISWAP_V3', word_range: 10 }, block);
      expect(pool.canonicality?.adapter_version).toBe(name);
      for (const tokenIn of [pool.token0, pool.token1]) {
        const tokenOut = tokenIn === pool.token0 ? pool.token1 : pool.token0;
        for (const scale of [1n, 10n, 100n]) { // stays within the thinnest sample pool's loaded tick words
          const amount = unit[tokenIn] * scale;
          const local = quotePool(pool, tokenIn, amount).amount_out;
          const [onchain] = await r.call(quoter, 'quoteExactInputSingle((address,address,uint256,uint24,uint160))', [tokenIn, tokenOut, amount, BigInt(pool.fee_pips), 0n], block);
          compared++;
          if (local !== onchain) deltas.push(`${address} ${tokenIn}->${tokenOut} in=${amount} local=${local} quoter=${onchain}`);
        }
      }
    }
    console.log(JSON.stringify({ event: 'flashloan.quote_parity', venue: name, block: BigInt(block.number).toString(), compared, mismatches: deltas.length }));
    expect(compared).toBe(12);
    expect(deltas).toEqual([]);
  }, 180_000);
});
