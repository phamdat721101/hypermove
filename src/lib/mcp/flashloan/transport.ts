import { ResearchError, boundaryEvent } from './contracts';

/** A round owns its counters and monotonic deadline; retries never replenish them. */
export class RoundBudget {
  readonly started = performance.now();
  readonly deadline: number;
  rpcCallsUsed = 0;
  evaluationsUsed = 0;
  readonly signal: AbortSignal;
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly abort: () => void;
  constructor(readonly limits: { maxRpcCalls: number; maxEvaluations: number; deadlineMs: number }, private readonly parent: AbortSignal) {
    this.deadline = this.started + limits.deadlineMs;
    const controller = new AbortController(); this.signal = controller.signal;
    this.abort = () => controller.abort();
    parent.addEventListener('abort', this.abort, { once: true });
    if (parent.aborted) this.abort();
    this.timer = setTimeout(this.abort, Math.max(1, Math.ceil(limits.deadlineMs)));
    this.timer.unref?.();
  }
  dispose() { clearTimeout(this.timer); this.parent.removeEventListener('abort', this.abort); }
  remainingMs() { return Math.max(0, this.deadline - performance.now()); }
  check() {
    if (this.remainingMs() <= 0) throw new ResearchError('ROUND_DEADLINE', 'Round deadline exhausted.');
    if (this.signal.aborted) throw new ResearchError('CANCELLED', 'Round cancelled.');
  }
  rpc() { this.check(); if (this.rpcCallsUsed >= this.limits.maxRpcCalls) throw new ResearchError('RESOLUTION_BUDGET', 'Round RPC budget exhausted.'); this.rpcCallsUsed++; }
  evaluations(count: number) { this.check(); if (!Number.isInteger(count) || count < 0 || this.evaluationsUsed + count > this.limits.maxEvaluations) throw new ResearchError('EVALUATION_BUDGET', 'Round evaluation budget exhausted.'); this.evaluationsUsed += count; }
}

/** Explicit network adapter: no endpoints or RPC method names come from tool input. */
export class JsonClient {
  private nextId = 0;
  constructor(readonly url: string, private readonly fetcher: typeof fetch = fetch, readonly timeoutMs = 15000, private readonly budget?: RoundBudget) {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.hash || (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)))) throw new ResearchError('INVALID_ENDPOINT', 'Endpoint requires verified HTTPS or explicit loopback HTTP.');
  }
  async request(body: unknown, signal?: AbortSignal): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      this.budget?.rpc();
      const timeout = AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(this.timeoutMs, this.budget?.remainingMs() ?? Infinity))));
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
        return await boundedJson(response, 8_000_000, controller.signal);
      } catch (e) {
        if (signal?.aborted) { this.budget?.check(); throw new ResearchError('CANCELLED', 'Research cancelled.'); }
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
  async batch<T>(calls: Array<{ method: string; params: unknown[] }>, signal?: AbortSignal): Promise<T[]> {
    if (!calls.length) return [];
    if (calls.length > 32) throw new ResearchError('INPUT_BUDGET', 'RPC batch exceeds 32 subcalls.');
    const requests = calls.map((call) => ({ jsonrpc: '2.0', id: ++this.nextId, ...call }));
    const raw = await this.request(requests, signal) as Array<{ id: number; result?: T; error?: unknown }>;
    if (!Array.isArray(raw) || raw.length !== requests.length || new Set(raw.map((r) => r.id)).size !== requests.length) throw new ResearchError('RPC_METHOD_FAILED', 'Incomplete or duplicate RPC batch responses.');
    return requests.map((request) => { const response = raw.find((r) => r.id === request.id); if (!response || response.error || response.result === undefined) throw new ResearchError('RPC_METHOD_FAILED', 'Required RPC batch subcall failed.'); return response.result; });
  }
}
export async function boundedBody(response: Response, maxBytes: number, signal?: AbortSignal): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new ResearchError('INVALID_RESPONSE', 'Empty dependency response.');
  const chunks: Uint8Array[] = []; let bytes = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new ResearchError('CANCELLED', 'Response read cancelled.');
    for (;;) { const { done, value } = await reader.read(); if (signal?.aborted) throw new ResearchError('CANCELLED', 'Response read cancelled.'); if (done) break; bytes += value.byteLength; if (bytes > maxBytes) throw new ResearchError('RESPONSE_TOO_LARGE', 'Dependency response exceeded its byte budget.'); chunks.push(value); }
    return Buffer.concat(chunks);
  } catch (e) { if (e instanceof ResearchError) throw e; throw new ResearchError('INVALID_RESPONSE', 'Interrupted dependency response.'); }
  finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => undefined); }
}
/** Address-only log scans tolerate providers ignoring topics; callers still validate every returned log. */
export async function boundedEvmLogs<T>(rpc: JsonClient, filter: { address: string; fromBlock?: string; toBlock?: string; blockHash?: string }, signal: AbortSignal, depth = 0): Promise<T[]> {
  try {
    const rows = await rpc.rpc<T[]>('eth_getLogs', [filter], signal);
    if (!Array.isArray(rows)) throw new ResearchError('INVALID_RESPONSE', 'RPC logs must be an array.');
    if (rows.length > 2000) throw new ResearchError('LOG_RESPONSE_BUDGET', 'Log range exceeds its record budget.');
    return rows;
  } catch (error) {
    if (!(error instanceof ResearchError) || !['LOG_RESPONSE_BUDGET', 'RESPONSE_TOO_LARGE'].includes(error.code) || depth >= 4 || !filter.fromBlock || !filter.toBlock || BigInt(filter.fromBlock) >= BigInt(filter.toBlock)) throw error;
    const start = BigInt(filter.fromBlock), end = BigInt(filter.toBlock), middle = (start + end) / 2n;
    const left = await boundedEvmLogs<T>(rpc, { ...filter, toBlock: '0x' + middle.toString(16) }, signal, depth + 1);
    const right = await boundedEvmLogs<T>(rpc, { ...filter, fromBlock: '0x' + (middle + 1n).toString(16) }, signal, depth + 1);
    if (left.length + right.length > 4000) throw new ResearchError('LOG_RESPONSE_BUDGET', 'Split log range exceeds its aggregate budget.');
    return [...left, ...right];
  }
}
/** Detect duplicate object keys before JSON.parse can erase the conflicting bytes. */
export function strictJson(text: string): unknown {
  const objects: Array<Set<string> | null> = [];
  for (let at = 0; at < text.length; at++) {
    const c = text[at];
    if (c === '{' || c === '[') { if (objects.length >= 40) throw new ResearchError('INPUT_BUDGET', 'JSON nesting exceeds the public budget.'); objects.push(c === '{' ? new Set() : null); }
    else if (c === '}' || c === ']') objects.pop();
    else if (c === '"') {
      const start = at++;
      while (at < text.length && text[at] !== '"') { if (text[at] === '\\') at++; at++; }
      const value: string = JSON.parse(text.slice(start, at + 1));
      for (let i = 0; i < value.length; i++) {
        const code = value.charCodeAt(i);
        if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(++i); if (!(next >= 0xdc00 && next <= 0xdfff)) throw new ResearchError('INVALID_INPUT', 'Unpaired Unicode surrogate.'); }
        else if (code >= 0xdc00 && code <= 0xdfff) throw new ResearchError('INVALID_INPUT', 'Unpaired Unicode surrogate.');
      }
      let next = at + 1; while (/\s/.test(text[next] ?? '') && next < text.length) next++;
      const keys = objects[objects.length - 1];
      if (text[next] === ':' && keys) { if (keys.has(value)) throw new ResearchError('INVALID_INPUT', 'Duplicate JSON object key.'); keys.add(value); }
    }
  }
  return JSON.parse(text);
}
export async function boundedJson(response: Response, maxBytes: number, signal?: AbortSignal, strict = false): Promise<unknown> {
  const body = await boundedBody(response, maxBytes, signal);
  try { return strict ? strictJson(new TextDecoder('utf-8', { fatal: true }).decode(body)) : JSON.parse(body.toString('utf8')); }
  catch { throw new ResearchError('INVALID_RESPONSE', 'Malformed dependency JSON.'); }
}
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new ResearchError('CANCELLED', 'Research cancelled.')); return; }
    const abort = () => { clearTimeout(timer); reject(new ResearchError('CANCELLED', 'Research cancelled.')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
