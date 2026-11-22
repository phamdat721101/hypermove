// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createResearchServer } from '../services/flashloan/server';
import { ResearchWorker } from '../src/lib/mcp/flashloan/worker';
import type { Repository } from '../src/lib/mcp/flashloan/storage';
import { publicMcpHandler } from '../src/lib/mcp/flashloan/public-mcp';
import { inventoryV3Schema, moversV2Schema, watchlistV1Schema } from '../src/lib/mcp/flashloan/v8-contracts';
import { registryV1Schema } from '../src/lib/mcp/flashloan/discovery-registry';
import { hash } from '../src/lib/mcp/flashloan/contracts';
import { fixtureV8, A8 } from './fixtures/flashloan-v8';

const key = 'v8-fixture-key-'.repeat(4);
const listen = async (server: Server) => { await new Promise<void>((done) => server.listen(0, '127.0.0.1', done)); return (server.address() as { port: number }).port; };
const close = async (server: Server) => { server.closeAllConnections(); await new Promise<void>((done) => server.close(() => done())); };
const enabled = () => { for (const name of ['FEATURE_MCP_FLASHLOAN_PUBLIC_STATELESS', 'FLASHLOAN_INVENTORY_V3', 'FLASHLOAN_MOVERS_V2', 'FLASHLOAN_WATCHLIST_V1', 'FLASHLOAN_REGISTRY_V1']) vi.stubEnv(name, 'true'); };
afterEach(() => { vi.unstubAllEnvs(); });

describe('SDK gateway worker discovery v8 E2E', () => {
  it('negotiates versioned tools and hands schema-valid documents to a consumer without public credentials or storage', async () => {
    enabled(); const fixture = fixtureV8();
    const storage = vi.fn(() => { throw new Error('Public v8 touched storage'); });
    const worker = new ResearchWorker({ repo: new Proxy({}, { get: () => storage }) as Repository, endpoints: { base: 'https://rpc.test' }, deployments: [], publicKey: key, discoveryRegistry: fixture.registry, fetcher: fixture.fetcher });
    const internal = createResearchServer(worker, key); const port = await listen(internal);
    vi.stubEnv('FLASHLOAN_WORKER_URL', 'http://127.0.0.1:' + port); vi.stubEnv('FLASHLOAN_WORKER_TOKEN', key);
    const requests: Array<{ auth: string | undefined; session: string | string[] | undefined }> = [];
    const gateway = createServer((req, res) => { void (async () => {
      requests.push({ auth: req.headers.authorization, session: req.headers['mcp-session-id'] });
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers(); for (const [name, value] of Object.entries(req.headers)) if (value) headers.set(name, String(value));
      const response = await publicMcpHandler(new Request('http://localhost' + req.url, { method: req.method, headers, ...(req.method === 'POST' ? { body: Buffer.concat(chunks) } : {}) }));
      expect(response.headers.has('mcp-session-id')).toBe(false);
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error) => { res.writeHead(500); res.end(String(error)); }); });
    const gatewayPort = await listen(gateway), client = new Client({ name: 'v8-contract-consumer', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL('http://127.0.0.1:' + gatewayPort + '/api/mcp/flashloan')));
      const catalog = await client.listTools(); expect(catalog.tools.map((t) => t.name)).toContain('flashloan_get_watchlist_v1');
      expect(catalog.tools.map((t) => t.name)).toContain('flashloan_get_registry_v1');
      const registry = await client.callTool({ name: 'flashloan_get_registry_v1', arguments: { networks: ['base'] } });
      const registryData = registryV1Schema.parse((registry.structuredContent as { data: unknown }).data);
      const discovery = await client.callTool({ name: 'flashloan_discover_arbitrage_pools', arguments: { schema_version: 'v3', network: 'base', tokens: [A8] } });
      const inventory = inventoryV3Schema.parse((discovery.structuredContent as { data: unknown }).data); expect(inventory.pools.filter((p) => p.liquidity_eligible)).toHaveLength(2);
      const movers = await client.callTool({ name: 'flashloan_get_token_movers', arguments: { schema_version: 'v2', networks: ['base'], seed_tokens: { base: [A8] } } });
      expect(moversV2Schema.parse((movers.structuredContent as { data: unknown }).data).chains[0].tokens).toHaveLength(1);
      const watchlist = await client.callTool({ name: 'flashloan_get_watchlist_v1', arguments: { network: 'base', seed_tokens: [A8] } });
      const consumer = watchlistV1Schema.parse(JSON.parse(JSON.stringify((watchlist.structuredContent as { data: unknown }).data)));
      expect(consumer.registry_version).toBe(registryData.registry_version); expect(consumer.pools).toHaveLength(2); expect(consumer.block?.hash).toBe(inventory.block?.hash);
      const invalid = await client.callTool({ name: 'flashloan_get_watchlist_v1', arguments: { network: 'base', seed_tokens: [A8], signer: A8 } }); expect(invalid.isError).toBe(true);
      const legacy = await client.callTool({ name: 'flashloan_discover_arbitrage_pools', arguments: { network: 'base', tokens: [A8] } }); expect((legacy.structuredContent as { data: { schema_version: string } }).data.schema_version).toBe('flashloan.inventory.v2');
      expect(storage).not.toHaveBeenCalled(); expect(requests.every((r) => !r.auth && !r.session)).toBe(true);
      expect(fixture.calls.every((r) => !/send|sign|estimate/i.test(r.method))).toBe(true);
      console.log(JSON.stringify({ event: 'flashloan.v8.e2e', marker: 'FLV8_MCP_HTTP_E2E', passed: true, consumer_contract: true, no_persistence: true }));
    } finally { await client.close(); worker.stop(); await close(gateway); await close(internal); }
  }, 20000);
  it('cancels dependency work and releases the single public lease', async () => {
    enabled(); const fixture = fixtureV8(); let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    const worker = new ResearchWorker({ repo: {} as Repository, endpoints: { base: 'https://rpc.test' }, deployments: [], publicKey: key, discoveryRegistry: fixture.registry, fetcher: async (_url, init) => { began(); return new Promise<Response>((_resolve, reject) => { const abort = () => reject(new Error('cancelled')); if (init?.signal?.aborted) abort(); else init?.signal?.addEventListener('abort', abort, { once: true }); }); } });
    const abort = new AbortController(), pending = worker.publicDispatch('flashloan_get_watchlist_v1', { network: 'base', seed_tokens: [A8] }, hash('cancel-v8'), abort.signal);
    const rejected = expect(pending).rejects.toMatchObject({ code: 'DEADLINE_OR_CANCELLATION' });
    await started; abort.abort(); await rejected;
    expect((await worker.publicDispatch('flashloan_get_registry_v1', {}, hash('after-cancel-v8'))).ok).toBe(true);
    worker.stop();
    console.log(JSON.stringify({ event: 'flashloan.v8.cancellation', marker: 'FLV8_MCP_CANCELLATION', passed: true }));
  });
});
