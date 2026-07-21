import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { callHyperMoveTool } from '../src/hypermove.client.js';

const BASE_URL = 'https://hypermove.test/api/mcp';
const TOKEN = 'test-admin-token';

function mockFetchOnce(status: number, jsonBody: unknown, ok = status >= 200 && status < 300): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok,
      status,
      json: async () => jsonBody,
    }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('callHyperMoveTool — success paths', () => {
  it('unwraps a ServiceResult{ok:true,data} envelope', async () => {
    mockFetchOnce(200, { jsonrpc: '2.0', id: 1, result: { ok: true, data: { hits: 3 } } });
    const out = await callHyperMoveTool({ tool: 'search', arguments: { q: 'x' }, baseUrl: BASE_URL, bearerToken: TOKEN });
    expect(out).toEqual({ kind: 'ok', data: { hits: 3 } });
  });

  it('passes through a bare (non-enveloped) result object', async () => {
    mockFetchOnce(200, { jsonrpc: '2.0', id: 1, result: { agent: '0xabc', score: 0.9 } });
    const out = await callHyperMoveTool({ tool: 'reputation.read', arguments: {}, baseUrl: BASE_URL, bearerToken: TOKEN });
    expect(out).toEqual({ kind: 'ok', data: { agent: '0xabc', score: 0.9 } });
  });

  it('sends the correct JSON-RPC request shape with bearer auth', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: { ok: true, data: {} } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await callHyperMoveTool({ tool: 'news.search', arguments: { project: 'flare' }, baseUrl: BASE_URL, bearerToken: TOKEN });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(BASE_URL);
    expect(opts.method).toBe('POST');
    expect((opts.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'news.search', arguments: { project: 'flare' } } });
  });
});

describe('callHyperMoveTool — CRITICAL RULE: soft-empty is success, not error', () => {
  it('treats kind:"soft-empty" as ok with null data, never as an error', async () => {
    mockFetchOnce(200, {
      jsonrpc: '2.0',
      id: 1,
      result: { ok: false, error: { service: 'news', kind: 'soft-empty', message: 'no news today' } },
    });
    const out = await callHyperMoveTool({ tool: 'news.digest', arguments: {}, baseUrl: BASE_URL, bearerToken: TOKEN });
    expect(out.kind).toBe('ok');
    if (out.kind === 'ok' && 'softEmpty' in out) {
      expect(out.data).toBeNull();
      expect(out.softEmpty).toBe(true);
      expect(out.message).toBe('no news today');
    } else {
      throw new Error('expected soft-empty variant');
    }
  });
});

describe('callHyperMoveTool — real error (not soft-empty)', () => {
  it('treats kind:"error" as a genuine error', async () => {
    mockFetchOnce(200, {
      jsonrpc: '2.0',
      id: 1,
      result: { ok: false, error: { service: 'search', kind: 'error', message: 'upstream exploded' } },
    });
    const out = await callHyperMoveTool({ tool: 'search', arguments: {}, baseUrl: BASE_URL, bearerToken: TOKEN });
    expect(out).toEqual({ kind: 'error', message: 'upstream exploded', code: undefined });
  });

  it('treats a top-level JSON-RPC error as a genuine error', async () => {
    mockFetchOnce(200, { jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'unknown tool: bogus' } });
    const out = await callHyperMoveTool({ tool: 'bogus', arguments: {}, baseUrl: BASE_URL, bearerToken: TOKEN });
    expect(out).toEqual({ kind: 'error', message: 'unknown tool: bogus', code: -32601 });
  });
});

describe('callHyperMoveTool — 402 payment required', () => {
  it('parses a -32402 JSON-RPC error into a payment_required result with the challenge', async () => {
    const challenge = { 'x-payment-required': { chains: ['base-mainnet'], amount: '0.01', tier: 't2_realtime' } };
    mockFetchOnce(200, {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32402, message: 'Payment required — free tier exceeded', data: challenge },
    });
    const out = await callHyperMoveTool({ tool: 'search', arguments: {}, baseUrl: BASE_URL, bearerToken: TOKEN });
    expect(out.kind).toBe('payment_required');
    if (out.kind === 'payment_required') {
      expect(out.challenge).toEqual(challenge);
      expect(out.message).toContain('Payment required');
    }
  });
});

describe('callHyperMoveTool — network / transport failures', () => {
  it('never throws on a fetch rejection — returns network_error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const out = await callHyperMoveTool({ tool: 'search', arguments: {}, baseUrl: BASE_URL, bearerToken: TOKEN });
    expect(out.kind).toBe('network_error');
    if (out.kind === 'network_error') expect(out.message).toContain('ECONNREFUSED');
  });

  it('never throws on a non-JSON response body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token'); } }),
    );
    const out = await callHyperMoveTool({ tool: 'search', arguments: {}, baseUrl: BASE_URL, bearerToken: TOKEN });
    expect(out.kind).toBe('network_error');
  });

  it('never throws on an HTTP error status', async () => {
    mockFetchOnce(500, { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'internal' } }, false);
    const out = await callHyperMoveTool({ tool: 'search', arguments: {}, baseUrl: BASE_URL, bearerToken: TOKEN });
    expect(out.kind).toBe('network_error');
  });
});
