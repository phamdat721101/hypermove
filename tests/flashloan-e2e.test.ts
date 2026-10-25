// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createResearchServer } from '../services/flashloan/server';
import { MemoryRepository } from '../src/lib/mcp/flashloan/storage';
import { ResearchWorker } from '../src/lib/mcp/flashloan/worker';
import { operationSchemas, hash } from '../src/lib/mcp/flashloan/contracts';
import { callTool, listTools } from '../src/lib/mcp/gateway';
import { registerTool } from '../src/lib/mcp/server';
import { getTool } from '../src/lib/mcp/tools';
import { z } from 'zod';
vi.mock('../src/lib/db', () => ({ withClient: vi.fn(async () => null) }));

const A = '0x' + '1'.repeat(40), B = '0x' + '2'.repeat(40), L = '0x' + '9'.repeat(40);
const session = { userId: 'alice', tier: 'free' as const, kind: 'admin' as const };
afterEach(() => { vi.unstubAllEnvs(); });
describe('gateway → worker → math → report → cited memory', () => {
  it('runs an owned plan through the real worker HTTP boundary and memory lifecycle', async () => {
    vi.stubEnv('FEATURE_MCP_FLASHLOAN', 'true');
    const root = await mkdtemp(join(tmpdir(), 'flashloan-e2e-')); const repo = new MemoryRepository();
    const marketFetch: typeof fetch = vi.fn(async () => new Response('[]'));
    const worker = new ResearchWorker({ repo, root, endpoints: {}, deployments: [], fetcher: marketFetch });
    const server = createResearchServer(worker, 'x'.repeat(32));
    await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', done); });
    const port = (server.address() as { port: number }).port;
    vi.stubEnv('FLASHLOAN_WORKER_URL', `http://127.0.0.1:${port}`); vi.stubEnv('FLASHLOAN_WORKER_TOKEN', 'x'.repeat(32));
    const invoke = async (name: string, args: Record<string, unknown>) => { const outcome = await callTool({ session, name, args }); expect(outcome.error).toBeUndefined(); return outcome.result as Record<string, any>; };
    const finish = async (job: Record<string, any>) => { await worker.tick(); const done = await invoke('flashloan_research_job', { operation: 'get', job_id: job.id }); expect(done.state).toBe('SUCCEEDED'); return repo.artifact('alice', done.result_id); };
    try {
      expect(listTools().filter((t) => /flashloan|xrpl_.*arbitrage/.test(t.name))).toHaveLength(8);
      const discovery = await finish(await invoke('flashloan_discover_arbitrage_pools', { idempotency_key: 'discover', network: 'base', tokens: [A] })); expect(discovery.kind).toBe('discovery');
      const pool = (id: string, y: string) => ({ kind: 'v2', address: '0x' + id.repeat(40), token0: A, token1: B, decimals0: 18, decimals1: 18, fee_pips: 3000, code_hash: 'fixture', adapter_version: 'fixture', reserve0: '1000000', reserve1: y, stable: false });
      const snapshot = { network: 'base', chain_id: 8453, block: { number: '0x1', hash: '0x' + 'a'.repeat(64), timestamp: '0x1', parentHash: '0x' + 'b'.repeat(64), gasLimit: '0x1c9c380', miner: A }, pools: [pool('3', '2000000'), pool('4', '1000000')], lender: { provider: 'AAVE_V3', address: L, asset: A, capacity: '100000', fee_numerator: '9', fee_denominator: '10000', code_hash: 'fixture' }, coverage: [], warnings: ['fixture market'] };
      const snapshotId = await repo.put('alice', 'snapshot', snapshot);
      const plan = await finish(await invoke('flashloan_solve_dynamic_route_split', { idempotency_key: 'solve', snapshot_id: snapshotId, borrow_asset: A, policy: { max_principal: '1000', network_cost: '1' } })); expect(plan.kind).toBe('plan');
      const reportId = await repo.put('alice', 'report', { status: 'INCONCLUSIVE', plan_id: plan.id, assumptions: ['fixture engine not a live trade'] });
      const proposal = await finish(await invoke('nim_memory_sync_flashloan_lesson', { idempotency_key: 'propose', operation: 'PROPOSE', report_id: reportId }));
      const proposalId = (proposal.data as Record<string, unknown>).proposal_id;
      expect(proposalId).toBeTruthy();
      await finish(await invoke('nim_memory_sync_flashloan_lesson', { idempotency_key: 'validate', operation: 'VALIDATE', proposal_id: proposalId }));
      await finish(await invoke('nim_memory_sync_flashloan_lesson', { idempotency_key: 'commit', operation: 'COMMIT', proposal_id: proposalId }));
      const memory = await finish(await invoke('nim_memory_sync_flashloan_lesson', { idempotency_key: 'retrieve', operation: 'RETRIEVE', query: 'Research report contextual status' }));
      expect(JSON.stringify(memory.data)).toContain(reportId);
      const anonymous = await callTool({ session: { userId: 'anonymous', tier: 'free', kind: 'user' }, name: 'flashloan_research_job', args: { operation: 'get', job_id: discovery.id } }); expect(anonymous.error?.code).toBe(-32001);
    } finally { worker.stop(); server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); await rm(root, { recursive: true, force: true }); }
  }, 30000);
  it('advertises the same native nested schema and rejects malformed transport input', async () => {
    vi.stubEnv('FEATURE_MCP_FLASHLOAN', 'true');
    const tool = getTool('flashloan_ingest_l2_tickmap_and_reserves')!;
    let schema: z.ZodObject | undefined;
    registerTool({ registerTool: (_name: string, config: { inputSchema: z.ZodObject }) => { schema = config.inputSchema; } } as never, tool);
    expect(schema!.safeParse({ idempotency_key: 'x', network: 'base', pools: [{ address: 'bad', adapter: 'UNISWAP_V3' }], lender: { provider: 'AAVE_V3', address: A, asset: A } }).success).toBe(false);
    expect(schema!.safeParse({ idempotency_key: 'x', network: 'base', pools: [{ address: A, adapter: 'UNISWAP_V3' }], lender: { provider: 'AAVE_V3', address: A, asset: A }, owner_id: 'injected' }).success).toBe(false);
    const outcome = await callTool({ session, name: tool.name, args: { idempotency_key: 'bad', network: 'base', pools: [{}] } }); expect(outcome.error?.code).toBe(-32602);
  });
  it('disabled registration preserves the old surface and does not call a worker', () => { vi.stubEnv('FEATURE_MCP_FLASHLOAN', 'false'); expect(getTool('flashloan_research_job')).toBeUndefined(); expect(listTools().some((t) => t.name === 'flashloan_execute_atomic_trade')).toBe(false); });
});
