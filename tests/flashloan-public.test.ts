// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { PublicProofs } from '../src/lib/mcp/flashloan/public-proof';
import { PUBLIC_LIMITS, assertPublicValue, publicSchemas, type ProofEnvelope } from '../src/lib/mcp/flashloan/public-contracts';
import { XRPL_RLUSD } from '../src/lib/mcp/flashloan/rlusd-devtools';
import { ResearchAdmission } from '../src/lib/mcp/flashloan/admission';
import { ResearchWorker } from '../src/lib/mcp/flashloan/worker';
import { publicMcpHandler } from '../src/lib/mcp/flashloan/public-mcp';
import { createResearchServer } from '../services/flashloan/server';
import type { Repository } from '../src/lib/mcp/flashloan/storage';
import { hash } from '../src/lib/mcp/flashloan/contracts';
import { computeInline } from '../src/lib/mcp/flashloan/engine';

const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), L = '0x' + '9'.repeat(40), key = 'k'.repeat(48), registry = 'a'.repeat(64);
const pool = (id: string, reserve1: string) => ({ kind: 'v2', address: '0x' + id.repeat(40), token0: A, token1: B, decimals0: 18, decimals1: 18, fee_pips: 3000, code_hash: 'fixture', adapter_version: 'fixture', reserve0: '1000000', reserve1, stable: false });
const snapshot = { network: 'base', chain_id: 8453, block: { number: '0x1', hash: '0x' + 'a'.repeat(64), timestamp: '0x1', parentHash: '0x' + 'b'.repeat(64), gasLimit: '0x1c9c380', miner: A }, pools: [pool('3', '2000000'), pool('4', '1000000')], lender: { provider: 'AAVE_V3', address: L, asset: A, capacity: '100000', fee_numerator: '9', fee_denominator: '10000', code_hash: 'fixture' }, coverage: [], warnings: ['fixture market'] };
function noStorage() {
  const calls = vi.fn(() => { throw new Error('Public request touched storage'); });
  return { calls, repo: new Proxy({}, { get: () => calls }) as Repository };
}
const listen = async (server: ReturnType<typeof createServer>) => { await new Promise<void>((done) => server.listen(0, '127.0.0.1', done)); return (server.address() as { port: number }).port; };
const close = async (server: ReturnType<typeof createServer>) => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); };
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('public integrity and admission boundaries', () => {
  it('binds every field, rejects changes/kinds/registry/expiry and inherits source expiry', () => {
    let now = Date.parse('2026-10-25T00:00:00Z');
    const proofs = new PublicProofs(key, registry, () => now);
    const envelope = proofs.sign('evm_snapshot', snapshot);
    expect(proofs.verify(envelope, 'evm_snapshot').payload).toEqual(snapshot);
    expect(() => proofs.verify({ ...envelope, expires_at: new Date(now + 1).toISOString() }, 'evm_snapshot')).toThrow(/modified/);
    expect(() => proofs.verify({ ...envelope, payload: { ...snapshot, chain_id: 1 } }, 'evm_snapshot')).toThrow(/modified/);
    expect(() => proofs.verify(envelope, 'evm_plan')).toThrow(/kind/);
    expect(() => new PublicProofs(key, 'b'.repeat(64), () => now).verify(envelope, 'evm_snapshot')).toThrow(/registry/);
    now += 300000;
    expect(proofs.sign('evm_plan', { plan: true }, envelope.expires_at).expires_at).toBe(envelope.expires_at);
    now += 300001;
    expect(() => proofs.verify(envelope, 'evm_snapshot')).toThrow(/expired/);
    expect(() => new PublicProofs('weak', registry)).toThrow(/32 bytes/);
  });
  it('bounds UTF-8 bytes, structure, numeric input and public pool/tick request budgets', () => {
    expect(() => assertPublicValue({ text: '😀'.repeat(1000) }, 3000)).toThrow(/byte/);
    let deep: unknown = {}; for (let n = 0; n < 42; n++) deep = { deep };
    expect(() => assertPublicValue(deep)).toThrow(/structure/);
    expect(publicSchemas.flashloan_discover_arbitrage_pools.safeParse({ network: 'base', tokens: Array(31).fill(A) }).success).toBe(false);
    expect(publicSchemas.flashloan_ingest_l2_tickmap_and_reserves.safeParse({ network: 'base', pools: [{ address: A, adapter: 'UNISWAP_V3', word_range: 2 }], lender: { provider: 'AAVE_V3', address: L, asset: A } }).success).toBe(false);
  });
  it('shares total slots with private jobs, releases idempotently and bounds public quotas', () => {
    let now = 0; const admission = new ResearchAdmission(2, () => now);
    const first = admission.privateLease()!; const second = admission.privateLease()!;
    expect(() => admission.publicLease('ip')).toThrow(/capacity/); first();
    const release = admission.publicLease('ip'); expect(admission.privateLease()).toBeNull();
    expect(() => admission.publicLease('another')).toThrow(/capacity/); release(); release(); second();
    for (let i = 0; i < 5; i++) admission.publicLease('ip')();
    expect(() => admission.publicLease('ip')).toThrow(/quota/);
    now = 60001; admission.publicLease('ip')();
  });
  it('sizes proven inline state with the real compute thread without persistence', async () => {
    const storage = noStorage();
    const worker = new ResearchWorker({ repo: storage.repo, endpoints: { base: 'https://example.test' }, deployments: [], publicKey: key, fetcher: vi.fn(async () => Response.json({ result: { hash: snapshot.block.hash } })) });
    const proof = worker.publicResearch!.proofs.sign('evm_snapshot', snapshot);
    const input = { snapshot: proof, borrow_asset: A, policy: { max_principal: '1000', network_cost: '0' } };
    const result = await worker.publicDispatch('flashloan_solve_dynamic_route_split', input, hash('ip'));
    expect(result.ok).toBe(true); expect((result.data as { kind: string }).kind).toBe('evm_plan');
    expect(storage.calls).not.toHaveBeenCalled();
    const altered = { ...input, snapshot: { ...proof, payload: { ...snapshot, chain_id: 1 } } };
    await expect(worker.publicDispatch('flashloan_solve_dynamic_route_split', altered, hash('ip'))).rejects.toMatchObject({ code: 'INVALID_PROOF' });
    const other = new ResearchWorker({ repo: storage.repo, endpoints: { base: 'https://example.test' }, deployments: [], publicKey: key, fetcher: vi.fn(async () => Response.json({ result: { hash: 'different' } })) });
    await expect(other.publicDispatch('flashloan_solve_dynamic_route_split', input, hash('ip'))).rejects.toMatchObject({ code: 'REORG' });
    const missing = new ResearchWorker({ repo: storage.repo, endpoints: { base: 'https://example.test' }, deployments: [], publicKey: key, fetcher: vi.fn(async () => Response.json({ result: null })) });
    await expect(missing.publicDispatch('flashloan_simulate_atomic_revm', { plan: result.data, caller: A, executor: B, executor_mode: 'fixture' }, hash('ip'))).rejects.toMatchObject({ code: 'REORG' });
  });
  it('gates candidate research and accounts for missing, evaluated and deferred targets without storage', async () => {
    const storage = noStorage();
    const worker = new ResearchWorker({ repo: storage.repo, endpoints: { base: 'https://example.test' }, deployments: [], publicKey: key, compute: async (task) => computeInline(task), fetcher: vi.fn(async () => Response.json({ result: { hash: snapshot.block.hash } })) });
    const input = { schema: 'flash-run-request/1', round_id: 'coverage', network: 'base', mode: 'research', snapshot: worker.publicResearch!.proofs.sign('evm_snapshot', snapshot), selection: { explicit_assets: [B, L, A], movers: false }, policy: { max_principal: '1000', network_cost: '0', max_price_impact_bps: 5000 }, cost_evidence: { asset: A, network_cost_raw: '0', other_cost_raw: '0', evidence_hash: 'a'.repeat(64), expires_at: new Date(Date.now() + 60000).toISOString() }, limits: { max_candidates: 2, max_evaluations: 100, deadline_ms: 1000 } };
    await expect(worker.publicDispatch('flashloan_research_candidates_v1', input, hash('gate'))).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' });
    vi.stubEnv('FLASHLOAN_CANDIDATE_RESEARCH_V1', 'true');
    const result = await worker.publicDispatch('flashloan_research_candidates_v1', input, hash('coverage')) as { data: { candidate_ledger: { items: Array<{ asset_id: string; outcome: string }> }; best_qualified: { plan: unknown } } };
    expect(result.data.candidate_ledger.items).toHaveLength(3);
    expect(result.data.candidate_ledger.items.find((i) => i.asset_id === B)?.outcome).toBe('EVALUATED');
    expect(result.data.candidate_ledger.items.find((i) => i.asset_id === L)?.outcome).toBe('DEFERRED_BUDGET');
    expect(result.data.best_qualified.plan).toMatchObject({ kind: 'evm_plan', version: 2 });
    expect(result.data.best_qualified.plan).toMatchObject({ expires_at: input.cost_evidence.expires_at, payload: { cost_evidence: input.cost_evidence } });
    const lowered = await worker.publicDispatch('flashloan_research_candidates_v1', { ...input, policy: { ...input.policy, network_cost: '100' } }, hash('lowered'));
    expect(lowered.data).toMatchObject({ status: 'INPUT_BLOCKED', best_qualified: null });
    const blocked = await worker.publicDispatch('flashloan_research_candidates_v1', { ...input, policy: null }, hash('blocked'));
    expect(blocked.data).toMatchObject({ status: 'INPUT_BLOCKED', best_qualified: null, search: { attempted: 0 } });
    const stale = await worker.publicDispatch('flashloan_research_candidates_v1', { ...input, cost_evidence: { ...input.cost_evidence, expires_at: '2020-01-01T00:00:00Z' } }, hash('stale'));
    expect(stale.data).toMatchObject({ status: 'INPUT_BLOCKED', best_qualified: null });
    console.log(JSON.stringify({ event: 'flashloan.candidate_research.edge', edge: 'EDGE-03', passed: true }));
    await expect(worker.publicDispatch('flashloan_research_candidates_v1', { ...input, snapshot: { ...input.snapshot, payload: { ...snapshot, chain_id: 1 } } }, hash('tamper'))).rejects.toMatchObject({ code: 'INVALID_PROOF' });
    console.log(JSON.stringify({ event: 'flashloan.candidate_research.edge', edge: 'EDGE-04', passed: true }));
    expect(storage.calls).not.toHaveBeenCalled();
    console.log(JSON.stringify({ event: 'flashloan.candidate_research.edge', edge: 'EDGE-01', passed: true }));
  });
  it('enforces the candidate deadline during hanging mover discovery and releases its lease', async () => {
    vi.stubEnv('FLASHLOAN_CANDIDATE_RESEARCH_V1', 'true');
    const storage = noStorage();
    const worker = new ResearchWorker({ repo: storage.repo, endpoints: { base: 'https://example.test' }, deployments: [], publicKey: key, fetcher: async (url, options) => {
      if (String(url).includes('example.test')) return Response.json({ result: { hash: snapshot.block.hash } });
      return new Promise((_done, reject) => { const abort = () => reject(new Error('aborted')); if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener('abort', abort, { once: true }); });
    } });
    const input = { schema: 'flash-run-request/1', round_id: 'deadline', network: 'base', mode: 'research', snapshot: worker.publicResearch!.proofs.sign('evm_snapshot', snapshot), selection: { explicit_assets: [B], movers: true }, policy: null, cost_evidence: null, limits: { max_candidates: 1, max_evaluations: 1, deadline_ms: 20 } };
    await expect(worker.publicDispatch('flashloan_research_candidates_v1', input, hash('deadline'))).rejects.toMatchObject({ code: 'DEADLINE_OR_CANCELLATION' });
    expect((await worker.publicDispatch('flashloan_research_candidates_v1', { ...input, selection: { ...input.selection, movers: false }, limits: { ...input.limits, deadline_ms: 5000 } }, hash('released'))).data).toMatchObject({ status: 'INPUT_BLOCKED' });
  });
  it('cancels isolated work, releases capacity and rejects unsupported public operations', async () => {
    const storage = noStorage(); const controller = new AbortController();
    let began!: () => void; const started = new Promise<void>((done) => { began = done; }); let calls = 0;
    const worker = new ResearchWorker({ repo: storage.repo, endpoints: { base: 'https://example.test' }, deployments: [], publicKey: key, fetcher: vi.fn(async () => Response.json({ result: { hash: snapshot.block.hash } })), compute: async (task, signal) => { if (calls++) return computeInline(task); began(); return new Promise((_done, reject) => signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })); } });
    await expect(worker.publicDispatch('flashloan_research_job' as never, {}, hash('ip'))).rejects.toMatchObject({ code: 'UNKNOWN_OPERATION' });
    const input = { snapshot: worker.publicResearch!.proofs.sign('evm_snapshot', snapshot), borrow_asset: A, policy: { max_principal: '1000', network_cost: '0' } };
    const request = worker.publicDispatch('flashloan_solve_dynamic_route_split', input, hash('ip'), controller.signal);
    const rejected = expect(request).rejects.toMatchObject({ code: 'DEADLINE_OR_CANCELLATION' });
    await started; controller.abort(); await rejected;
    expect((await worker.publicDispatch('flashloan_solve_dynamic_route_split', input, hash('ip'))).ok).toBe(true);
    expect(storage.calls).not.toHaveBeenCalled();
  });
});

describe('XRPL holder report', () => {
  const toolName = 'xrpl_get_holder_report_v1';
  const ledger = { ledger_hash: 'b'.repeat(64), ledger_index: 108470189, validated: true };
  const issued = { issuer: XRPL_RLUSD.issuer, currency: XRPL_RLUSD.currency, value: '900' };
  const holderInput = { xrp_amount_drops: '1000000000', scenario: { xrp_price_change_bps: -3000, holding_days: 30, assumed_xrp_apy_bps: 400 } };

  function fixtureWorker() {
    const storage = noStorage();
    const fetcher = vi.fn(async (_url: unknown, options?: RequestInit) => {
      const { method, params: [request] } = JSON.parse(String(options?.body));
      if (method === 'ledger') return Response.json({ result: ledger });
      expect(request.ledger_hash).toBe(ledger.ledger_hash);
      if (method === 'amm_info') {
        return Response.json({ result: { ...ledger, amm: {
          account: 'fixture-pool', amount: '1000000000000', amount2: { ...issued, value: '900000' }, trading_fee: 315,
        } } });
      }
      if (method === 'book_offers') {
        const offer = request.taker_gets.currency === 'XRP'
          ? { TakerGets: '1000000000', TakerPays: issued }
          : { TakerGets: issued, TakerPays: '1000000000' };
        return Response.json({ result: { ...ledger, offers: [offer] } });
      }
      throw new Error('Unexpected XRPL method ' + method);
    });
    const worker = new ResearchWorker({
      repo: storage.repo, endpoints: { xrpl: 'https://example.test' }, deployments: [], publicKey: key,
      compute: async (task) => computeInline(task), fetcher,
    });
    return { worker, fetcher, storage };
  }

  async function discover(worker: ResearchWorker) {
    const result = await worker.publicDispatch('xrpl_discover_arbitrage_routes', {
      network: 'xrpl', assets: [{ kind: 'xrp' }, XRPL_RLUSD],
      funding: { mode: 'hypothetical', balances: [{ asset: { kind: 'xrp' }, amount: '10000' }] },
    }, hash('holder-discovery'));
    return result.data as ProofEnvelope;
  }

  it('returns independent XRP sale estimates and benchmarks through the public MCP and worker', async () => {
    vi.stubEnv('FEATURE_MCP_FLASHLOAN_PUBLIC_STATELESS', 'true');
    const { worker, fetcher, storage } = fixtureWorker();
    const routes = await discover(worker);
    expect(fetcher).toHaveBeenCalledTimes(4);
    const internal = createResearchServer(worker, key);
    const port = await listen(internal);
    vi.stubEnv('FLASHLOAN_WORKER_URL', `http://127.0.0.1:${port}`);
    vi.stubEnv('FLASHLOAN_WORKER_TOKEN', key);
    try {
      const response = await publicMcpHandler(new Request('https://mcp.overguild.com/api/mcp/flashloan', {
        method: 'POST',
        headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: toolName, arguments: { routes, ...holderInput } } }),
      }));
      const text = await response.text();
      const body = JSON.parse(text.split('\n').find((line) => line.startsWith('data:'))?.slice(5) ?? text);
      expect(body.result.isError).toBeFalsy();
      const report = body.result.structuredContent;
      expect(report).toMatchObject({ operation: toolName, ok: true, execution: false, data: {
        schema_version: 'xrpl.holder_report.v1', status: 'ESTIMATE_ONLY',
        source: { ledger_index: ledger.ledger_index, ledger_hash: ledger.ledger_hash, funding_mode: 'hypothetical', expires_at: routes.expires_at, content_hash: routes.content_hash },
        sale: {
          xrp_amount: '1000', counter_asset: XRPL_RLUSD,
          book: { status: 'ESTIMATE_ONLY', rlusd_out: '900' },
          amm: { status: 'ESTIMATE_ONLY', trading_fee_units_per_100000: 315 },
          network_fee_xrp: null, issuer_transfer_cost_rlusd: null, account_eligibility: 'NOT_CHECKED',
        },
        scenario: { xrp_yield_end_amount_drops: '1003228821' },
        realized_lp_fee_income: null,
      } });
      const returns = report.data.scenario.usd_return_fractions;
      expect(Number(report.data.sale.amm.rlusd_out)).toBeCloseTo(896.2717, 3);
      expect(returns.xrp_yield).toBeCloseTo(-0.2977398, 6);
      expect(returns.xrp_rlusd_50_50_amm_before_fees).toBeCloseTo(-0.16333997, 6);
      expect(returns.xrp_rlusd_50_50_hold).toBeCloseTo(-0.15, 6);
      expect(returns.xrp_rlusd_stablecoin_buffer).toBeCloseTo(-0.225, 6);
      expect(fetcher).toHaveBeenCalledTimes(4);
      expect(storage.calls).not.toHaveBeenCalled();
    } finally { await close(internal); }
  });

  it('retains AMM coverage when the book is too shallow and rejects invalid proof or asset identity', async () => {
    const { worker, fetcher } = fixtureWorker();
    const routes = await discover(worker);
    const report = await worker.publicDispatch(toolName, { routes, ...holderInput, xrp_amount_drops: '1000000001' }, hash('partial'));
    expect(report.data).toMatchObject({ sale: { xrp_amount: '1000.000001', book: { status: 'UNAVAILABLE', reason: 'INSUFFICIENT_BOOK_DEPTH' }, amm: { status: 'ESTIMATE_ONLY' } } });

    const proofs = worker.publicResearch!.proofs;
    const older = new PublicProofs(key, proofs.registry, () => Date.now() - PUBLIC_LIMITS.proof_ttl_ms - 1000);
    const wrongMarket = {
      ...routes.payload,
      edges: [{ from: 'XRP', to: '524C555344000000000000000000000000000000:other-issuer', kind: 'book' }],
    };
    const mixedNetwork = proofs.sign('xrpl_routes', { ...routes.payload, network: 'base' });
    const cases = [
      [{ ...routes, payload: { ...routes.payload, ledger_index: 1 } }, 'INVALID_PROOF'],
      [older.sign('xrpl_routes', routes.payload), 'PROOF_EXPIRED'],
      [proofs.sign('evm_plan', routes.payload), 'PROOF_KIND'],
      [proofs.sign('xrpl_routes', wrongMarket), 'UNSUPPORTED_MARKET'],
      [mixedNetwork, 'INVALID_SNAPSHOT'],
    ] as const;
    for (const [inputRoutes, code] of cases) {
      await expect(worker.publicDispatch(toolName, { routes: inputRoutes, ...holderInput }, hash(code))).rejects.toMatchObject({ code });
    }
    for (const amount of ['0', '1000.1', 'NaN', '100000000000000001']) {
      expect(publicSchemas[toolName].safeParse({ routes, ...holderInput, xrp_amount_drops: amount }).success).toBe(false);
    }
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});

describe('credential-free SDK → public MCP → protected worker', () => {
  it('normalizes malformed arguments and unavailable workers into typed MCP errors', async () => {
    vi.stubEnv('FEATURE_MCP_FLASHLOAN_PUBLIC_STATELESS', 'true');
    vi.stubEnv('FLASHLOAN_WORKER_URL', 'http://127.0.0.1:1'); vi.stubEnv('FLASHLOAN_WORKER_TOKEN', key);
    const request = (name: string, args: unknown) => publicMcpHandler(new Request('https://mcp.overguild.com/api/mcp/flashloan', { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }));
    const invalid = await request('flashloan_discover_arbitrage_pools', { network: 'base', tokens: ['invalid'] });
    expect((await invalid.json()).result).toMatchObject({ isError: true, structuredContent: { ok: false, error: { code: 'INVALID_INPUT' } } });
    const unknown = await request('flashloan_research_job', {});
    expect((await unknown.json()).result.structuredContent.error.code).toBe('UNKNOWN_OPERATION');
    const largeName = await request('x'.repeat(1000000), {});
    expect((await largeName.text()).length).toBeLessThan(2000);
    const unavailable = await request('flashloan_capabilities', {}); const text = await unavailable.text();
    const body = JSON.parse(text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').find((line) => line.startsWith('data:'))!.slice(5) : text);
    expect(body.result.structuredContent.error.code).toBe('WORKER_UNAVAILABLE');
  });
  it('cancels stalled request readers after the upload deadline', async () => {
    vi.useFakeTimers(); vi.stubEnv('FEATURE_MCP_FLASHLOAN_PUBLIC_STATELESS', 'true');
    let cancelled = false;
    const stream = new ReadableStream({ cancel() { cancelled = true; } });
    const request = new Request('https://mcp.overguild.com/api/mcp/flashloan', { method: 'POST', body: stream, duplex: 'half' } as RequestInit);
    const pending = publicMcpHandler(request);
    await vi.advanceTimersByTimeAsync(10001);
    const result = await pending; expect(result.status).toBe(408); expect(cancelled).toBe(true);
    expect((await result.json()).error.code).toBe('REQUEST_TIMEOUT');
  });
  it('negotiates the public catalog and composes discovery and RLUSD checks without persistence', async () => {
    vi.stubEnv('FEATURE_MCP_FLASHLOAN_PUBLIC_STATELESS', 'true');
    const storage = noStorage(); const worker = new ResearchWorker({ repo: storage.repo, endpoints: { base: 'https://example.test' }, deployments: [], publicKey: key, fetcher: vi.fn(async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === '/currencies/v2') return Response.json([]);
      if (path === '/v2/chains') return Response.json({ message: 'x-integrator-id header is missing' }, { status: 400 });
      if (path.startsWith('/tokens/v1/')) {
        const network = path.split('/')[3], token = network === 'sui' ? '0x2::sui::SUI' : A, quote = network === 'sui' ? '0x3::usdc::USDC' : B;
        return Response.json([{ chainId: network, dexId: 'fixture', pairAddress: 'fixture-market', baseToken: { address: token }, quoteToken: { address: quote }, priceUsd: '1', liquidity: { usd: 20000 }, priceChange: { h24: network === 'sui' ? -15 : 20 }, pairCreatedAt: Date.now() - 172800000 }]);
      }
      return Response.json(path.includes('/search') ? { pairs: [] } : []);
    }) });
    const internal = createResearchServer(worker, key); const workerPort = await listen(internal);
    vi.stubEnv('FLASHLOAN_WORKER_URL', `http://127.0.0.1:${workerPort}`); vi.stubEnv('FLASHLOAN_WORKER_TOKEN', key);
    const observed: Array<{ authorization?: string; session?: string }> = [];
    const gateway = createServer(async (req: IncomingMessage, res) => {
      observed.push({ authorization: req.headers.authorization, session: req.headers['mcp-session-id'] as string | undefined });
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers(); for (const [name, value] of Object.entries(req.headers)) if (value) headers.set(name, String(value));
      const response = await publicMcpHandler(new Request('http://localhost' + req.url, { method: req.method, headers, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }));
      expect(response.headers.has('mcp-session-id')).toBe(false);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries())); res.end(Buffer.from(await response.arrayBuffer()));
    });
    const port = await listen(gateway); const client = new Client({ name: 'public-e2e', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/api/mcp/flashloan`)));
      const tools = await client.listTools(); expect(tools.tools).toHaveLength(13); expect(tools.tools.map((t) => t.name)).not.toContain('nim_memory_sync_flashloan_lesson');
      expect(tools.tools.find((t) => t.name === 'flashloan_get_token_movers')?.annotations?.readOnlyHint).toBe(true);
      expect(tools.tools.find((t) => t.name === 'xrpl_get_holder_report_v1')?.annotations?.readOnlyHint).toBe(true);
      const movers = await client.callTool({ name: 'flashloan_get_token_movers', arguments: { seed_tokens: { base: [A], arbitrum: [A], robinhood: [A], sui: ['0x2::sui::SUI'] } } });
      expect(movers.isError).toBeFalsy();
      const chains = (movers.structuredContent as { data: { chains: Array<{ network: string; tokens: Array<{ token_id: string }> }> } }).data.chains;
      expect(chains).toHaveLength(4); expect(chains.every((chain) => chain.tokens.length === 1)).toBe(true);
      const result = await client.callTool({ name: 'flashloan_discover_arbitrage_pools', arguments: { network: 'base', tokens: chains[0].tokens.map((token) => token.token_id) } });
      expect(result.isError).toBeFalsy(); expect(result.structuredContent).toMatchObject({ schema_version: 'flashloan.public.v3', ok: true, execution: false });
      const rlusd = tools.tools.find((tool) => tool.name === 'flashloan_rlusd_devtools_v1');
      expect(rlusd?.annotations?.readOnlyHint).toBe(true);
      const diagnostic = await client.callTool({ name: 'flashloan_rlusd_devtools_v1', arguments: { request: { action: 'check_providers' } } });
      expect(diagnostic.isError).toBeFalsy();
      expect(diagnostic.structuredContent).toMatchObject({ ok: true, execution: false, data: { route_ready: false, providers: { squid: { status: 'integrator_id_required' } } } });
      for (let n = 0; n < 3; n++) expect((await client.callTool({ name: 'flashloan_discover_arbitrage_pools', arguments: { network: 'base', tokens: [A] } })).isError).toBeFalsy();
      const limited = await client.callTool({ name: 'flashloan_discover_arbitrage_pools', arguments: { network: 'base', tokens: [A] } });
      expect(limited.isError).toBe(true); expect(limited.structuredContent).toMatchObject({ ok: false, error: { code: 'RATE_LIMITED', retryable: true, retry_after_ms: 60000 } });
      expect(JSON.stringify(result)).not.toContain('QUEUED'); expect(storage.calls).not.toHaveBeenCalled();
      expect(observed.every((request) => !request.authorization && !request.session)).toBe(true);
      expect((await fetch(`http://127.0.0.1:${workerPort}/health`)).status).toBe(401);
      console.log(JSON.stringify({ event: 'flashloan.public_e2e', no_auth: true, no_session: true, no_persistence: true, tools: tools.tools.length, movers_chains: 4 }));
    } finally { await client.close(); await close(gateway); await close(internal); }
  });
  it('rejects origins/hosts, honors feature rollback and never challenges for credentials', async () => {
    vi.stubEnv('FEATURE_MCP_FLASHLOAN_PUBLIC_STATELESS', 'true');
    const origin = await publicMcpHandler(new Request('https://mcp.overguild.com/api/mcp/flashloan', { method: 'POST', headers: { origin: 'https://attacker.test' }, body: '{}' }));
    expect(origin.status).toBe(403); expect(origin.headers.has('www-authenticate')).toBe(false);
    expect((await publicMcpHandler(new Request('https://attacker.test/api/mcp/flashloan', { method: 'POST', body: '{}' }))).status).toBe(403);
    expect((await publicMcpHandler(new Request('https://mcp.overguild.com/api/mcp/flashloan'))).status).toBe(405);
    vi.stubEnv('FEATURE_MCP_FLASHLOAN_PUBLIC_STATELESS', 'false');
    expect((await publicMcpHandler(new Request('https://mcp.overguild.com/api/mcp/flashloan', { method: 'POST', body: '{}' }))).status).toBe(404);
    expect(PUBLIC_LIMITS.body_bytes).toBe(2097152);
  });
});
