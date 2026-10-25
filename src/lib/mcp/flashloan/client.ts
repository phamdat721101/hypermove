import { z } from 'zod';
import { operationSchemas, jobSchema, ResearchError, boundaryEvent, type Operation } from './contracts';
import { boundedJson } from './transport';

export async function researchRequest(owner: string, operation: Operation, raw: unknown): Promise<unknown> {
  if (!owner || owner === 'anonymous') throw new ResearchError('AUTH_REQUIRED', 'Research requires an authenticated session.');
  const input = operationSchemas[operation].parse(raw);
  const base = process.env.FLASHLOAN_WORKER_URL;
  const token = process.env.FLASHLOAN_WORKER_TOKEN;
  if (!base || !token) throw new ResearchError('WORKER_UNCONFIGURED', 'The research worker is not configured.');
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new ResearchError('WORKER_UNCONFIGURED', 'Worker URL must use HTTPS or loopback HTTP.');
  let response: Response;
  try {
    response = await fetch(new URL('/research', base), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ owner, operation, input }), signal: AbortSignal.timeout(10000), redirect: 'error' });
  } catch { boundaryEvent('EDGE-01', 'WORKER_UNAVAILABLE'); throw new ResearchError('WORKER_UNAVAILABLE', 'The worker is unavailable; retry with the same idempotency key.', true); }
  const result = z.object({ ok: z.boolean(), data: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).optional() }).strict().parse(await boundedJson(response, 1_000_000));
  if (!result.ok) throw new ResearchError(result.error?.code ?? 'RESEARCH_FAILED', result.error?.message ?? 'Research failed.', result.error?.retryable);
  return operation === 'flashloan_research_job' ? result.data : jobSchema.parse(result.data);
}
