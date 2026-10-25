import { createServer, type IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ResearchWorker } from '../../src/lib/mcp/flashloan/worker';
import { PostgresRepository } from '../../src/lib/mcp/flashloan/storage';
import { deploymentSchema } from '../../src/lib/mcp/flashloan/evm';
import { errorResult, operationSchemas, ResearchError, type Operation } from '../../src/lib/mcp/flashloan/contracts';
import { closeResearchPool } from '../../src/lib/db';

export function createResearchServer(worker: ResearchWorker, token: string) {
  if (token.length < 32) throw new ResearchError('INVALID_WORKER_TOKEN', 'Worker token must contain at least 32 characters.');
  const expected = Buffer.from('Bearer ' + token);
  return createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store');
    try {
      const auth = Buffer.from(req.headers.authorization ?? '');
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) { res.writeHead(401); res.end(JSON.stringify({ ok: false, error: { code: 'AUTH_REQUIRED', message: 'Worker authentication required.', retryable: false } })); return; }
      if (req.url === '/health' && req.method === 'GET') { res.end(JSON.stringify({ ok: true, data: worker.capabilities() })); return; }
      if (req.url !== '/research' || req.method !== 'POST') { res.writeHead(404); res.end(JSON.stringify({ ok: false })); return; }
      const raw = await readBody(req);
      const envelope = z.object({ owner: z.string().min(1).max(256), operation: z.enum(Object.keys(operationSchemas) as [Operation, ...Operation[]]), input: z.unknown() }).strict().parse(raw);
      const data = await worker.dispatch(envelope.owner, envelope.operation, envelope.input);
      res.end(JSON.stringify({ ok: true, data }));
    } catch (e) {
      res.writeHead(e instanceof z.ZodError ? 400 : e instanceof ResearchError && e.code === 'NOT_FOUND' ? 404 : 400);
      res.end(JSON.stringify({ ok: false, error: e instanceof z.ZodError ? { code: 'INVALID_INPUT', message: 'Invalid research input.', retryable: false } : errorResult(e) }));
    }
  });
}
async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = []; let length = 0;
  for await (const chunk of request) { length += chunk.length; if (length > 1_000_000) throw new ResearchError('INPUT_BUDGET', 'Input exceeds its byte budget.'); chunks.push(Buffer.from(chunk)); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ResearchError('INVALID_INPUT', 'Expected JSON request.'); }
}
export async function startResearchServer() {
  const root = resolve(process.env.FLASHLOAN_DATA_DIR ?? 'services/flashloan/data');
  const deployments = z.array(deploymentSchema).parse(JSON.parse(process.env.FLASHLOAN_DEPLOYMENTS ?? '[]'));
  const endpoints = Object.fromEntries((['ethereum', 'arbitrum', 'base', 'xrpl'] as const).flatMap((network) => { const url = process.env[`FLASHLOAN_${network.toUpperCase()}_RPC_URL`]; return url ? [[network, url]] : []; }));
  const repo = new PostgresRepository(resolve(root, 'artifacts'));
  await repo.recover();
  await repo.prune();
  const worker = new ResearchWorker({ repo, endpoints, deployments, root });
  const server = createResearchServer(worker, process.env.FLASHLOAN_WORKER_TOKEN ?? '');
  server.requestTimeout = 10000; server.headersTimeout = 5000;
  await new Promise<void>((done, reject) => { server.once('error', reject); server.listen(Number(process.env.FLASHLOAN_WORKER_PORT ?? 3012), '127.0.0.1', done); });
  const timer = setInterval(() => { void worker.tick().catch(() => console.error(JSON.stringify({ event: 'flashloan.worker_queue_error' }))); }, 100);
  const maintenance = setInterval(() => { void repo.prune().catch(() => console.error(JSON.stringify({ event: 'flashloan.worker_maintenance_error' }))); }, 3600000);
  const shutdown = () => { clearInterval(timer); clearInterval(maintenance); worker.stop(); server.close(); void closeResearchPool(); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
  console.log(JSON.stringify({ event: 'flashloan.worker_started', version: worker.capabilities().version, signing: false }));
  return { server, worker, shutdown };
}
if (process.argv.includes('--serve')) void startResearchServer().catch(() => { console.error('flashloan.worker_start_failed'); process.exitCode = 1; });
