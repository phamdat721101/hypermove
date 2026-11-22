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
  /** Calls/time held back from ordinary work so a pending final verification always has capacity. */
  private reserved = { calls: 0, ms: 0 };
  /**
   * Reserve capacity for one final verification step. Ordinary work sees the budget minus every
   * outstanding reservation; `run` releases this lease's share for exactly the verification it guards.
   * Callers must `release()` in `finally` when the guarded step is never reached.
   */
  reserveFinal(calls: number, ms: number) {
    if (!Number.isInteger(calls) || calls < 1 || !(ms > 0)) throw new ResearchError('INVALID_INPUT', 'Final reservation requires positive calls and time.');
    this.reserved = { calls: this.reserved.calls + calls, ms: this.reserved.ms + ms };
    let held = true;
    const release = () => { if (!held) return; held = false; this.reserved = { calls: this.reserved.calls - calls, ms: this.reserved.ms - ms }; };
    return { release, run: async <T>(step: () => Promise<T>): Promise<T> => { if (!held) throw new ResearchError('INVALID_INPUT', 'Final reservation already used.'); release(); return step(); } };
  }
  remainingMs() { return Math.max(0, this.deadline - performance.now() - this.reserved.ms); }
  check() {
    if (this.remainingMs() <= 0) throw new ResearchError('ROUND_DEADLINE', 'Round deadline exhausted.');
    if (this.signal.aborted) throw new ResearchError('CANCELLED', 'Round cancelled.');
  }
  rpc() { this.check(); if (this.rpcCallsUsed >= this.limits.maxRpcCalls - this.reserved.calls) throw new ResearchError('RESOLUTION_BUDGET', 'Round RPC budget exhausted.'); this.rpcCallsUsed++; }
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
export type TopicLog = { address: string; topics: string[]; data: string; blockNumber: string; blockHash: string; transactionHash: string; logIndex: string; transactionIndex?: string; removed?: boolean };
export type BlockRange = { from: string; to: string };
/** Completeness ledger (file 11 #15): every requested block is either completed or failed with a reason, never dropped. */
export type TopicScan<T extends TopicLog = TopicLog> = { requested_ranges: BlockRange[]; completed_ranges: BlockRange[]; failed_ranges: Array<BlockRange & { reason: string }>; logs: T[]; complete: boolean };
/** Shrinkable failures: the provider rejected or could not return this range size (#23 includes JSON-RPC errors). */
const HALVABLE = new Set(['LOG_RESPONSE_BUDGET', 'RESPONSE_TOO_LARGE', 'RPC_METHOD_FAILED', 'RPC_REJECTED']);
/** Round-ending failures: the rest of the request is recorded as failed with this reason. */
const TERMINAL = new Set(['CANCELLED', 'ROUND_DEADLINE', 'RESOLUTION_BUDGET']);
const hex = (n: bigint) => '0x' + n.toString(16);
function mergeRanges<T extends BlockRange>(ranges: T[], same: (a: T, b: T) => boolean = () => true): T[] {
  const out: T[] = [];
  for (const r of ranges) { const last = out[out.length - 1]; if (last && same(last, r) && BigInt(last.to) + 1n === BigInt(r.from)) last.to = r.to; else out.push({ ...r }); }
  return out;
}
/**
 * Chain-wide topic scan with no address (file 11 #15). Pages start at `pageBlocks` and halve on oversized responses or
 * provider range errors down to one block; a block that still fails is recorded in `failed_ranges`. Each page's logs are
 * checked against canonical headers: a log whose blockHash differs marks its whole block failed (BLOCK_REORG).
 * `removed:true` logs are dropped; logs outside the page or not matching the topic filter are provider noise and ignored.
 */
export async function boundedTopicLogs<T extends TopicLog = TopicLog>(rpc: JsonClient, filter: { topics: Array<string | string[] | null>; from: bigint; to: bigint }, budget: RoundBudget, options: { pageBlocks?: number; maxLogsPerPage?: number } = {}): Promise<TopicScan<T>> {
  const initial = BigInt(options.pageBlocks ?? 2000), maxLogs = options.maxLogsPerPage ?? 2000;
  if (filter.from < 0n || filter.to < filter.from || initial < 1n) throw new ResearchError('INVALID_INPUT', 'Topic scan needs a non-empty block range and a positive page size.');
  const scan: TopicScan<T> = { requested_ranges: [{ from: filter.from.toString(), to: filter.to.toString() }], completed_ranges: [], failed_ranges: [], logs: [], complete: false };
  const wanted = filter.topics.map((t) => t === null ? null : new Set((Array.isArray(t) ? t : [t]).map((v) => v.toLowerCase())));
  const matches = (log: T) => wanted.every((set, i) => !set || set.has(String(log.topics?.[i] ?? '').toLowerCase()));
  const canonical = new Map<bigint, string>();
  const headers = async (numbers: bigint[]) => {
    const missing = numbers.filter((n) => !canonical.has(n));
    for (let at = 0; at < missing.length; at += 32) {
      const chunk = missing.slice(at, at + 32);
      const rows = chunk.length === 1 ? [await rpc.rpc<{ hash?: string } | null>('eth_getBlockByNumber', [hex(chunk[0]), false], budget.signal)]
        : await rpc.batch<{ hash?: string } | null>(chunk.map((n) => ({ method: 'eth_getBlockByNumber', params: [hex(n), false] })), budget.signal);
      chunk.forEach((n, i) => { const h = rows[i]?.hash; if (typeof h !== 'string') throw new ResearchError('HEADER_UNAVAILABLE', 'Canonical header missing for block ' + n + '.'); canonical.set(n, h.toLowerCase()); });
    }
  };
  let cursor = filter.from, size = initial, streak = 0, streakCode = '';
  while (cursor <= filter.to) {
    const end = cursor + size - 1n < filter.to ? cursor + size - 1n : filter.to;
    try {
      budget.check();
      const rows = await rpc.rpc<T[]>('eth_getLogs', [{ fromBlock: hex(cursor), toBlock: hex(end), topics: filter.topics }], budget.signal);
      if (!Array.isArray(rows)) throw new ResearchError('INVALID_RESPONSE', 'RPC logs must be an array.');
      if (rows.length > maxLogs) throw new ResearchError('LOG_RESPONSE_BUDGET', 'Log range exceeds its record budget.');
      const kept = rows.filter((l) => l && !l.removed && typeof l.blockNumber === 'string' && typeof l.blockHash === 'string' && BigInt(l.blockNumber) >= cursor && BigInt(l.blockNumber) <= end && matches(l));
      const blocks = [...new Set(kept.map((l) => BigInt(l.blockNumber)))].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      const bad = new Map<bigint, string>();
      try { await headers(blocks); for (const l of kept) if (canonical.get(BigInt(l.blockNumber)) !== l.blockHash.toLowerCase()) bad.set(BigInt(l.blockNumber), 'BLOCK_REORG'); }
      catch (error) { if (error instanceof ResearchError && TERMINAL.has(error.code)) throw error; const code = error instanceof ResearchError ? error.code : 'HEADER_UNAVAILABLE'; for (const n of blocks) if (!canonical.has(n)) bad.set(n, code); }
      for (const l of kept) if (!bad.has(BigInt(l.blockNumber))) scan.logs.push(l);
      let from = cursor;
      for (const [n, reason] of [...bad].sort(([a], [b]) => a < b ? -1 : 1)) {
        if (n > from) scan.completed_ranges.push({ from: from.toString(), to: (n - 1n).toString() });
        scan.failed_ranges.push({ from: n.toString(), to: n.toString(), reason }); from = n + 1n;
      }
      if (from <= end) scan.completed_ranges.push({ from: from.toString(), to: end.toString() });
      cursor = end + 1n; size = size * 2n < initial ? size * 2n : initial; streak = 0;
    } catch (error) {
      const code = error instanceof ResearchError ? error.code : 'INVALID_RESPONSE';
      if (TERMINAL.has(code)) { scan.failed_ranges.push({ from: cursor.toString(), to: filter.to.toString(), reason: code }); break; }
      if (HALVABLE.has(code) && end > cursor) { size = (end - cursor + 2n) / 2n; continue; }
      // A provider that refuses even single blocks repeatedly (e.g. HTTP 403 archive gate) fails the remainder at once
      // rather than crawling block by block through the budget.
      streak = streakCode === code ? streak + 1 : 1; streakCode = code;
      if (streak >= 3 && end < filter.to) { scan.failed_ranges.push({ from: cursor.toString(), to: filter.to.toString(), reason: code }); break; }
      scan.failed_ranges.push({ from: cursor.toString(), to: end.toString(), reason: code });
      cursor = end + 1n;
    }
  }
  scan.logs.sort((a, b) => { const d = BigInt(a.blockNumber) - BigInt(b.blockNumber); return d !== 0n ? (d < 0n ? -1 : 1) : Number(BigInt(a.logIndex) - BigInt(b.logIndex)); });
  scan.completed_ranges = mergeRanges(scan.completed_ranges);
  scan.failed_ranges = mergeRanges(scan.failed_ranges, (a, b) => a.reason === b.reason);
  scan.complete = scan.failed_ranges.length === 0;
  return scan;
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
