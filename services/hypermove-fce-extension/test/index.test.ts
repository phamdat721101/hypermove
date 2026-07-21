import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createApp, loadConfigFromEnv, type RuntimeConfig } from '../src/index.js';
import { toOpHash, encodeGenericAgentTaskMessage, type WireAction, type WireActionResult } from '../src/action-codec.js';
import { OP_TYPE_GENERIC_AGENT_TASK, OP_TYPE_FINANCIAL_ACTION, OP_COMMAND_SEARCH, OP_COMMAND_SWAP } from '../src/config.js';
import type { Hex } from 'viem';

/** Typed response-body helper — avoids `unknown` noise at every call site
 *  under this project's strict tsconfig. */
async function resultOf(res: Response): Promise<WireActionResult> {
  return (await res.json()) as WireActionResult;
}

const CONFIG: RuntimeConfig = {
  hyperMoveBaseUrl: 'https://hypermove.test/api/mcp',
  hyperMoveBearerToken: 'test-token',
  teeSignBaseUrl: 'http://localhost:8888',
};

function buildSearchAction(args: Record<string, unknown> = { query: 'flare', total: 3 }): WireAction {
  const originalMessage = encodeGenericAgentTaskMessage('SEARCH', args);
  return {
    data: {
      id: '0x01' as Hex,
      submissionTag: 'submit',
      message: JSON.stringify({
        opType: toOpHash(OP_TYPE_GENERIC_AGENT_TASK),
        opCommand: toOpHash(OP_COMMAND_SEARCH),
        originalMessage,
      }),
    },
  };
}

function buildFinancialAction(): WireAction {
  const { encodeAbiParameters } = require('viem') as typeof import('viem');
  const originalMessage = encodeAbiParameters(
    [{ name: '', type: 'tuple', components: [{ name: 'action', type: 'string' }, { name: 'amount', type: 'string' }, { name: 'chain', type: 'string' }] }] as const,
    [{ action: 'SWAP', amount: '10', chain: 'coston2' }],
  );
  return {
    data: {
      id: '0x02' as Hex,
      submissionTag: 'submit',
      message: JSON.stringify({ opType: toOpHash(OP_TYPE_FINANCIAL_ACTION), opCommand: toOpHash(OP_COMMAND_SWAP), originalMessage }),
    },
  };
}

/** Routes fetch calls to either the mocked HyperMove endpoint or the mocked
 *  TEE :8888/sign endpoint based on URL, so a single stub covers a full
 *  end-to-end request. */
function stubUpstreams(opts: {
  hyperMove: (body: unknown) => { status: number; json: unknown };
  teeSign?: (body: unknown) => { status: number; json: unknown };
}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (url.includes('localhost:8888')) {
      const r = (opts.teeSign ?? (() => ({ status: 200, json: { message: '0xdigest', signature: '0xsig' } })))(body);
      return { ok: r.status < 300, status: r.status, json: async () => r.json } as Response;
    }
    const r = opts.hyperMove(body);
    return { ok: r.status < 300, status: r.status, json: async () => r.json } as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('loadConfigFromEnv — F005 secret management', () => {
  it('throws a clear error when HYPERMOVE_MCP_ADMIN_TOKEN is unset', () => {
    expect(() => loadConfigFromEnv({} as NodeJS.ProcessEnv)).toThrow(/HYPERMOVE_MCP_ADMIN_TOKEN is not set/);
  });

  it('loads real config when the token is set, with sensible defaults', () => {
    const cfg = loadConfigFromEnv({ HYPERMOVE_MCP_ADMIN_TOKEN: 'tok' } as unknown as NodeJS.ProcessEnv);
    expect(cfg.hyperMoveBearerToken).toBe('tok');
    expect(cfg.hyperMoveBaseUrl).toBe('https://hypermove.xyz/api/mcp');
    expect(cfg.teeSignBaseUrl).toBe('http://localhost:8888');
  });
});

describe('POST /action — happy path (Task 7)', () => {
  it('decodes a SEARCH action, calls HyperMove, signs a commitment, returns status=1', async () => {
    stubUpstreams({
      hyperMove: () => ({ status: 200, json: { jsonrpc: '2.0', id: 1, result: { ok: true, data: { total: 3, nextCursor: '', hits: ['a', 'b', 'c'] } } } }),
    });
    const app = createApp(CONFIG);
    const res = await app.request('/action', { method: 'POST', body: JSON.stringify(buildSearchAction()), headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(200);
    const result = await resultOf(res);
    expect(result.status).toBe(1);
    expect(result.log).toContain('ok');

    const dataJson = JSON.parse(Buffer.from((result.data as string).slice(2), 'hex').toString('utf8'));
    expect(dataJson.data.hits).toEqual(['a', 'b', 'c']);
    expect(dataJson.commitment.scheme).toBe('HYPERMOVE_SEARCH_V1');
    expect(dataJson.tee_signature).toEqual({ message: '0xdigest', signature: '0xsig' });
  });
});

describe('POST /action — soft-empty and error handling (Task 8)', () => {
  it('treats a soft-empty HyperMove response as a SUCCESS ActionResult (status=1)', async () => {
    stubUpstreams({
      hyperMove: () => ({ status: 200, json: { jsonrpc: '2.0', id: 1, result: { ok: false, error: { kind: 'soft-empty', message: 'no results' } } } }),
    });
    const app = createApp(CONFIG);
    const res = await app.request('/action', { method: 'POST', body: JSON.stringify(buildSearchAction()) });
    const result = await resultOf(res);
    expect(result.status).toBe(1); // CRITICAL: soft-empty must never produce status=0
    const dataJson = JSON.parse(Buffer.from((result.data as string).slice(2), 'hex').toString('utf8'));
    expect(dataJson.softEmpty).toBe(true);
  });

  it('treats a real HyperMove error as a FAILURE ActionResult (status=0)', async () => {
    stubUpstreams({
      hyperMove: () => ({ status: 200, json: { jsonrpc: '2.0', id: 1, result: { ok: false, error: { kind: 'error', message: 'upstream exploded' } } } }),
    });
    const app = createApp(CONFIG);
    const res = await app.request('/action', { method: 'POST', body: JSON.stringify(buildSearchAction()) });
    const result = await resultOf(res);
    expect(result.status).toBe(0);
    expect(result.log).toContain('upstream exploded');
  });

  it('never crashes on a HyperMove network failure — returns a structured failure result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const app = createApp(CONFIG);
    const res = await app.request('/action', { method: 'POST', body: JSON.stringify(buildSearchAction()) });
    expect(res.status).toBe(200); // errors are IN the ActionResult, never an HTTP 5xx from this route
    const result = await resultOf(res);
    expect(result.status).toBe(0);
    expect(result.log).toContain('ECONNREFUSED');
  });

  it('returns a well-formed unsupported-op-type result for a garbage OPType, never a 500', async () => {
    const app = createApp(CONFIG);
    const action: WireAction = {
      data: { id: '0x99' as Hex, message: JSON.stringify({ opType: toOpHash('BOGUS'), opCommand: toOpHash('BOGUS'), originalMessage: '0x' }) },
    };
    const res = await app.request('/action', { method: 'POST', body: JSON.stringify(action) });
    expect(res.status).toBe(200);
    const result = await resultOf(res);
    expect(result.status).toBe(0);
    expect(result.log).toContain('unsupported op type');
  });
});

describe('POST /action — FINANCIAL_ACTION honest stub', () => {
  it('never fabricates a settlement — always returns status=0 with the PMW-not-published log', async () => {
    const app = createApp(CONFIG);
    const res = await app.request('/action', { method: 'POST', body: JSON.stringify(buildFinancialAction()) });
    const result = await resultOf(res);
    expect(result.status).toBe(0);
    expect(result.log).toContain('not yet implemented');
    expect(result.log).toContain('PMW');
  });
});

describe('POST /action — F003 payment handling (Task 9)', () => {
  it('AGENT_PASSTHROUGH: packages the 402 challenge into the ActionResult without settling', async () => {
    const challenge = { chains: ['base-mainnet'], amount: '0.01', tier: 't2_realtime' };
    stubUpstreams({
      hyperMove: () => ({ status: 200, json: { jsonrpc: '2.0', id: 1, error: { code: -32402, message: 'Payment required', data: challenge } } }),
    });
    const app = createApp(CONFIG);
    const res = await app.request('/action', { method: 'POST', body: JSON.stringify(buildSearchAction({ query: 'x', payment_mode: 'AGENT_PASSTHROUGH' })) });
    const result = await resultOf(res);
    expect(result.status).toBe(0);
    const dataJson = JSON.parse(Buffer.from((result.data as string).slice(2), 'hex').toString('utf8'));
    expect(dataJson.paymentRequired).toBe(true);
    expect(dataJson.challenge).toEqual(challenge);
  });

  it('TEE_WALLET: returns an honest not-yet-implemented result, never a fabricated tx', async () => {
    const challenge = { chains: ['xrpl-mainnet'], amount: '0.50', tier: 'confidential' };
    stubUpstreams({
      hyperMove: () => ({ status: 200, json: { jsonrpc: '2.0', id: 1, error: { code: -32402, message: 'Payment required', data: challenge } } }),
    });
    const app = createApp(CONFIG);
    const res = await app.request('/action', { method: 'POST', body: JSON.stringify(buildSearchAction({ query: 'x', payment_mode: 'TEE_WALLET' })) });
    const result = await resultOf(res);
    expect(result.status).toBe(0);
    expect(result.log).toContain('not yet implemented');
    expect(result.log).toContain('Protocol Managed Wallets');
    const dataJson = JSON.parse(Buffer.from((result.data as string).slice(2), 'hex').toString('utf8'));
    expect(dataJson.paymentRequired).toBe(true);
    expect(dataJson.challenge).toEqual(challenge);
  });
});

describe('GET /healthz', () => {
  it('responds ok', async () => {
    const app = createApp(CONFIG);
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
  });
});
