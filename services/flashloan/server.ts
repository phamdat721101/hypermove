import { createServer, type IncomingMessage } from 'node:http';
import { parseDiscoveryRegistry } from '../../src/lib/mcp/flashloan/discovery-registry';
import { v8Enabled } from '../../src/lib/mcp/flashloan/v8-contracts';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ResearchWorker } from '../../src/lib/mcp/flashloan/worker';
import { PostgresRepository, PostgresV4InitializeIndex } from '../../src/lib/mcp/flashloan/storage';
import { suiDeploymentSchema } from '../../src/lib/mcp/flashloan/sui-contracts';
import { researchEvidenceSchema } from '../../src/lib/mcp/flashloan/verification';
import { deploymentSchema } from '../../src/lib/mcp/flashloan/evm';
import { errorResult, operationSchemas, ResearchError, VERSION, type Operation } from '../../src/lib/mcp/flashloan/contracts';
import { closeResearchPool } from '../../src/lib/db';
import { PUBLIC_LIMITS, publicSchemas, type PublicOperation } from '../../src/lib/mcp/flashloan/public-contracts';
import { strictJson } from '../../src/lib/mcp/flashloan/transport';
import { FINANCE_OPERATIONS } from '../../src/lib/mcp/flashloan/finance/engine';
import { FinanceError } from '../../src/lib/mcp/flashloan/finance/contracts';

export function createResearchServer(worker: ResearchWorker, token: string) {
  if (token.length < 32) throw new ResearchError('INVALID_WORKER_TOKEN', 'Worker token must contain at least 32 characters.');
  const expected = Buffer.from('Bearer ' + token);
  return createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    res.setHeader('x-flashloan-research-version', VERSION); res.setHeader('cache-control', 'no-store');
    const controller = new AbortController();
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnected);
    try {
      const auth = Buffer.from(req.headers.authorization ?? '');
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { res.writeHead(401); res.end(JSON.stringify({ ok: false, error: { code: 'AUTH_REQUIRED', message: 'Worker authentication required.', retryable: false } })); return; }
      if (req.url === '/health' && req.method === 'GET') { res.end(JSON.stringify({ ok: true, data: worker.capabilities() })); return; }
      if (req.method !== 'POST' || !['/research', '/research/public', ...(worker.finance ? ['/research/finance'] : [])].includes(req.url ?? '')) { res.writeHead(404); res.end(JSON.stringify({ ok: false })); return; }
      if (req.headers['x-flashloan-research-version'] && req.headers['x-flashloan-research-version'] !== VERSION) throw new ResearchError('WORKER_VERSION', 'Gateway and worker versions differ.');
      if (req.url === '/research/finance') {
        const envelope = z.object({ owner: z.string().min(1).max(256), operation: z.enum(FINANCE_OPERATIONS), input: z.unknown() }).strict().parse(await readBody(req, 300_000, true));
        const data = await worker.finance!.dispatch(envelope.owner, envelope.operation, envelope.input, controller.signal);
        if (!res.destroyed) res.end(JSON.stringify({ ok: true, data }));
        return;
      }
      const raw = await readBody(req, req.url === '/research/public' ? PUBLIC_LIMITS.body_bytes : 1_000_000);
      if (req.url === '/research/public') {
        const envelope = z.object({ operation: z.enum(Object.keys(publicSchemas) as [PublicOperation, ...PublicOperation[]]), input: z.unknown(), admission_key: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(raw);
        const data = await worker.publicDispatch(envelope.operation, envelope.input, envelope.admission_key, controller.signal);
        if (!res.destroyed) res.end(JSON.stringify({ ok: true, data }));
        return;
      }
      const envelope = z.object({ owner: z.string().min(1).max(256), operation: z.enum(Object.keys(operationSchemas) as [Operation, ...Operation[]]), input: z.unknown() }).strict().parse(raw);
      const data = await worker.dispatch(envelope.owner, envelope.operation, envelope.input);
      res.end(JSON.stringify({ ok: true, data }));
    } catch (e) {
      if (!res.destroyed) {
        res.writeHead(e instanceof ResearchError && e.code === 'RATE_LIMITED' ? 429 : e instanceof ResearchError && e.code === 'CAPACITY_EXCEEDED' ? 503 : e instanceof ResearchError && e.code === 'NOT_FOUND' ? 404 : 400);
        res.end(JSON.stringify({ ok: false, error: e instanceof FinanceError ? { code: e.code, message: e.recovery, retryable: e.retryable } : e instanceof z.ZodError ? { code: 'INVALID_INPUT', message: 'Invalid research input.', retryable: false } : errorResult(e) }));
      }
    } finally {
      res.removeListener('close', disconnected);
    }
  });
}
async function readBody(request: IncomingMessage, maxBytes: number, strict = false) {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > maxBytes) throw new ResearchError('INPUT_BUDGET', 'Input exceeds its byte budget.'); chunks.push(Buffer.from(chunk)); }
  try { const body = Buffer.concat(chunks); return strict || process.env.FLASHLOAN_CANDIDATE_RESEARCH_V2 === 'true' || process.env.FLASHLOAN_POOL_RESOLUTION_V1 === 'true' || v8Enabled('INVENTORY_V3') || v8Enabled('MOVERS_V2') || v8Enabled('REGISTRY_V1') ? strictJson(new TextDecoder('utf-8', { fatal: true }).decode(body)) : JSON.parse(body.toString('utf8')); } catch { throw new ResearchError('INVALID_INPUT', 'Expected unambiguous JSON request.'); }
}
export async function startResearchServer() {
  const root = resolve(process.env.FLASHLOAN_DATA_DIR ?? 'services/flashloan/data');
  const deployments = z.array(deploymentSchema).parse(JSON.parse(process.env.FLASHLOAN_DEPLOYMENTS ?? '[]'));
  const discoveryRegistry = (v8Enabled('INVENTORY_V3') || v8Enabled('MOVERS_V2') || v8Enabled('REGISTRY_V1') || process.env.FLASHLOAN_POOL_RESOLUTION_V1 === 'true' || process.env.FLASHLOAN_ARB_GT_V1 === 'true' || process.env.FLASHLOAN_ARB_UNIVERSE_V1 === 'true') ? parseDiscoveryRegistry(process.env.FLASHLOAN_DISCOVERY_REGISTRY) : undefined;
  if (discoveryRegistry) for (const [network, config] of Object.entries(discoveryRegistry.config.networks)) for (const venue of config.venues.filter((v) => v.family === 'V4' && v.status === 'reviewed')) {
    if (!deployments.some((d) => d.network === network && d.address === venue.factory)) deployments.push(deploymentSchema.parse({ network, address: venue.factory, adapter: 'UNISWAP_V4', code_hash: venue.factory_code_hash, state_view: venue.state_view, state_view_code_hash: venue.state_view_code_hash, initialization_block: venue.initialization_block, version: discoveryRegistry.version }));
  }
  const endpoints = Object.fromEntries((['ethereum', 'arbitrum', 'base', 'robinhood', 'xrpl'] as const).flatMap((network) => { const url = process.env[`FLASHLOAN_${network.toUpperCase()}_RPC_URL`]; return url ? [[network, url]] : []; }));
  const repo = new PostgresRepository(resolve(root, 'artifacts'));
  await repo.recover();
  await repo.prune();
  const publicEnabled = process.env.FEATURE_MCP_FLASHLOAN_PUBLIC_STATELESS === 'true';
  const publicKey = publicEnabled ? process.env.FLASHLOAN_PUBLIC_ARTIFACT_KEY : undefined;
  if (publicEnabled && (!publicKey || Buffer.byteLength(publicKey) < 32)) throw new ResearchError('PUBLIC_UNCONFIGURED', 'Configure the separate public integrity key.');
  const evidence = z.array(researchEvidenceSchema).parse(JSON.parse(process.env.FLASHLOAN_RESEARCH_EVIDENCE ?? '[]'));
  const initializations = z.array(z.object({ network: z.enum(['ethereum', 'arbitrum', 'base', 'robinhood']), manager: z.string().regex(/^0x[0-9a-f]{40}$/), poolId: z.string().regex(/^0x[0-9a-f]{64}$/), blockHash: z.string().regex(/^0x[0-9a-f]{64}$/) }).strict()).max(128).parse(JSON.parse(process.env.FLASHLOAN_INITIALIZATION_LOCATORS ?? '[]'));
  const sui = process.env.FLASHLOAN_SUI_GRAPHQL_URL && process.env.FLASHLOAN_SUI_GRPC_URL && process.env.FLASHLOAN_SUI_CHAIN_IDENTIFIER ? { graphql: process.env.FLASHLOAN_SUI_GRAPHQL_URL, grpc: process.env.FLASHLOAN_SUI_GRPC_URL, chain_identifier: process.env.FLASHLOAN_SUI_CHAIN_IDENTIFIER, deployments: z.array(suiDeploymentSchema).parse(JSON.parse(process.env.FLASHLOAN_SUI_DEPLOYMENTS ?? '[]')) } : undefined;
  // Finance (default off): reuses the same endpoints; Flare is a Finance-only rates endpoint.
  const finance = process.env.FEATURE_MCP_FINANCE_V1 === 'true' ? {
    endpoints: {
      ...endpoints,
      ...(process.env.FINANCE_FLARE_RPC_URL ? { flare: process.env.FINANCE_FLARE_RPC_URL } : {}),
      ...(process.env.FINANCE_XRPL_RPC_URL ? { xrpl: process.env.FINANCE_XRPL_RPC_URL } : {}),
    },
    xrplLoanPay: process.env.FINANCE_XRPL_LOAN_PAY_V1 === 'true',
  } : undefined;
  // File 11 #16: the persistent V4 Initialize index is used only with the ground-truth flag; off keeps request-scoped scans.
  const initializeIndex = process.env.FLASHLOAN_ARB_GT_V1 === 'true' ? new PostgresV4InitializeIndex() : undefined;
  const worker = new ResearchWorker({ repo, endpoints, deployments, evidence, sui, root, publicKey, initializations, discoveryRegistry, finance, ...(initializeIndex ? { initializeIndex } : {}) });
  const server = createResearchServer(worker, process.env.FLASHLOAN_WORKER_TOKEN ?? '');
  server.requestTimeout = 10000; server.headersTimeout = 5000;
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(Number(process.env.FLASHLOAN_WORKER_PORT ?? 3012), '127.0.0.1', done); });
  const timer = setInterval(() => { void worker.tick().catch(() => console.error(JSON.stringify({ event: 'flashloan.worker_queue_error' }))); }, 100);
  const maintenance = setInterval(() => { void repo.prune().catch(() => console.error(JSON.stringify({ event: 'flashloan.worker_maintenance_error' }))); }, 3600000);
  // PRD-C hourly public refresh: last-hour shared ground-truth job per configured network; nothing runs unless both flags are on.
  const groundTruthSchedule = process.env.FLASHLOAN_ARB_GT_V1 === 'true' && process.env.FLASHLOAN_GT_SCHEDULE === '1'
    ? setInterval(() => { void worker.scheduleGroundTruth().catch(() => console.error(JSON.stringify({ event: 'flashloan.gt_schedule_error' }))); }, 3600000) : undefined;
  const shutdown = () => { clearInterval(timer); clearInterval(maintenance); if (groundTruthSchedule) clearInterval(groundTruthSchedule); worker.stop(); server.close(); void closeResearchPool(); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  console.log(JSON.stringify({ event: 'flashloan.worker_started', version: worker.capabilities().version, signing: false }));
  return { server, worker, shutdown };
}
if (process.argv.includes('--serve')) void startResearchServer().catch(() => { console.error('flashloan.worker_start_failed'); process.exitCode = 1; });
