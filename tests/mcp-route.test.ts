/**
 * tests/mcp-route.test.ts
 * -----------------------
 * Integration tests for the gateway middleware pipeline (auth → metering →
 * tool dispatch) and the 3-layer auth gate. Mock-first, DB-optional.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { authenticate } from '@/lib/mcp/auth';
import { callTool, listTools } from '@/lib/mcp/gateway';
import { settlePayment } from '@/lib/mcp/paywall';
import { _resetTools } from '@/lib/mcp/tools';

function req(headers: Record<string, string>): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}

beforeEach(() => {
  _resetTools();
  delete process.env.DATABASE_URL;
  process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
  process.env.FEATURE_MCP_NEWS_V1 = 'true';
  delete process.env.FEATURE_MCP_AUTH_WORKOS;
  delete process.env.HYPERMOVE_MCP_ADMIN_TOKEN;
  delete process.env.HYPERMOVE_DEV_UNAUTHENTICATED;
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
