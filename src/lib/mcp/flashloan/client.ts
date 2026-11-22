import { z } from 'zod';
import { operationSchemas, jobSchema, ResearchError, boundaryEvent, VERSION, type Operation } from './contracts';
import { boundedJson } from './transport';
import { assertPublicValue, PUBLIC_LIMITS, publicSchemas, type PublicOperation } from './public-contracts';

export async function researchRequest(owner: string, operation: Operation, raw: unknown): Promise<unknown> {
  if (!owner || owner === 'anonymous') throw new ResearchError('AUTH_REQUIRED', 'Research requires an authenticated session.');
  const input = operationSchemas[operation].parse(raw);
  const data = await workerRequest('/research', { owner, operation, input }, false);
  return operation === 'flashloan_research_job' ? data : jobSchema.parse(data);
}

/** Finance lane: raw input is re-validated by the worker against the canonical contract. */
export async function financeRequest(owner: string, operation: string, raw: unknown): Promise<unknown> {
  if (!owner || owner === 'anonymous') throw new ResearchError('AUTH_REQUIRED', 'Finance requires an authenticated session.');
  return workerRequest('/research/finance', { owner, operation, input: raw }, false);
}

export async function publicResearchRequest(operation: PublicOperation, raw: unknown, admissionKey: string, signal?: AbortSignal) {
  assertPublicValue(raw);
  const input = publicSchemas[operation].parse(raw);
  return workerRequest('/research/public', { operation, input, admission_key: admissionKey }, true, signal);
}

async function workerRequest(path: string, body: unknown, publicMode: boolean, signal?: AbortSignal): Promise<unknown> {
  const base = process.env.FLASHLOAN_WORKER_URL;
  const token = process.env.FLASHLOAN_WORKER_TOKEN;
  if (!base || !token) throw new ResearchError('WORKER_UNCONFIGURED', 'The research worker is not configured.');
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/' || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new ResearchError('WORKER_UNCONFIGURED', 'Worker URL must use HTTPS or loopback HTTP.');
  let response: Response;
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, publicMode ? 65000 : 10000);
  try {
    response = await fetch(new URL(path, base), { method: 'POST', headers: { 'content-type': 'application/json', 'x-flashloan-research-version': VERSION, authorization: `Bearer ${token}` }, body: JSON.stringify(body), signal: controller.signal, redirect: 'error' });
    const result = z.object({ ok: z.boolean(), data: z.unknown().optional(), error: z.object({ code: z.string(), message: z.string(), retryable: z.boolean() }).optional() }).strict().parse(await boundedJson(response, publicMode ? PUBLIC_LIMITS.body_bytes : 1_000_000));
    if (!result.ok) throw new ResearchError(result.error?.code ?? 'RESEARCH_FAILED', result.error?.message ?? 'Research failed.', result.error?.retryable);
    if (response.headers.get('x-flashloan-research-version') !== VERSION) throw new ResearchError('WORKER_VERSION', 'Gateway and worker versions differ; deploy them together.');
    return result.data;
  } catch (e) {
    if (e instanceof ResearchError) throw e;
    boundaryEvent('EDGE-01', 'WORKER_UNAVAILABLE'); throw new ResearchError(signal?.aborted ? 'CANCELLED' : 'WORKER_UNAVAILABLE', publicMode ? 'Public research was interrupted or the worker is unavailable.' : 'The worker is unavailable; retry with the same idempotency key.', true);
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
