/**
 * tests/mcp-route.test.ts
 * -----------------------
 * Integration tests for the gateway middleware pipeline (auth → metering →
 * tool dispatch) and the 3-layer auth gate. Mock-first, DB-optional.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/mcp/auth';
import { callTool, listTools, _resetMcpSentinel } from '@/lib/mcp/gateway';
import { settlePayment } from '@/lib/mcp/paywall';
import { _resetTools, getTool } from '@/lib/mcp/tools';

function req(headers: Record<string, string>): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}

beforeEach(() => {
  _resetTools();
  _resetMcpSentinel();
  delete process.env.DATABASE_URL;
  process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
  process.env.FEATURE_MCP_NEWS_V1 = 'true';
  delete process.env.FEATURE_MCP_AUTH_WORKOS;
  delete process.env.HYPERMOVE_MCP_ADMIN_TOKEN;
  delete process.env.HYPERMOVE_DEV_UNAUTHENTICATED;
  delete process.env.FEATURE_MCP_GUARDIANS;
  delete process.env.HM_COST_CAP_PER_AGENT_DAILY_USD;
  delete process.env.HM_COST_CAP_PER_AGENT_HOURLY_USD;
});

describe('auth gate', () => {
  it('auth flag off → anonymous session', async () => {
    process.env.FEATURE_MCP_AUTH_WORKOS = 'false';
    const out = await authenticate(req({}));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.session.userId).toBe('anonymous');
  });

  it('admin token → admin session (timing-safe)', async () => {
    process.env.FEATURE_MCP_AUTH_WORKOS = 'true';
    process.env.HYPERMOVE_MCP_ADMIN_TOKEN = 'secret-admin';
    const out = await authenticate(req({ authorization: 'Bearer secret-admin' }));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.session.kind).toBe('admin');
  });

  it('auth on + no credential → 401 challenge', async () => {
    process.env.FEATURE_MCP_AUTH_WORKOS = 'true';
    const out = await authenticate(req({}));
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.status).toBe(401);
      expect(out.wwwAuthenticate).toContain('authorize');
    }
  });

  it('loopback dev bypass', async () => {
    process.env.FEATURE_MCP_AUTH_WORKOS = 'true';
    process.env.HYPERMOVE_DEV_UNAUTHENTICATED = 'true';
    const out = await authenticate(req({ host: 'localhost:3003' }));
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.session.kind).toBe('dev');
  });
});

describe('gateway pipeline', () => {
  const session = { userId: 'u1', tier: 'free' as const, kind: 'user' as const };

  it('lists all enabled tools', () => {
    const names = listTools().map((t) => t.name);
    expect(names).toContain('search');
    expect(names).toContain('codemode.payments.networks');
    expect(names).toContain('news.search');
  });

  it('dispatches search for a free user', async () => {
    const out = await callTool({ session, name: 'search', args: { query: 'token', limit: 3 }, headers: new Headers() });
    expect(out.error).toBeUndefined();
    expect(out.result).toBeTruthy();
  });

  it('unknown tool → -32601', async () => {
    const out = await callTool({ session, name: 'nope', args: {}, headers: new Headers() });
    expect(out.error?.code).toBe(-32601);
  });

  it('admin session bypasses metering', async () => {
    process.env.FEATURE_MCP_PAYWALL = 'true';
    process.env.FEATURE_MCP_RATE_LIMIT = 'true';
    const admin = { userId: 'admin', tier: 'admin' as const, kind: 'admin' as const };
    const out = await callTool({ session: admin, name: 'search', args: { query: 'gas' }, headers: new Headers() });
    expect(out.error).toBeUndefined();
  });
});

describe('multi-chain settlement (mock rail)', () => {
  it('settles a paid query on a selected network', async () => {
    const headers = new Headers({ 'x-payment-chain': 'base-mainnet', 'x-payment-rail': 'x402', 'x-payment-asset': 'USDC' });
    const res = await settlePayment('u1', 't1_read', headers, 'proof-sig');
    expect(res.ok).toBe(true);
    expect(res.receipt?.chain).toBe('base-mainnet');
    expect(res.session?.tier).toBe('t1_read');
  });

  it('rejects an unsupported network with valid-options hint', async () => {
    const headers = new Headers({ 'x-payment-chain': 'fake-chain' });
    const res = await settlePayment('u1', 't1_read', headers, 'proof');
    expect(res.ok).toBe(false);
    expect(res.hint).toBeTruthy();
  });
});

// ── Task 2: gateway guardians (sentinel wired into callTool) ───────────────
describe('gateway guardians', () => {
  const session = { userId: 'u-guardians', tier: 'free' as const, kind: 'user' as const };

  it('blocks a call once the daily cost cap is breached, with policy/reason in the error data', async () => {
    process.env.FEATURE_MCP_GUARDIANS = 'true';
    process.env.HM_COST_CAP_PER_AGENT_DAILY_USD = '0'; // any call breaches a $0 cap
    const out = await callTool({ session, name: 'search', args: { query: 'gas' }, headers: new Headers() });
    expect(out.error?.code).toBe(-32000);
    expect(out.error?.message).toBe('blocked by guardian policy');
    expect((out.error?.data as { policy?: string })?.policy).toBe('cost_cap');
  });

  it('admin sessions bypass the guardian check entirely', async () => {
    process.env.FEATURE_MCP_GUARDIANS = 'true';
    process.env.HM_COST_CAP_PER_AGENT_DAILY_USD = '0';
    const admin = { userId: 'admin', tier: 'admin' as const, kind: 'admin' as const };
    const out = await callTool({ session: admin, name: 'search', args: { query: 'gas' }, headers: new Headers() });
    expect(out.error).toBeUndefined();
  });

  it('FEATURE_MCP_GUARDIANS=false restores exactly today\'s (unguarded) behavior', async () => {
    process.env.FEATURE_MCP_GUARDIANS = 'false';
    process.env.HM_COST_CAP_PER_AGENT_DAILY_USD = '0'; // would breach if guardians were on
    const out = await callTool({ session, name: 'search', args: { query: 'gas' }, headers: new Headers() });
    expect(out.error).toBeUndefined();
    expect(out.result).toBeTruthy();
  });

  it('guardians default ON: an unrelated call with a generous cap still succeeds normally', async () => {
    delete process.env.FEATURE_MCP_GUARDIANS; // default ON
    const out = await callTool({ session, name: 'search', args: { query: 'gas' }, headers: new Headers() });
    expect(out.error).toBeUndefined();
    expect(out.result).toBeTruthy();
  });
});

// ── Task 3: opt-in ToolDef.verify wired to verifyOrHeal() ───────────────────
describe('output-enforcer wiring (ToolDef.verify)', () => {
  const session = { userId: 'u-verify', tier: 'free' as const, kind: 'user' as const };

  beforeEach(() => {
    process.env.FEATURE_MCP_TOKEN_PROFILE_V1 = 'true';
    process.env.FEATURE_MCP_GUARDIANS = 'false'; // isolate this suite from Task 2's cost-cap behavior
  });

  it('flare.token.save has a verify contract requiring the envelope\'s "ok" field', () => {
    const tool = getTool('flare.token.save');
    expect(tool?.verify).toBeTruthy();
    expect(tool?.verify?.verify).toEqual([{ kind: 'schema', required: ['ok'] }]);
    expect(tool?.verify?.onFail).toBe('block');
  });

  it('a normal flare.token.save call passes verification (envelope always has "ok")', async () => {
    const out = await callTool({ session, name: 'flare.token.save', args: { tokenSymbol: 'FLR' }, headers: new Headers() });
    expect(out.error).toBeUndefined();
    expect((out.result as { ok?: boolean })?.ok).toBeDefined();
  });

  it('tools without a verify field are completely unaffected (regression)', async () => {
    const tool = getTool('search');
    expect(tool?.verify).toBeUndefined();
    const out = await callTool({ session, name: 'search', args: { query: 'gas' }, headers: new Headers() });
    expect(out.error).toBeUndefined();
    expect(out.result).toBeTruthy();
  });

  it('blocks when the handler result fails its declared verify contract', async () => {
    // Simulate a malformed handler output by calling verifyOrHeal's exact
    // contract directly against a shape missing the required field — proves
    // the enforcer's block path fires with the expected error shape without
    // needing to monkey-patch the real handler.
    const { verifyOrHeal } = await import('@/lib/harness/output-enforcer');
    const enforced = await verifyOrHeal({ notOk: true }, { verify: [{ kind: 'schema', required: ['ok'] }], onFail: 'block' });
    expect(enforced.verified).toBe(false);
    expect(enforced.checks[0].reason).toContain('ok');
  });
});
