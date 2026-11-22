// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, toFunctionSelector, encodeAbiParameters, encodeEventTopics, keccak256, parseAbi, parseAbiParameters, type Hex } from 'viem';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { solve } from '../src/lib/mcp/flashloan/math';
import { riskPolicy } from '../src/lib/mcp/flashloan/contracts';
import { ResearchEngine, computeInline } from '../src/lib/mcp/flashloan/engine';
import { PublicResearch } from '../src/lib/mcp/flashloan/public-worker';
import { ResearchAdmission } from '../src/lib/mcp/flashloan/admission';
import { hash } from '../src/lib/mcp/flashloan/contracts';
import { strictJson, RoundBudget, JsonClient } from '../src/lib/mcp/flashloan/transport';
import { canonicalPoolId, managerMapping, resolveInventory } from '../src/lib/mcp/flashloan/pool-resolution';
import { candidateRequestV2Schema, validateIntegration, evidence, assetId, ZERO_ADDRESS, type CandidateRequestV2 } from '../src/lib/mcp/flashloan/integration-contracts';
import { publicOperationEnabled } from '../src/lib/mcp/flashloan/public-contracts';
import { researchCandidatesV2 } from '../src/lib/mcp/flashloan/candidate-v2';
import { connectedPools } from '../src/lib/mcp/flashloan/candidate-v2';
import { ResearchWorker } from '../src/lib/mcp/flashloan/worker';
import { publicMcpHandler } from '../src/lib/mcp/flashloan/public-mcp';
import { createResearchServer } from '../services/flashloan/server';
import type { Repository } from '../src/lib/mcp/flashloan/storage';
import captured from './fixtures/flashloan-v7-provider-references.json';

const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), M = '0x' + '3'.repeat(40), V = '0x' + '4'.repeat(40), L = '0x' + '9'.repeat(40);
const block = { number: '0x1', hash: '0x' + 'a'.repeat(64), parentHash: '0x' + 'b'.repeat(64), timestamp: '0x1', gasLimit: '0x1c9c380', miner: A };
const chain = 'eip155:8453', code = '0x6000' as Hex;
const limits = { maxRpcCalls: 100, maxEvaluations: 500, maxPools: 4, maxRoutes: 3, deadlineMs: 30000, watchDurationMs: 0 };
const key = { currency0: A, currency1: B, fee: 3000, tickSpacing: 60, hooks: ZERO_ADDRESS };
const deployment = { network: 'base' as const, address: M, adapter: 'UNISWAP_V4' as const, code_hash: keccak256(code), version: 'reviewed-fixture', state_view: V, state_view_code_hash: keccak256(code), initialization_block: '1' };
function budget(overrides = {}) { return new RoundBudget({ ...limits, ...overrides }, new AbortController().signal); }
function initialization(k = key) {
  const abi = parseAbi(['event Initialize(bytes32 indexed id,address indexed currency0,address indexed currency1,uint24 fee,int24 tickSpacing,address hooks,uint160 sqrtPriceX96,int24 tick)']);
  return { address: M, topics: encodeEventTopics({ abi, eventName: 'Initialize', args: { id: canonicalPoolId(k), currency0: k.currency0 as Hex, currency1: k.currency1 as Hex } }), data: encodeAbiParameters(parseAbiParameters('uint24,int24,address,uint160,int24'), [k.fee, k.tickSpacing, k.hooks as Hex, 1n << 96n, 0]), blockNumber: block.number, blockHash: block.hash, transactionHash: '0x' + 'c'.repeat(64), logIndex: '0x0' };
}
function rpcEngine(k = key, mutate: (method: string, value: unknown) => unknown = (_method, value) => value) {
  const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => {
    const request = JSON.parse(String(options?.body));
    const value = request.method === 'eth_chainId' ? '0x2105' : request.method === 'eth_getCode' ? code : request.method === 'eth_getLogs' ? [initialization(k)] : request.method === 'eth_call' ? request.params[0].to === V ? encodeAbiParameters(parseAbiParameters('uint160,int24,uint24,uint24'), [1n << 96n, 0, 0, k.fee]) : encodeAbiParameters(parseAbiParameters('uint256'), [18n]) : block;
    return Response.json({ jsonrpc: '2.0', id: request.id, result: mutate(request.method, value) });
  });
  const b = budget();
  return { engine: new ResearchEngine({ endpoints: { base: 'https://fixture.test' }, deployments: [deployment], fetcher, budget: b }), b, fetcher };
}
function pool(id: string, reserve1: string) { return { kind: 'v2' as const, address: '0x' + id.repeat(40), token0: A, token1: B, decimals0: 18, decimals1: 18, fee_pips: 3000, code_hash: 'fixture', adapter_version: 'fixture', reserve0: '1000000', reserve1, stable: false }; }
const snapshot = { network: 'base' as const, chain_id: 8453, block, pools: [pool('5', '2000000'), pool('6', '1000000')], lender: { provider: 'AAVE_V3', address: L, asset: A, capacity: '100000', fee_numerator: '9', fee_denominator: '10000', code_hash: 'fixture' }, coverage: [], warnings: ['unsigned fixture'] };
function runtime() {
  const engine = new ResearchEngine({ endpoints: { base: 'https://fixture.test' }, deployments: [], fetcher: vi.fn(async () => Response.json({ result: block })) });
  return { engine, worker: new PublicResearch(engine, new ResearchAdmission(), 'k'.repeat(48), async (task) => computeInline(task)) };
}
function input(worker: PublicResearch): CandidateRequestV2 {
  const ref = evidence('source', { fixture: true }, 'fixture:costs', 'round');
  return { schema: 'flash-candidate-request/2', roundId: 'round', chainId: chain, mode: 'research', selection: { movers: false, explicitAssets: [assetId(chain, B)], minReportedLiquidityUsd: '10000', maxCandidates: 1 }, fundingAnchor: assetId(chain, A), profileResearchPolicy: { repaymentAssetId: assetId(chain, A), principalCapRaw: '1000', minNetProfitRaw: '0', comparison: 'gt', maxPriceImpactBps: 5000, maxRoutes: 3 }, costEvidence: { schema: 'route-cost/1', repaymentAssetId: assetId(chain, A), state: { chainId: chain, blockNumber: '1', blockHash: block.hash, parentHash: block.parentHash, observedAt: new Date().toISOString(), finality: 'latest', stateDigest: 'sha256:' + hash(snapshot) }, networkNativeUpperRaw: '1', networkCostUpperRaw: '1', otherCostUpperRaw: '1', gasReservationNativeRaw: '2', valuationRefs: [ref], feeEvidenceRef: ref, expiresAt: new Date(Date.now() + 60000).toISOString() }, snapshot: worker.proofs.sign('evm_snapshot', snapshot), managerMappingRef: null, limits };
}
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('v7 identity seam', () => {
  it('retains all 23 captured opaque references when the server has no reviewed mapping', async () => {
    const fetcher = vi.fn(); const b = budget();
    const engine = new ResearchEngine({ endpoints: { robinhood: 'https://fixture.test' }, deployments: [], fetcher, budget: b });
    const report = await resolveInventory(engine, 'eip155:4663', 'captured', captured.references, null, null, b, 4);
    expect(report.unresolved).toHaveLength(23); expect(report.resolved).toHaveLength(0);
    expect(report.unresolved.every((r) => r.reasonCode === 'MANAGER_MAPPING_REQUIRED')).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
    console.log(JSON.stringify({ event: 'flashloan.v7.edge', edge: 'EDGE-01', passed: true }));
  });
  it('resolves canonical event identity with provenance', async () => {
    const { engine, b } = rpcEngine();
    const report = await resolveInventory(engine, chain, 'round', [{ provider: 'fixture', providerPoolId: canonicalPoolId(key), assetIds: [assetId(chain, A), assetId(chain, B)] }], managerMapping(engine, chain, 'round'), null, b, 4);
    expect(report.unresolved).toEqual([]); expect(report.resolved[0]).toMatchObject({ manager: M, poolId: canonicalPoolId(key), key, support: { read: true, quote: true, execute: false } });
    expect(canonicalPoolId({ ...key, fee: 500 })).not.toBe(report.resolved[0].poolId);
    expect(report.rpcCallsUsed).toBeGreaterThan(0);
  });
  it('keeps two canonical pools sharing one manager distinct', async () => {
    const { engine, b } = rpcEngine(), other = { ...key, fee: 500 };
    const fetcher = engine.options.fetcher!;
    const adapted = new ResearchEngine({ ...engine.options, fetcher: async (url, options) => {
      const request = JSON.parse(String(options?.body));
      if (request.method === 'eth_getLogs') return Response.json({ result: [initialization(request.params[0].topics[1] === canonicalPoolId(other) ? other : key)] });
      if (request.method === 'eth_call' && request.params[0].to === V && request.params[0].data.includes(canonicalPoolId(other).slice(2))) return Response.json({ result: encodeAbiParameters(parseAbiParameters('uint160,int24,uint24,uint24'), [1n << 96n, 0, 0, other.fee]) });
      return fetcher(url, options);
    } });
    const report = await resolveInventory(adapted, chain, 'two-pools', [key, other].map((k) => ({ provider: 'fixture', providerPoolId: canonicalPoolId(k), assetIds: [assetId(chain, A), assetId(chain, B)] })), null, null, b, 4);
    expect(report.resolved).toHaveLength(2); expect(new Set(report.resolved.map((p) => p.manager)).size).toBe(1);
    expect(new Set(report.resolved.map((p) => p.poolId)).size).toBe(2);
  });
  it('merges provider aliases before applying the new-pool capacity limit', async () => {
    const { engine, b } = rpcEngine();
    const report = await resolveInventory(engine, chain, 'aliases', ['one', 'two'].map((provider) => ({ provider, providerPoolId: canonicalPoolId(key), assetIds: [assetId(chain, A), assetId(chain, B)] })), null, null, b, 1);
    expect(report.unresolved).toEqual([]); expect(report.resolved).toHaveLength(1);
    expect(report.resolved[0].sourceRefs).toHaveLength(2);
  });
  it('invalidates all resolved state when a reorg occurs during the last metadata read', async () => {
    let changed = false;
    const { engine, b } = rpcEngine(key, (method, value) => {
      if (method === 'eth_call' && value === encodeAbiParameters(parseAbiParameters('uint256'), [18n])) changed = true;
      return changed && method === 'eth_getBlockByNumber' ? { ...block, hash: '0x' + 'd'.repeat(64) } : value;
    });
    const report = await resolveInventory(engine, chain, 'reorg-at-export', [{ provider: 'fixture', providerPoolId: canonicalPoolId(key), assetIds: [assetId(chain, A), assetId(chain, B)] }], null, null, b, 4);
    expect(report.resolved).toEqual([]); expect(report.unresolved[0].reasonCode).toBe('BLOCK_REORG');
  });
  it.each(['currency', 'code', 'reorg', 'conflict', 'chain', 'mapping', 'budget'] as const)('rejects %s identity evidence', async (fault) => {
    const { engine, b } = rpcEngine(key, (method, value) => fault === 'code' && method === 'eth_getCode' ? '0x6001' : fault === 'reorg' && method === 'eth_getBlockByNumber' ? { ...block, hash: '0x' + 'd'.repeat(64) } : fault === 'conflict' && method === 'eth_getLogs' ? [initialization(), initialization()] : fault === 'chain' && method === 'eth_chainId' ? '0x1' : value);
    if (fault === 'budget') b.rpcCallsUsed = 100;
    const mapping = managerMapping(engine, chain, 'round');
    if (fault === 'mapping') mapping.contentHash = 'sha256:' + '0'.repeat(64);
    const report = await resolveInventory(engine, chain, 'round', [{ provider: 'fixture', providerPoolId: canonicalPoolId(key), assetIds: [assetId(chain, fault === 'currency' ? L : A), assetId(chain, B)] }], mapping, fault === 'reorg' ? '1' : null, b, 4);
    // For a reorg the pinned event's original hash differs from the canonical RPC header.
    expect(report.resolved).toHaveLength(0); expect(report.unresolved).toHaveLength(1);
  });
  it('preserves native identity and reports unsupported hooks separately from read support', async () => {
    const k = { ...key, currency0: ZERO_ADDRESS, hooks: L };
    const { engine, b } = rpcEngine(k);
    const report = await resolveInventory(engine, chain, 'native', [{ provider: 'fixture', providerPoolId: canonicalPoolId(k), assetIds: [assetId(chain, ZERO_ADDRESS), assetId(chain, B)] }], null, null, b, 4);
    expect(report.resolved[0]).toMatchObject({ asset0: { kind: 'native', address: null, assetId: chain + '/slip44:60' }, support: { read: true, quote: false, execute: false } });
  });
});

describe('v7 economic and budget seams', () => {
  it('reserves funding connectors before disconnected pools consume the pool limit', () => {
    const pools = [{ id: '0', assets: ['x', 'y'], value: 'disconnected' }, { id: '1', assets: ['target', 'hub'], value: 'target-edge' }, { id: '2', assets: ['hub', 'anchor'], value: 'funding-connector' }];
    expect(connectedPools(pools, 'anchor', ['target'], 2)).toEqual(['funding-connector', 'target-edge']);
    expect(connectedPools(pools, 'anchor', ['target'], 1)).toEqual([]);
    expect(connectedPools([{ id: '1', assets: ['anchor', 'target'], value: 'direct' }, { id: '2', assets: ['anchor', 'hub'], value: 'via-hub' }, { id: '3', assets: ['hub', 'target'], value: 'hub-target' }], 'anchor', ['target'], 3)).toEqual(['direct', 'via-hub', 'hub-target']);
    expect(() => connectedPools(Array.from({ length: 257 }, (_, i) => ({ id: String(i), assets: ['anchor', String(i)], value: i })), 'anchor', ['missing'], 4)).toThrow(/metadata domain/);
  });
  it('caps plan lifetime at the earliest supporting evidence expiry', async () => {
    const { engine, worker } = runtime(), request = input(worker);
    request.costEvidence!.valuationRefs[0] = { ...request.costEvidence!.valuationRefs[0], expiresAt: new Date(Date.now() + 20000).toISOString() };
    const result = await researchCandidatesV2(engine, request, worker.proofs, async (t) => computeInline(t), budget()) as any;
    expect(result.researchPlans.length).toBeGreaterThan(0);
    expect(result.researchPlans.every((p: any) => Date.parse(p.expires_at) <= Date.parse(request.costEvidence!.valuationRefs[0].expiresAt!))).toBe(true);
  });
  it('reports coarse-grid truncation even when no plan qualified for refinement', () => {
    const result = solve(snapshot.pools, A, snapshot.lender, riskPolicy.parse({ max_principal: '1000', min_profit: '99999999', max_evaluations: 8, network_cost: '0' }), { targets: [B], deadline_ms: 5000, refine: true });
    expect(result.evaluations).toBe(6); expect(result.search.termination).toBe('EVALUATION_BUDGET'); expect(result.status).toBe('INCONCLUSIVE');
  });
  it('aborts retry waits at the caller deadline', async () => {
    const b = budget({ deadlineMs: 10 });
    const fetcher = vi.fn(async () => new Response('', { status: 503, headers: { 'retry-after': '1' } }));
    const started = performance.now();
    await expect(new JsonClient('https://fixture.test', fetcher, 15000, b).rpc('eth_chainId', [], b.signal)).rejects.toBeTruthy();
    expect(performance.now() - started).toBeLessThan(300); expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('exports independently replayed plans with strict thresholds and exact target lineage', async () => {
    vi.stubEnv('FLASHLOAN_CANDIDATE_RESEARCH_V2', 'true');
    const { worker } = runtime(), request = input(worker);
    const envelope = await worker.dispatch('flashloan_research_candidates_v2', request, hash('round'));
    const result = envelope.data as any;
    expect(result.ranking.length).toBeGreaterThan(0); expect(result.execution).toBe(false);
    expect(result.ledger.counts.evaluated).toBe(1);
    for (const row of result.ranking) {
      expect(BigInt(row.planNetRaw)).toBeGreaterThan(0n);
      const proof = result.researchPlans.find((p: any) => 'sha256:' + p.content_hash === row.planHash);
      expect(worker.proofs.verify(proof, 'evm_plan').payload.solution).toBeTruthy();
    }
    const equal = await worker.dispatch('flashloan_research_candidates_v2', { ...request, profileResearchPolicy: { ...request.profileResearchPolicy, minNetProfitRaw: result.ranking[0].planNetRaw } }, hash('equal'));
    expect((equal.data as any).ranking).toEqual([]);
    console.log(JSON.stringify({ event: 'flashloan.v7.edge', edge: 'EDGE-03', passed: true }));
  });
  it.each(['missing', 'expired', 'state', 'asset', 'reservation'] as const)('withholds modeled qualification for %s costs', async (fault) => {
    const { engine, worker } = runtime(), request = input(worker);
    if (fault === 'missing') request.costEvidence = null;
    if (fault === 'expired') request.costEvidence!.expiresAt = '2020-01-01T00:00:00Z';
    if (fault === 'state') request.costEvidence!.state.stateDigest = 'sha256:' + '0'.repeat(64);
    if (fault === 'asset') request.costEvidence!.repaymentAssetId = assetId(chain, B);
    if (fault === 'reservation') request.costEvidence!.gasReservationNativeRaw = '0';
    const result = await researchCandidatesV2(engine, request, worker.proofs, async () => { throw new Error('Must not compute'); }, budget()) as any;
    expect(result.ranking).toEqual([]); expect(result.status).toBe('INPUT_BLOCKED');
  });
  it('shares retry counters and honors cancellation without resetting its budget', async () => {
    const b = budget({ maxRpcCalls: 2 });
    const fetcher = vi.fn(async () => new Response('', { status: 503 }));
    const rpc = new JsonClient('https://fixture.test', fetcher, 15000, b);
    await expect(rpc.rpc('eth_chainId', [], b.signal)).rejects.toMatchObject({ code: 'RESOLUTION_BUDGET' });
    expect(fetcher).toHaveBeenCalledTimes(2); expect(b.rpcCallsUsed).toBe(2);
    const controller = new AbortController(); controller.abort();
    const cancelled = new RoundBudget(limits, controller.signal);
    expect(() => cancelled.rpc()).toThrow(/cancelled/);
    console.log(JSON.stringify({ event: 'flashloan.v7.edge', edge: 'EDGE-02', passed: true }));
  });
  it('retains explicit targets deferred by candidate limits', async () => {
    const { engine, worker } = runtime(), request = input(worker);
    request.selection.explicitAssets.push(assetId(chain, L));
    const result = await researchCandidatesV2(engine, request, worker.proofs, async (t) => computeInline(t), budget()) as any;
    expect(result.ledger.items).toHaveLength(2); expect(result.ledger.counts.deferred).toBe(1);
    expect(Object.entries(result.ledger.counts).filter(([k]) => k !== 'requested').reduce((sum, [, v]) => sum + Number(v), 0)).toBe(2);
  });
});

describe('v7 contract and interoperability seams', () => {
  it('composes automatic state over actual SDK → gateway → protected worker → compute', async () => {
    vi.stubEnv('FEATURE_MCP_FLASHLOAN_PUBLIC_STATELESS', 'true'); vi.stubEnv('FLASHLOAN_CANDIDATE_RESEARCH_V2', 'true'); vi.stubEnv('FLASHLOAN_POOL_RESOLUTION_V1', 'true');
    const token = 'k'.repeat(48), multi = parseAbi(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[] returnData)']);
    const wordData = (values: bigint[]) => encodeAbiParameters(values.map(() => ({ type: 'uint256' })), values);
    const callData = (to: string, data: Hex): Hex => {
      const selector = data.slice(0, 10);
      if (selector === toFunctionSelector('token0()')) return wordData([BigInt(A)]);
      if (selector === toFunctionSelector('token1()')) return wordData([BigInt(B)]);
      if (selector === toFunctionSelector('decimals()')) return wordData([18n]);
      if (selector === toFunctionSelector('getReserves()')) return wordData([1000000n, to === snapshot.pools[0].address ? 2000000n : 1000000n, 1n]);
      if (selector === toFunctionSelector('getReserveData(address)')) return wordData([(1n << 56n) | (1n << 63n), 0n, 0n, 0n, 0n, 0n, 0n, 0n, BigInt(L)]);
      if (selector === toFunctionSelector('FLASHLOAN_PREMIUM_TOTAL()')) return wordData([9n]);
      if (selector === toFunctionSelector('balanceOf(address)')) return wordData([100000n]);
      throw new Error('Unexpected fixture call ' + selector);
    };
    const provider = vi.fn(async (url: unknown, options?: RequestInit) => {
      if (String(url).includes('dexscreener.com')) return Response.json(snapshot.pools.map((p) => ({ chainId: 'base', dexId: 'fixture', pairAddress: p.address, baseToken: { address: A }, quoteToken: { address: B }, liquidity: { usd: 20000 }, priceUsd: '1' })));
      const request = JSON.parse(String(options?.body)); let result: unknown;
      if (request.method === 'eth_chainId') result = '0x2105';
      else if (request.method === 'eth_getBlockByNumber') result = block;
      else if (request.method === 'eth_getCode') result = code;
      else if (request.method === 'eth_call') {
        const { to, data } = request.params[0];
        if (to === '0xca11bde05977b3631167028862be2a173976ca11') {
          const decoded = decodeFunctionData({ abi: multi, data });
          result = encodeFunctionResult({ abi: multi, functionName: 'aggregate3', result: decoded.args![0].map((c) => ({ success: true, returnData: callData(c.target, c.callData) })) });
        } else result = callData(to, data);
      } else throw new Error('Unexpected fixture method ' + request.method);
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    });
    const storage = vi.fn(() => { throw new Error('Public research touched persistence'); });
    const deployments = [...snapshot.pools.map((p) => ({ network: 'base' as const, address: p.address, adapter: 'UNISWAP_V2' as const, code_hash: keccak256(code), fee_pips: 3000, version: 'fixture' })), { network: 'base' as const, address: L, adapter: 'AAVE_V3' as const, code_hash: keccak256(code), version: 'fixture' }];
    const worker = new ResearchWorker({ repo: new Proxy({}, { get: () => storage }) as Repository, endpoints: { base: 'https://fixture.test' }, deployments, publicKey: token, fetcher: provider });
    const listen = async (s: ReturnType<typeof createServer>) => { await new Promise<void>((done, reject) => { s.once('error', reject); s.listen(0, '127.0.0.1', done); }); return (s.address() as { port: number }).port; };
    const internal = createResearchServer(worker, token), workerPort = await listen(internal);
    vi.stubEnv('FLASHLOAN_WORKER_URL', 'http://127.0.0.1:' + workerPort); vi.stubEnv('FLASHLOAN_WORKER_TOKEN', token);
    const gateway = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c));
        const headers = new Headers(); for (const [k, v] of Object.entries(req.headers)) if (v) headers.set(k, String(v));
        const response = await publicMcpHandler(new Request('http://localhost' + req.url, { method: req.method, headers, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }));
        res.writeHead(response.status, Object.fromEntries(response.headers.entries())); res.end(Buffer.from(await response.arrayBuffer()));
      } catch { res.writeHead(500); res.end(); }
    });
    const port = await listen(gateway), client = new Client({ name: 'v7-http-e2e', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + port + '/api/mcp/flashloan')));
      expect((await client.listTools()).tools.map((t) => t.name)).toContain('flashloan_research_candidates_v2');
      const request = input(worker.publicResearch!); request.snapshot = null; request.costEvidence = null;
      const discovered = await client.callTool({ name: 'flashloan_research_candidates_v2', arguments: JSON.parse(JSON.stringify(request)) });
      expect(discovered.isError).toBeFalsy();
      const first = (discovered.structuredContent as any).data;
      expect(first.status).toBe('INPUT_BLOCKED'); expect(first.snapshot.kind).toBe('evm_snapshot');
      request.costEvidence = input(worker.publicResearch!).costEvidence;
      request.costEvidence!.state.stateDigest = 'sha256:' + first.snapshot.content_hash;
      const modeled = await client.callTool({ name: 'flashloan_research_candidates_v2', arguments: JSON.parse(JSON.stringify(request)) });
      expect(modeled.isError).toBeFalsy();
      const result = (modeled.structuredContent as any).data;
      expect(result.snapshot.content_hash).toBe(first.snapshot.content_hash); expect(result.ranking.length).toBeGreaterThan(0);
      expect(result.researchPlans[0].kind).toBe('evm_plan'); expect(storage).not.toHaveBeenCalled();
      expect((await fetch('http://127.0.0.1:' + workerPort + '/health')).status).toBe(401);
      console.log(JSON.stringify({ event: 'flashloan.v7.http_e2e', automaticSnapshot: true, realComputeThread: true, unsigned: true, persisted: false }));
    } finally {
      await client.close();
      for (const server of [gateway, internal]) { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); }
    }
  }, 20000);
  it('rejects duplicate keys and invalid Unicode before structural hashing', () => {
    expect(() => strictJson('{"mode":"research","mode":"execute"}')).toThrow(/Duplicate/);
    expect(() => strictJson('{"value":"\\ud800"}')).toThrow(/Unicode/);
    expect(strictJson('{"value":"ok","nested":{"value":1}}')).toEqual({ value: 'ok', nested: { value: 1 } });
  });
  it('rejects forged ledger totals after structural validation', async () => {
    const { engine, worker } = runtime();
    const result = await researchCandidatesV2(engine, input(worker), worker.proofs, async (t) => computeInline(t), budget()) as any;
    result.ledger.counts.requested++;
    expect(() => validateIntegration('CandidateResultV2', result)).toThrow(/reconcile/);
    result.ledger.counts.requested--; result.ledger.counts.evaluated--; result.ledger.counts.discovered++;
    expect(() => validateIntegration('CandidateResultV2', result)).toThrow(/Per-outcome/);
  });

  it('rejects unknown fields and tampered proofs with flags off by default', async () => {
    const { engine, worker } = runtime(), request = input(worker);
    expect(() => validateIntegration('CandidateRequestV2', { ...request, privateKey: 'forbidden' })).toThrow();
    const overflow = structuredClone(request); overflow.profileResearchPolicy!.principalCapRaw = (1n << 256n).toString();
    expect(() => validateIntegration('CandidateRequestV2', overflow)).toThrow(/uint256/);
    const proof = request.snapshot as any; request.snapshot = { ...proof, payload: { ...proof.payload, chain_id: 1 } };
    await expect(researchCandidatesV2(engine, request, worker.proofs, async (t) => computeInline(t), budget())).rejects.toMatchObject({ code: 'INVALID_PROOF' });
    expect(publicOperationEnabled('flashloan_research_candidates_v2')).toBe(false);
    expect(publicOperationEnabled('flashloan_resolve_pool_inventory_v1')).toBe(false);
    console.log(JSON.stringify({ event: 'flashloan.v7.edge', edge: 'EDGE-04', passed: true }));
  });
  it('passes exact JSON through the actual MCP SDK generated request adapter', async () => {
    const { worker } = runtime(), request = input(worker);
    const server = new McpServer({ name: 'v7-fixture', version: '1' });
    server.registerTool('flashloan_research_candidates_v2', { inputSchema: candidateRequestV2Schema }, async (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] }));
    const client = new Client({ name: 'v7-client', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(a); await client.connect(b);
      expect((await client.listTools()).tools[0].inputSchema.properties).toHaveProperty('fundingAnchor');
      const reply = await client.callTool({ name: 'flashloan_research_candidates_v2', arguments: JSON.parse(JSON.stringify(request)) });
      expect(JSON.parse((reply.content as any)[0].text)).toEqual(request);
      const invalid = await client.callTool({ name: 'flashloan_research_candidates_v2', arguments: { ...request, unexpected: true } });
      expect(invalid.isError).toBe(true);
    } finally { await client.close(); await server.close(); }
    console.log(JSON.stringify({ event: 'flashloan.v7.edge', edge: 'EDGE-05', passed: true, scope: 'MCP SDK only; positive local v4 parser acceptance remains pending' }));
  });
  it.skipIf(!process.env.FLASHLOAN_LOCAL_SKILL_ROOT)('executes the actual local parser and proves its unsupported-v7 boundary', async () => {
    const { engine, worker } = runtime();
    const report = await researchCandidatesV2(engine, input(worker), worker.proofs, async (t) => computeInline(t), budget());
    const script = `
      import fs from 'node:fs';
      import { pathToFileURL } from 'node:url';
      import { resolve } from 'node:path';
      const local = await import(pathToFileURL(resolve(process.argv[1], 'dist/evm/pool-universe.js')).href);
      const bytes = fs.readFileSync(0, 'utf8');
      let rejected = false;
      try { local.parseInventory(JSON.parse(bytes)); } catch (error) { rejected = error.message === 'INVALID_INVENTORY'; }
      const legacy = {schema_version:'flashloan.inventory.v2',network:'base',observed_at:new Date().toISOString(),pools:[]};
      const parsed = local.parseInventory(legacy);
      console.log(JSON.stringify({legacyAccepted:parsed.schema_version==='flashloan.inventory.v2', v7Rejected:rejected, inputBytes:Buffer.byteLength(bytes),gate:rejected?'CLIENT_VERSION_UNSUPPORTED':'ACCEPTED'}));
    `;
    const bytes = JSON.stringify(report);
    const probe = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', script, resolve(process.env.FLASHLOAN_LOCAL_SKILL_ROOT!)], { input: bytes, encoding: 'utf8', timeout: 15000 }));
    expect(probe).toMatchObject({ legacyAccepted: true, v7Rejected: true, inputBytes: Buffer.byteLength(bytes), gate: 'CLIENT_VERSION_UNSUPPORTED' });
  });
});
