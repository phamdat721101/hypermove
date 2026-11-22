// @vitest-environment node
// M5b seam evidence (marker FLARB_EDGE_02): chain-wide topic scans, emitter authentication, the persistent V4 Initialize index.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { z } from 'zod';
import { decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, keccak256, parseAbi, parseAbiParameters, toFunctionSelector, type Hex } from 'viem';
import { JsonClient, RoundBudget, boundedTopicLogs, type TopicLog } from '../src/lib/mcp/flashloan/transport';
import { EvmReader, deploymentSchema, emitterProofCache, verifyCreate2Derivation, type Header } from '../src/lib/mcp/flashloan/evm';
import { DiscoveryRegistry, discoveryRegistryConfigSchema } from '../src/lib/mcp/flashloan/discovery-registry';
import { canonicalPoolId, resolveInventory, resolveV4PoolKeys } from '../src/lib/mcp/flashloan/pool-resolution';
import { MemoryRepository, MemoryV4InitializeIndex, SHARED_OWNER } from '../src/lib/mcp/flashloan/storage';
import { ResearchEngine } from '../src/lib/mcp/flashloan/engine';
import { assetId, ZERO_ADDRESS } from '../src/lib/mcp/flashloan/integration-contracts';
import { hash } from '../src/lib/mcp/flashloan/contracts';
import { fixtureV8, A8, F8 } from './fixtures/flashloan-v8';

afterEach(() => { vi.unstubAllEnvs(); emitterProofCache.clear(); });
const marker = () => console.log(JSON.stringify({ event: 'flashloan.arb.edge', marker: 'FLARB_EDGE_02', passed: true }));
const budget = (maxRpcCalls = 500) => new RoundBudget({ maxRpcCalls, maxEvaluations: 0, deadlineMs: 30000 }, new AbortController().signal);
const H = (n: bigint | number) => '0x' + BigInt(n).toString(16).padStart(64, '0');
const header = (n: number): Header => ({ number: '0x' + n.toString(16), hash: H(n), parentHash: H(n - 1), timestamp: '0x1', gasLimit: '0x1', miner: ZERO_ADDRESS });
const SWAP = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const INIT = keccak256(new TextEncoder().encode('Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)'));
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';
const aggregate3 = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
const initializeAbi = parseAbi(['event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)']);

type Handler = (method: string, params: unknown[]) => unknown;
/** JSON-RPC fake: single and batch bodies; a handler may return `{ error }` to surface a JSON-RPC error. */
function fakeRpc(handler: Handler) {
  const calls: Array<{ method: string; params: unknown[] }> = [];
  const answer = (r: { id: number; method: string; params: unknown[] }) => { calls.push(r); const v = handler(r.method, r.params) as { error?: unknown }; return v && typeof v === 'object' && 'error' in v ? { jsonrpc: '2.0', id: r.id, error: v.error } : { jsonrpc: '2.0', id: r.id, result: v }; };
  const fetcher: typeof fetch = async (_url, init) => { const body = JSON.parse(String(init?.body)); return Response.json(Array.isArray(body) ? body.map(answer) : answer(body)); };
  return { fetcher, calls, count: (method: string) => calls.filter((c) => c.method === method).length };
}
const swapLog = (block: number, index = 0, over: Partial<TopicLog> = {}): TopicLog => ({ address: '0x' + 'ab'.repeat(20), topics: [SWAP], data: '0x', blockNumber: '0x' + block.toString(16), blockHash: H(block), transactionHash: H(block * 1000 + index), logIndex: '0x' + index.toString(16), ...over });
const range = (params: unknown[]) => { const f = params[0] as { fromBlock: string; toBlock: string }; return [Number(BigInt(f.fromBlock)), Number(BigInt(f.toBlock))]; };

describe('boundedTopicLogs: completeness ledger', () => {
  it('halves an oversized range down to pages the provider can return', async () => {
    const rpc = fakeRpc((method, params) => {
      if (method === 'eth_getBlockByNumber') return { hash: H(BigInt(params[0] as string)) };
      const [from, to] = range(params);
      if (to - from + 1 > 500) return Array(2001).fill(swapLog(from)); // over the 2,000-record budget
      return Array.from({ length: to - from + 1 }, (_, i) => from + i).filter((n) => n % 100 === 0).map((n) => swapLog(n));
    });
    const scan = await boundedTopicLogs(new JsonClient('https://rpc.test', rpc.fetcher), { topics: [[SWAP]], from: 0n, to: 1999n }, budget());
    expect(scan).toMatchObject({ requested_ranges: [{ from: '0', to: '1999' }], completed_ranges: [{ from: '0', to: '1999' }], failed_ranges: [], complete: true });
    expect(scan.logs.map((l) => Number(BigInt(l.blockNumber)))).toEqual(Array.from({ length: 20 }, (_, i) => i * 100));
    expect(rpc.calls.filter((c) => c.method === 'eth_getLogs').every((c) => { const [a, b] = range(c.params); return b >= a; })).toBe(true);
  });
  it('halves on a JSON-RPC range error surfaced as RPC_METHOD_FAILED (#23)', async () => {
    const rpc = fakeRpc((method, params) => {
      if (method === 'eth_getBlockByNumber') return { hash: H(BigInt(params[0] as string)) };
      const [from, to] = range(params);
      return to - from + 1 > 250 ? { error: { code: -32005, message: 'query returned more than 10000 results' } } : [swapLog(from)];
    });
    const scan = await boundedTopicLogs(new JsonClient('https://rpc.test', rpc.fetcher), { topics: [[SWAP]], from: 0n, to: 999n }, budget());
    expect(scan.complete).toBe(true); expect(scan.completed_ranges).toEqual([{ from: '0', to: '999' }]);
    expect(rpc.calls.filter((c) => c.method === 'eth_getLogs').some((c) => { const [a, b] = range(c.params); return b - a + 1 <= 250; })).toBe(true);
  });
  it('records a range that fails even at one block instead of dropping it', async () => {
    const rpc = fakeRpc((method, params) => {
      if (method === 'eth_getBlockByNumber') return { hash: H(BigInt(params[0] as string)) };
      const [from, to] = range(params);
      return from <= 777 && to >= 777 ? { error: { code: -32000 } } : [swapLog(from)];
    });
    const scan = await boundedTopicLogs(new JsonClient('https://rpc.test', rpc.fetcher), { topics: [[SWAP]], from: 0n, to: 1999n }, budget());
    expect(scan.failed_ranges).toEqual([{ from: '777', to: '777', reason: 'RPC_METHOD_FAILED' }]);
    expect(scan.completed_ranges).toEqual([{ from: '0', to: '776' }, { from: '778', to: '1999' }]);
    expect(scan.complete).toBe(false);
  });
  it('rejects a reorged-page log, drops removed logs and records the block as failed', async () => {
    const rpc = fakeRpc((method, params) => method === 'eth_getBlockByNumber' ? { hash: H(BigInt(params[0] as string)) }
      : [swapLog(10, 0, { blockHash: H(999999) }), swapLog(10, 1), swapLog(11, 0), swapLog(12, 0, { removed: true }), swapLog(13, 0, { topics: ['0x' + 'ee'.repeat(32)] })]);
    const scan = await boundedTopicLogs(new JsonClient('https://rpc.test', rpc.fetcher), { topics: [[SWAP]], from: 0n, to: 20n }, budget());
    expect(scan.logs.map((l) => l.blockNumber)).toEqual(['0xb']); // block 10 failed wholesale, 12 removed, 13 off-topic
    expect(scan.failed_ranges).toEqual([{ from: '10', to: '10', reason: 'BLOCK_REORG' }]);
    expect(scan.completed_ranges).toEqual([{ from: '0', to: '9' }, { from: '11', to: '20' }]);
  });
  it('fails the remainder once a provider refuses single blocks repeatedly instead of crawling the budget', async () => {
    let calls = 0;
    const refusing = new JsonClient('https://rpc.test', async () => { calls++; return new Response('archive gate', { status: 403 }); });
    const scan = await boundedTopicLogs(refusing, { topics: [[SWAP]], from: 0n, to: 1999n }, budget());
    expect(scan.failed_ranges).toEqual([{ from: '0', to: '1999', reason: 'RPC_REJECTED' }]); expect(scan.completed_ranges).toEqual([]);
    expect(calls).toBeLessThan(20);
  });
  it('records the remainder as failed when the round budget ends the scan', async () => {
    const rpc = fakeRpc((method, params) => method === 'eth_getBlockByNumber' ? { hash: H(BigInt(params[0] as string)) } : []);
    const scan = await boundedTopicLogs(new JsonClient('https://rpc.test', rpc.fetcher, 15000, budget(2)), { topics: [[SWAP]], from: 0n, to: 9999n }, budget());
    expect(scan.completed_ranges).toEqual([{ from: '0', to: '3999' }]);
    expect(scan.failed_ranges).toEqual([{ from: '4000', to: '9999', reason: 'RESOLUTION_BUDGET' }]);
  });
});

// Synthetic reviewed registry: one V3 factory template and one V4 PoolManager.
const CODE = '0x6000', CODE_HASH = keccak256(CODE);
const FACTORY = '0x' + 'f1'.repeat(20), DEPLOYER = '0x' + 'd1'.repeat(20), INIT_HASH = keccak256('0x1234'), MANAGER = '0x' + '44'.repeat(20), VIEW = '0x' + '45'.repeat(20);
const T0 = '0x' + '11'.repeat(20), T1 = '0x' + '22'.repeat(20);
const GENUINE = verifyCreate2Derivation({ deployer: DEPLOYER, init_code_hash: INIT_HASH, salt_kind: 'V3_FEE' }, ZERO_ADDRESS, T0, T1, 500n).derived;
const FORGED = '0x' + '55'.repeat(20), REGISTERED = '0x' + '33'.repeat(20), ROGUE = '0x' + '66'.repeat(20), EOA = '0x' + '77'.repeat(20);
const venues = new DiscoveryRegistry({ networks: { arbitrum: { venues: [
  { id: 'fixture-v3', provider_ids: [], family: 'V3', factory: FACTORY, factory_code_hash: CODE_HASH, pool_lookup: 'getPoolFee', quoter_kind: 'onchain_quoter', cpmm: true, status: 'reviewed' },
  { id: 'fixture-v4', provider_ids: [], family: 'V4', factory: MANAGER, factory_code_hash: CODE_HASH, state_view: VIEW, state_view_code_hash: CODE_HASH, quoter_kind: 'v4_state_quoter', cpmm: true, status: 'reviewed' },
] } } }).network('arbitrum').venues;
const templates = [deploymentSchema.parse({ network: 'arbitrum', address: FACTORY, adapter: 'UNISWAP_V3', factory: FACTORY, factory_code_hash: CODE_HASH, code_hash: CODE_HASH, version: 'fixture-v3', adapter_version: 'fixture-v3', deployer: DEPLOYER, init_code_hash: INIT_HASH, salt_kind: 'V3_FEE' })];
const word = (v: string | bigint) => encodeAbiParameters(parseAbiParameters('uint256'), [BigInt(v)]);
const pools: Record<string, { factory: string; fee: bigint }> = { [GENUINE]: { factory: FACTORY, fee: 500n }, [FORGED]: { factory: FACTORY, fee: 500n }, [REGISTERED]: { factory: FACTORY, fee: 3000n }, [ROGUE]: { factory: '0x' + '99'.repeat(20), fee: 500n } };
function poolAnswer(to: string, data: Hex): Hex | undefined {
  const selector = data.slice(0, 10), pool = pools[to];
  if (to === FACTORY && selector === toFunctionSelector('getPool(address,address,uint24)')) { const [, , fee] = decodeAbiParameters(parseAbiParameters('address,address,uint24'), ('0x' + data.slice(10)) as Hex); return word(fee === 500 ? GENUINE : fee === 3000 ? REGISTERED : ZERO_ADDRESS); }
  if (!pool) return undefined;
  return ({ [toFunctionSelector('token0()')]: word(T0), [toFunctionSelector('token1()')]: word(T1), [toFunctionSelector('factory()')]: word(pool.factory), [toFunctionSelector('fee()')]: word(pool.fee) } as Record<string, Hex>)[selector];
}
function authRpc() {
  return fakeRpc((method, params) => {
    if (method === 'eth_getCode') return CODE;
    if (method === 'eth_call' && (params[0] as { to: string }).to === MULTICALL3) {
      const members = decodeFunctionData({ abi: aggregate3, data: (params[0] as { data: Hex }).data }).args[0];
      return encodeFunctionResult({ abi: aggregate3, functionName: 'aggregate3', result: members.map((m) => { const v = poolAnswer(m.target.toLowerCase(), m.callData); return v ? { success: true, returnData: v } : { success: false, returnData: '0x' as Hex }; }) });
    }
    throw new Error('unexpected ' + method);
  });
}

describe('emitter authentication', () => {
  it('counts a Swap emitter only with a factory registration and CREATE2 proof; a forged token0/token1 emitter is rejected', async () => {
    const rpc = authRpc(), reader = new EvmReader(new JsonClient('https://rpc.test', rpc.fetcher), 'arbitrum', templates);
    const auth = await reader.authenticateEmitters([GENUINE, FORGED, REGISTERED, ROGUE, EOA, MANAGER, 'not-an-address'], header(100), venues);
    expect(auth.get(GENUINE)).toMatchObject({ ok: true, venue_id: 'fixture-v3', family: 'V3', proof: { kind: 'create2', factory: FACTORY, deployer: DEPLOYER, init_code_hash: INIT_HASH, salt_kind: 'V3_FEE' } });
    expect(auth.get(FORGED)).toEqual({ ok: false, reason: 'DEPLOYMENT_MISMATCH' }); // implements token0/token1/factory but the factory registers GENUINE
    expect(auth.get(REGISTERED)).toEqual({ ok: false, reason: 'CREATE2_MISMATCH' }); // registered but not the template's CREATE2 image
    expect(auth.get(ROGUE)).toEqual({ ok: false, reason: 'UNREVIEWED_FACTORY' });
    expect(auth.get(EOA)).toEqual({ ok: false, reason: 'NOT_A_POOL' });
    expect(auth.get(MANAGER)).toMatchObject({ ok: true, family: 'V4', proof: { kind: 'v4_manager' } });
    expect(auth.get('not-an-address')).toEqual({ ok: false, reason: 'INVALID_ADDRESS' });
    expect(rpc.count('eth_call')).toBe(2); // one batched state read + one batched membership read for all emitters
    // Process LRU: a new request re-reads only the rejected emitters; the proven pool and manager cost nothing.
    const again = authRpc(), next = new EvmReader(new JsonClient('https://rpc.test', again.fetcher), 'arbitrum', templates);
    expect((await next.authenticateEmitters([GENUINE, MANAGER], header(101), venues)).get(GENUINE)?.ok).toBe(true);
    expect(again.calls).toHaveLength(0);
    expect(emitterProofCache.size).toBe(2);
  });
});

// V4 Initialize index.
const KEY = { currency0: T0, currency1: T1, fee: 3000, tickSpacing: 60, hooks: ZERO_ADDRESS };
const POOL_ID = canonicalPoolId(KEY);
const initLog = (k: typeof KEY, block: number, emitter = MANAGER) => ({ address: emitter, topics: encodeEventTopics({ abi: initializeAbi, eventName: 'Initialize', args: { id: canonicalPoolId(k) as Hex, currency0: k.currency0 as Hex, currency1: k.currency1 as Hex } }), data: encodeAbiParameters(parseAbiParameters('uint24,int24,address,uint160,int24'), [k.fee, k.tickSpacing, k.hooks as Hex, 1n << 96n, 0]), blockNumber: '0x' + block.toString(16), blockHash: H(block), transactionHash: H(block + 7), logIndex: '0x2' });
function indexRpc(logs: () => unknown[]) {
  return fakeRpc((method, params) => {
    if (method === 'eth_getBlockByNumber') return { hash: H(BigInt(params[0] as string)) };
    if (method === 'eth_getLogs') { const f = params[0] as { topics: unknown[]; fromBlock: string; toBlock: string }; expect(f).not.toHaveProperty('address'); return logs().filter((l) => { const n = BigInt((l as { blockNumber: string }).blockNumber); return n >= BigInt(f.fromBlock) && n <= BigInt(f.toBlock); }); }
    throw new Error('unexpected ' + method);
  });
}

describe('persistent V4 Initialize index', () => {
  it('round-trips a poolId to its PoolKey and an index hit avoids a rescan', async () => {
    const other = { ...KEY, fee: 500 }, foreign = { ...KEY, fee: 100 };
    const rpc = indexRpc(() => [initLog(KEY, 9500), initLog(other, 9600), initLog(foreign, 9700, '0x' + '88'.repeat(20))]), index = new MemoryV4InitializeIndex();
    const ctx = () => ({ rpc: new JsonClient('https://rpc.test', rpc.fetcher), index, budget: budget(), start: 9000n });
    const first = await resolveV4PoolKeys(ctx(), 42161, MANAGER, [POOL_ID, canonicalPoolId(foreign)], header(10000));
    const entry = first.get(POOL_ID);
    expect(entry).toMatchObject({ ok: true, entry: { chain_id: 42161, manager: MANAGER, pool_id: POOL_ID, ...KEY, block_number: '9500', block_hash: H(9500), log_index: 2 } });
    const { currency0, currency1, fee, tickSpacing, hooks } = (entry as { entry: typeof KEY }).entry;
    expect(canonicalPoolId({ currency0, currency1, fee, tickSpacing, hooks })).toBe(POOL_ID);
    expect(first.get(canonicalPoolId(foreign))).toMatchObject({ ok: false, code: 'UNRESOLVED_POOL_KEY' }); // another emitter's Initialize never counts
    expect(await index.cursor(42161, MANAGER)).toEqual({ from: '9000', to: '10000' });
    const scans = rpc.count('eth_getLogs'); expect(scans).toBe(1);
    // Second request: the other pool was indexed by the same fill; both hit without a getLogs call (one batched header check).
    const second = await resolveV4PoolKeys(ctx(), 42161, MANAGER, [POOL_ID, canonicalPoolId(other)], header(10000));
    expect([...second.values()].every((r) => r.ok)).toBe(true);
    expect(rpc.count('eth_getLogs')).toBe(scans);
    marker();
  });
  it('drops a non-canonical index entry, rewinds the cursor and refills from canonical logs', async () => {
    const rpc = indexRpc(() => [initLog(KEY, 9500)]), index = new MemoryV4InitializeIndex();
    await index.put([{ chain_id: 42161, manager: MANAGER, pool_id: POOL_ID, ...KEY, fee: 3000, block_number: '9500', block_hash: H(1), tx_hash: H(2), log_index: 0 }]);
    await index.advance(42161, MANAGER, { from: '9000', to: '10000' });
    const result = await resolveV4PoolKeys({ rpc: new JsonClient('https://rpc.test', rpc.fetcher), index, budget: budget(), start: 9000n }, 42161, MANAGER, [POOL_ID], header(10000));
    expect(result.get(POOL_ID)).toMatchObject({ ok: true, entry: { block_hash: H(9500) } });
    expect(rpc.count('eth_getLogs')).toBe(1);
  });
  it('requires a scan start or locator and reports conflicts explicitly', async () => {
    const index = new MemoryV4InitializeIndex(), none = indexRpc(() => []);
    expect((await resolveV4PoolKeys({ rpc: new JsonClient('https://rpc.test', none.fetcher), index, budget: budget() }, 42161, MANAGER, [POOL_ID], header(10))).get(POOL_ID)).toMatchObject({ ok: false, code: 'ARCHIVE_UNAVAILABLE' });
    const twice = indexRpc(() => [initLog(KEY, 5), { ...initLog(KEY, 6), logIndex: '0x3' }]);
    expect((await resolveV4PoolKeys({ rpc: new JsonClient('https://rpc.test', twice.fetcher), index, budget: budget(), start: 0n }, 42161, MANAGER, [POOL_ID], header(10))).get(POOL_ID)).toMatchObject({ ok: false, code: 'CONFLICTING_INITIALIZATION' });
  });
  it('pool-resolution uses the index when configured: same identity, no rescan on the next round', async () => {
    const block = { number: '0x1', hash: H(1), parentHash: H(0), timestamp: '0x1', gasLimit: '0x1', miner: T0 };
    const rpc = fakeRpc((method, params) => {
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_getCode') return CODE;
      if (method === 'eth_getLogs') return [{ ...initLog(KEY, 1), blockHash: H(1) }];
      if (method === 'eth_call') return (params[0] as { to: string }).to === VIEW ? encodeAbiParameters(parseAbiParameters('uint160,int24,uint24,uint24'), [1n << 96n, 0, 0, KEY.fee]) : word(18n);
      return block;
    });
    const deployment = { network: 'base' as const, address: MANAGER, adapter: 'UNISWAP_V4' as const, code_hash: CODE_HASH, version: 'reviewed-fixture', state_view: VIEW, state_view_code_hash: CODE_HASH, initialization_block: '1' };
    const index = new MemoryV4InitializeIndex(), chain = 'eip155:8453';
    const run = async () => { const b = new RoundBudget({ maxRpcCalls: 100, maxEvaluations: 0, deadlineMs: 30000 }, new AbortController().signal); const engine = new ResearchEngine({ endpoints: { base: 'https://rpc.test' }, deployments: [deployment], fetcher: rpc.fetcher, budget: b, initializeIndex: index }); return resolveInventory(engine, chain, 'round', [{ provider: 'fixture', providerPoolId: POOL_ID, assetIds: [assetId(chain, T0), assetId(chain, T1)] }], null, null, b, 4); };
    const first = await run();
    expect(first.unresolved).toEqual([]); expect(first.resolved[0]).toMatchObject({ manager: MANAGER, poolId: POOL_ID, key: KEY, initializationRef: { locator: 'index:initialize/' + H(8) + '/0x2' } });
    const scans = rpc.count('eth_getLogs'); expect(scans).toBe(1);
    const second = await run(); expect(second.resolved[0].key).toEqual(KEY); expect(rpc.count('eth_getLogs')).toBe(scans);
  });
  it('inventory-v3 uses the same index: V4 identity resolves and the next round does not rescan', async () => {
    const fixture = fixtureV8({ v4: true }), index = new MemoryV4InitializeIndex();
    // The v8 fixture answers Initialize logs only for the manager's address filter; a topic scan has no address, so map it.
    const fetcher: typeof fetch = async (url, init) => {
      const body = JSON.parse(String(init?.body ?? 'null'));
      if (body && !Array.isArray(body) && body.method === 'eth_getLogs' && !body.params[0].address) body.params[0] = { ...body.params[0], address: F8 };
      return fixture.fetcher(url, body ? { ...init, body: JSON.stringify(body) } : init);
    };
    const engine = new ResearchEngine({ endpoints: { base: 'https://rpc.test' }, deployments: [], discoveryRegistry: fixture.registry, fetcher, initializeIndex: index });
    const first = await engine.discoverV3({ network: 'base', tokens: [A8], min_liquidity_usd: 5000 });
    expect(first.pools[0].reference).toMatchObject({ kind: 'evm_v4', poolId: fixture.poolId }); expect(first.pools[0].pool_key).toEqual(fixture.key);
    const logs = () => fixture.calls.filter((c) => c.method === 'eth_getLogs').length, scans = logs(); expect(scans).toBe(1);
    const second = await engine.discoverV3({ network: 'base', tokens: [A8], min_liquidity_usd: 5000 });
    expect(second.pools[0].pool_key).toEqual(fixture.key); expect(logs()).toBe(scans);
  });
});

describe('owner guard', () => {
  it('rejects reserved @ owners on private enqueue/put/get/cancel while shared paths keep working', async () => {
    const repo = new MemoryRepository();
    await expect(repo.enqueue(SHARED_OWNER, 'flashloan_research_job', { idempotency_key: 'x' })).rejects.toMatchObject({ code: 'INVALID_OWNER' });
    await expect(repo.put('@anything', 'report', {})).rejects.toMatchObject({ code: 'INVALID_OWNER' });
    const shared = await repo.enqueueShared('flashloan_research_job', { operation: 'capabilities' }, hash('k'));
    await expect(repo.get(SHARED_OWNER, shared.id)).rejects.toMatchObject({ code: 'INVALID_OWNER' });
    await expect(repo.cancel(SHARED_OWNER, shared.id)).rejects.toMatchObject({ code: 'INVALID_OWNER' });
    expect((await repo.claim())!.owner).toBe(SHARED_OWNER);
    const own = await repo.enqueue('alice', 'flashloan_research_job', { idempotency_key: 'y' }); expect((await repo.get('alice', own.id)).id).toBe(own.id);
  });
});

describe.skipIf(process.env.FLASHLOAN_POSTGRES !== '1')('Postgres V4 Initialize index', () => {
  it('stores entries under the (chain_id, manager, pool_id) key, tracks the cursor and invalidates on reorg', async () => {
    const root = await mkdtemp(join(tmpdir(), 'flashloan-idx-')); const data = join(root, 'database');
    const binaries = process.env.FLASHLOAN_POSTGRES_BIN ?? '/usr/local/opt/postgresql@15/bin';
    const execute = (binary: string, args: string[]) => { const r = spawnSync(join(binaries, binary), args, { encoding: 'utf8', timeout: 30000 }); if (r.status !== 0) throw Error(`Local ${binary} failed: ${r.stderr.slice(-2000)}`); };
    const reservation = createServer(); await new Promise<void>((done, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', done); }); const port = (reservation.address() as { port: number }).port; await new Promise<void>((done) => reservation.close(() => done()));
    let started = false;
    try {
      execute('initdb', ['-D', data, '-A', 'trust', '-U', 'flashloan', '--no-locale']);
      execute('pg_ctl', ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -k ${root}`, '-w', 'start']); started = true;
      vi.stubEnv('DATABASE_URL', `postgresql://flashloan@127.0.0.1:${port}/postgres`);
      const { PostgresV4InitializeIndex, PostgresRepository } = await import('../src/lib/mcp/flashloan/storage');
      const index = new PostgresV4InitializeIndex(), entry = { chain_id: 42161, manager: MANAGER, pool_id: POOL_ID, ...KEY, block_number: '9500', block_hash: H(9500), tx_hash: H(1), log_index: 2 };
      await index.put([entry, { ...entry, block_hash: H(9500) }]);
      expect((await index.get(42161, MANAGER, [POOL_ID, H(5)])).get(POOL_ID)).toEqual(entry);
      expect((await index.get(8453, MANAGER, [POOL_ID])).size).toBe(0);
      await index.advance(42161, MANAGER, { from: '9000', to: '10000' }); expect(await index.cursor(42161, MANAGER)).toEqual({ from: '9000', to: '10000' });
      await index.invalidate(42161, MANAGER, [POOL_ID], 9500n);
      expect((await index.get(42161, MANAGER, [POOL_ID])).size).toBe(0); expect(await index.cursor(42161, MANAGER)).toEqual({ from: '9000', to: '9499' });
      // Resolver over Postgres: fill, then a hit without rescanning.
      const rpc = indexRpc(() => [initLog(KEY, 9500)]);
      const ctx = () => ({ rpc: new JsonClient('https://rpc.test', rpc.fetcher), index, budget: budget(), start: 9000n });
      expect((await resolveV4PoolKeys(ctx(), 42161, MANAGER, [POOL_ID], header(10000))).get(POOL_ID)).toMatchObject({ ok: true });
      const scans = rpc.count('eth_getLogs'); await resolveV4PoolKeys(ctx(), 42161, MANAGER, [POOL_ID], header(10000)); expect(rpc.count('eth_getLogs')).toBe(scans);
      await expect(new PostgresRepository(join(root, 'artifacts')).put(SHARED_OWNER, 'report', {})).rejects.toMatchObject({ code: 'INVALID_OWNER' });
    } finally { const { closeResearchPool } = await import('../src/lib/db'); await closeResearchPool(); if (started) execute('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  }, 60000);
});

describe.skipIf(process.env.FLASHLOAN_LIVE !== '1')('live Arbitrum swap-emitter authentication', () => {
  it('scans ~2,000 recent blocks for V3/Pancake/V2/V4 Swap topics and authenticates the emitters', async () => {
    const topics = { v3: SWAP, pancake: '0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83', v2: '0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822', v4: keccak256(new TextEncoder().encode('Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)')) };
    const url = process.env.FLASHLOAN_ARBITRUM_RPC_URL ?? 'https://arb1.arbitrum.io/rpc';
    const b = new RoundBudget({ maxRpcCalls: 600, maxEvaluations: 0, deadlineMs: 170000 }, new AbortController().signal), rpc = new JsonClient(url, fetch, 20000, b);
    const reader = new EvmReader(rpc, 'arbitrum', z.array(deploymentSchema).parse(JSON.parse(readFileSync(new URL('../services/flashloan/registry/arbitrum.deployments.json', import.meta.url), 'utf8'))));
    const registry = discoveryRegistryConfigSchema.parse({ networks: { arbitrum: JSON.parse(readFileSync(new URL('../services/flashloan/registry/arbitrum.reviewed.json', import.meta.url), 'utf8')) } });
    const head = await reader.header(b.signal), to = BigInt(head.number);
    const scan = await boundedTopicLogs(rpc, { topics: [Object.values(topics)], from: to - 1999n, to }, b);
    const emitters = [...new Set(scan.logs.map((l) => l.address.toLowerCase()))];
    const auth = await reader.authenticateEmitters(emitters, head, registry.networks.arbitrum!.venues);
    const byTopic = Object.fromEntries(Object.entries(topics).map(([name, topic]) => { const logs = scan.logs.filter((l) => l.topics[0] === topic); return [name, { logs: logs.length, authenticated_logs: logs.filter((l) => auth.get(l.address.toLowerCase())?.ok).length }]; }));
    const reasons: Record<string, number> = {}; for (const r of auth.values()) if (!r.ok) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
    const venuesSeen: Record<string, number> = {}; for (const r of auth.values()) if (r.ok) venuesSeen[r.venue_id] = (venuesSeen[r.venue_id] ?? 0) + 1;
    console.log(JSON.stringify({ event: 'flashloan.arb.live_emitters', block: to.toString(), completed: scan.completed_ranges, failed: scan.failed_ranges, logs: scan.logs.length, emitters: emitters.length, authenticated: [...auth.values()].filter((r) => r.ok).length, unauthenticated: [...auth.values()].filter((r) => !r.ok).length, by_topic: byTopic, venues: venuesSeen, reasons, rpc_calls: b.rpcCallsUsed }));
    expect(scan.logs.length).toBeGreaterThan(0);
    expect([...auth.values()].some((r) => r.ok)).toBe(true);
  }, 180000);
});
