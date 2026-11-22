// @vitest-environment node
import { afterEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResearchWorker } from '../src/lib/mcp/flashloan/worker';
import { MemoryRepository } from '../src/lib/mcp/flashloan/storage';
import { DexScreener, RequestBudget } from '../src/lib/mcp/flashloan/discovery';
import { JsonClient } from '../src/lib/mcp/flashloan/transport';
import { operationSchemas, hash } from '../src/lib/mcp/flashloan/contracts';
import { researchRequest } from '../src/lib/mcp/flashloan/client';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const A = '0x' + '1'.repeat(40);
const input = operationSchemas.flashloan_discover_arbitrage_pools.parse({ idempotency_key: 'one', network: 'base', tokens: [A] });
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
async function fixture(fetcher: typeof fetch = vi.fn(async () => response([]))) { const root = await mkdtemp(join(tmpdir(), 'flashloan-test-')); const repo = new MemoryRepository(); const worker = new ResearchWorker({ repo, endpoints: {}, deployments: [], root, fetcher }); return { root, repo, worker, cleanup: () => rm(root, { recursive: true, force: true }) }; }
describe('owned research lifecycle', () => {
  it('delivery boundary markers cover all five executable failure seams', async () => {
    const logs = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const f = await fixture();
    try {
      vi.stubEnv('FLASHLOAN_WORKER_URL', 'http://127.0.0.1:3012'); vi.stubEnv('FLASHLOAN_WORKER_TOKEN', 'x'.repeat(32));
      vi.stubGlobal('fetch', vi.fn(async () => { throw Error('connection lost'); }));
      await expect(researchRequest('alice', 'flashloan_discover_arbitrage_pools', input)).rejects.toThrow('unavailable');
      const hanging: typeof fetch = (_url, init) => new Promise((_done, reject) => { init?.signal?.addEventListener('abort', () => reject(Error('timeout')), { once: true }); });
      await expect(new JsonClient('https://example.com', hanging, 1).rpc('eth_chainId', [])).rejects.toThrow('deadline');
      const job = await f.repo.enqueue('alice', 'flashloan_discover_arbitrage_pools', input); const claimed = await f.repo.claim();
      await expect(f.repo.get('bob', job.id)).rejects.toThrow();
      await expect(f.worker.dispatch('alice', 'flashloan_discover_arbitrage_pools', {})).rejects.toThrow();
      await f.repo.cancel('alice', job.id); expect(await f.repo.complete(claimed!, 'report', {})).toBe(false);
      const events = logs.mock.calls.map(([line]) => JSON.parse(String(line)).event);
      for (const edge of ['01', '02', '03', '04', '05']) { expect(events).toContain('flashloan.EDGE-' + edge); console.log(JSON.stringify({ event: 'flashloan.EDGE-' + edge, proof: 'observed-and-asserted', test: 'delivery-boundary-seams' })); }
    } finally { await f.cleanup(); }
  });
  it('flashloan.EDGE-01 retry after a lost response returns the same owned job', async () => { const f = await fixture(); try { const first = await f.repo.enqueue('alice', 'flashloan_discover_arbitrage_pools', input); const retry = await f.repo.enqueue('alice', 'flashloan_discover_arbitrage_pools', input); expect(first.id).toBe(retry.id); await expect(f.repo.get('bob', first.id)).rejects.toThrow('not found'); await expect(f.repo.enqueue('alice', 'flashloan_discover_arbitrage_pools', { ...input, network: 'ethereum' })).rejects.toThrow('different input'); } finally { await f.cleanup(); } });
  it('flashloan.EDGE-02 dependency timeout fails visibly without a report', async () => { const f = await fixture(vi.fn(async () => { throw Error('network'); })); try { const j = await f.repo.enqueue('alice', 'flashloan_discover_arbitrage_pools', input); await f.worker.tick(); const done = await f.repo.get('alice', j.id); expect(done.state).toBe('FAILED'); expect(done.result_id).toBeUndefined(); expect(done.error).toBeDefined(); } finally { await f.cleanup(); } });
  it('flashloan.EDGE-03 concurrent claims and artifacts remain isolated', async () => { const f = await fixture(); try { await f.repo.enqueue('alice', 'flashloan_discover_arbitrage_pools', input); await f.repo.enqueue('bob', 'flashloan_discover_arbitrage_pools', input); const [a,b] = await Promise.all([f.repo.claim(), f.repo.claim()]); expect(a!.id).not.toBe(b!.id); const id = await f.repo.put('alice', 'snapshot', { block: 'hash' }); await expect(f.repo.artifact('bob', id)).rejects.toThrow(); } finally { await f.cleanup(); } });
  it('flashloan.EDGE-04 malformed nested input cannot enqueue work', async () => { const f = await fixture(); try { await expect(f.worker.dispatch('alice', 'flashloan_discover_arbitrage_pools', { ...input, tokens: ['bad'] })).rejects.toThrow(); expect(await f.repo.claim()).toBeNull(); await expect(f.worker.dispatch('anonymous', 'flashloan_discover_arbitrage_pools', input)).rejects.toThrow('owner'); } finally { await f.cleanup(); } });
  it('flashloan.EDGE-05 cancellation cannot publish a successful report', async () => { const f = await fixture(); try { const j = await f.repo.enqueue('alice', 'flashloan_discover_arbitrage_pools', input); await f.repo.claim(); await f.repo.cancel('alice', j.id); expect(await f.repo.finish(j.id, hash('report'))).toBe(false); expect((await f.repo.get('alice', j.id)).state).toBe('CANCELLED'); } finally { await f.cleanup(); } });
  it('publishes artifact and success atomically against cancellation', async () => { const f = await fixture(); try { const j = await f.repo.enqueue('alice', 'flashloan_discover_arbitrage_pools', input); const claimed = await f.repo.claim(); await f.repo.cancel('alice', j.id); expect(await f.repo.complete(claimed!, 'report', { status: 'passed' })).toBe(false); const content_hash = hash({ status: 'passed' }); await expect(f.repo.artifact('alice', hash({ owner: 'alice', kind: 'report', content_hash, version: 'flashloan-research/2' }))).rejects.toThrow(); } finally { await f.cleanup(); } });
  it('bounds the owner queue while preserving retries of accepted jobs', async () => { const f = await fixture(); try { for (let i = 0; i < 16; i++) await f.repo.enqueue('alice', 'flashloan_discover_arbitrage_pools', { ...input, idempotency_key: String(i) }); await expect(f.repo.enqueue('alice', 'flashloan_discover_arbitrage_pools', { ...input, idempotency_key: 'overflow' })).rejects.toThrow('budget'); expect((await f.repo.enqueue('alice', 'flashloan_discover_arbitrage_pools', { ...input, idempotency_key: '0' })).state).toBe('QUEUED'); } finally { await f.cleanup(); } });
  it('hydrates large artifacts with bounded resumable chunks', async () => { const f = await fixture(); try { const id = await f.repo.put('alice', 'snapshot', { payload: 'x'.repeat(200000) }); const page = await f.worker.dispatch('alice', 'flashloan_research_job', { operation: 'artifact', artifact_id: id, limit: 10000 }) as { chunk: string; next_offset: number }; expect(page.chunk).toHaveLength(10000); expect(page.next_offset).toBe(10000); await expect(f.worker.dispatch('bob', 'flashloan_research_job', { operation: 'artifact', artifact_id: id })).rejects.toThrow(); } finally { await f.cleanup(); } });
  it('recovers interrupted jobs explicitly and retains queued jobs', async () => { const f = await fixture(); try { const j = await f.repo.enqueue('alice', 'flashloan_discover_arbitrage_pools', input); await f.repo.claim(); await f.repo.recover(); expect((await f.repo.get('alice', j.id)).error?.code).toBe('WORKER_RESTARTED'); } finally { await f.cleanup(); } });
  it('publishes a successful empty discovery as a business outcome', async () => { const f = await fixture(); try { const j = await f.repo.enqueue('alice', 'flashloan_discover_arbitrage_pools', input); await f.worker.tick(); const done = await f.repo.get('alice', j.id); expect(done.state).toBe('SUCCEEDED'); const result = await f.repo.artifact('alice', done.result_id!); expect((result.data as { pools: unknown[] }).pools).toEqual([]); } finally { await f.cleanup(); } });
});
describe('official client and transport', () => {
  it('enumerates every token using token-pairs', async () => { const fetcher = vi.fn(async () => response([])); const client = new DexScreener(fetcher, new RequestBudget(0)); await client.discover({ ...input, tokens: Array.from({ length: 61 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0')) }); expect(fetcher).toHaveBeenCalledTimes(61); });
  it('retains a single-pool token', async () => { const fetcher = vi.fn(async () => response([{ chainId: 'base', dexId: 'uni', pairAddress: A, baseToken: { address: A }, quoteToken: { address: '0x' + '2'.repeat(40) }, liquidity: { usd: 20000 } }])); const result = await new DexScreener(fetcher).discover(input); expect(result.pools).toHaveLength(1); expect(result.token_results[0].route_status).toBe('NOT_EVALUATED'); });
  it('never follows redirects or accepts insecure endpoints', async () => { expect(() => new JsonClient('http://example.com')).toThrow('HTTPS'); let options: RequestInit | undefined; const fetcher: typeof fetch = async (_url, init) => { options = init; return response({ result: 'ok' }); }; await new JsonClient('https://example.com', fetcher).rpc('eth_chainId', []); expect(options?.redirect).toBe('error'); });
});
