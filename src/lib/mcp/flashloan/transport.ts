import { ResearchError, boundaryEvent } from './contracts';

/** Explicit network adapter: no endpoints or RPC method names come from tool input. */
export class JsonClient {
  private nextId = 0;
  constructor(readonly url: string, private readonly fetcher: typeof fetch = fetch, readonly timeoutMs = 15000) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.hash || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)))) throw new ResearchError('INVALID_ENDPOINT', 'Endpoint requires verified HTTPS or explicit loopback HTTP.');
  }
  async request(body: unknown, signal?: AbortSignal): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const controller = new AbortController();
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      timeout.addEventListener('abort', abort, { once: true });
      try {
        const response = await this.fetcher(this.url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
        if (response.status === 429 || response.status >= 500) {
          if (attempt === 2) throw new ResearchError('RPC_UNAVAILABLE', 'RPC retry budget exhausted.', true);
          await delay(Math.min(2000, Number(response.headers.get('retry-after') ?? 0) * 1000 || 100 * 2 ** attempt), signal);
          continue;
        }
        if (!response.ok) throw new ResearchError('RPC_REJECTED', `RPC returned HTTP ${response.status}.`);
        return await boundedJson(response, 8_000_000);
      } catch (e) {
        if (signal?.aborted) throw new ResearchError('CANCELLED', 'Research cancelled.');
        if (timeout.aborted) { boundaryEvent('EDGE-02', 'DEPENDENCY_TIMEOUT'); throw new ResearchError('DEPENDENCY_TIMEOUT', 'RPC exceeded its deadline.', true); }
        if (e instanceof ResearchError) throw e;
        if (attempt === 2) throw new ResearchError('RPC_UNAVAILABLE', 'RPC connection failed.', true);
      } finally {
        signal?.removeEventListener('abort', abort); timeout.removeEventListener('abort', abort);
      }
    }
    throw new ResearchError('RPC_UNAVAILABLE', 'RPC unavailable.', true);
  }
  async rpc<T>(method: string, params: unknown[], signal?: AbortSignal): Promise<T> {
    const result = await this.request({ jsonrpc: '2.0', id: ++this.nextId, method, params }, signal) as { result?: T; error?: { code?: number } };
    if (!result || result.error || result.result === undefined) throw new ResearchError('RPC_METHOD_FAILED', `RPC method ${method} failed (${result?.error?.code ?? 'invalid response'}).`);
    return result.result;
  }
}
export async function boundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ResearchError('INVALID_RESPONSE', 'Empty dependency response.');
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    for (;;) { const { done, value } = await reader.read(); if (done) break; bytes += value.byteLength; if (bytes > maxBytes) throw new ResearchError('RESPONSE_TOO_LARGE', 'Dependency response exceeded its byte budget.'); chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (e) { if (e instanceof ResearchError) throw e; throw new ResearchError('INVALID_RESPONSE', 'Malformed dependency JSON.'); }
  finally { await reader.cancel().catch(() => undefined); }
}
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new ResearchError('CANCELLED', 'Research cancelled.')); return; }
    const abort = () => { clearTimeout(timer); reject(new ResearchError('CANCELLED', 'Research cancelled.')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
