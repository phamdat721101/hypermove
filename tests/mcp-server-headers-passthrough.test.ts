import { describe, it, expect, vi } from 'vitest';

/**
 * Regression for docs/feedback/2026-08-17-start-dream-retry-with-proof-added-still-fails.md
 *
 * Bug: mcpHttpHandler()'s verifyToken() received the raw incoming `Request`
 * (headers and all) but only ever extracted the session from it before
 * discarding it — the AuthInfo object handed back to the MCP SDK never
 * carried the original headers forward. registerTool()'s per-call handler
 * only receives the SDK's own `extra` (authInfo + requestId, no raw
 * Request), so `callTool()` was ALWAYS invoked with `headers: undefined`,
 * regardless of what a real caller sent on the wire. This made every prior
 * fix to gateway.ts's `headers?.get('x-payment')` check structurally inert
 * in production -- a correctly-shaped x-payment/X-Payment-Chain/
 * X-Payment-Asset header trio could never reach it.
 *
 * Fix: verifyToken() now stashes `req.headers` into `AuthInfo.extra.headers`;
 * registerTool()'s handler reads it back out and threads it into
 * `callTool({ ..., headers })`.
 */
describe('MCP transport threads real request headers into gateway.callTool()', () => {
  it('registerTool passes extra.authInfo.extra.headers through to callTool as the `headers` param', async () => {
    vi.resetModules();
    let capturedHeaders: Headers | undefined;
    vi.doMock('../src/lib/mcp/gateway', () => ({
      callTool: vi.fn(async (input: { headers?: Headers }) => {
        capturedHeaders = input.headers;
        return { result: { ok: true } };
      }),
    }));
    const { registerTool } = await import('../src/lib/mcp/server');
    const { getTool } = await import('../src/lib/mcp/tools');

    const realHeaders = new Headers({
      'x-payment': JSON.stringify({ txHash: '59B4F5A720E3657AA01BE4A5766BD4658EAEAC9E2CDFA8089DF734483BAF5ECF' }),
      'x-payment-quote-id': 'dream-quote-123',
      'x-payment-chain': 'xrpl-testnet',
      'x-payment-asset': 'RLUSD',
    });

    let capturedHandler: ((args: unknown, extra: unknown) => Promise<unknown>) | undefined;
    const fakeServer = { tool: (_name: string, _desc: string, _shape: unknown, handler: (args: unknown, extra: unknown) => Promise<unknown>) => { capturedHandler = handler; } };

    const tool = getTool('get_dream_config')!;
    registerTool(fakeServer as never, tool);

    const extra = { authInfo: { token: 'session', clientId: 'u1', scopes: ['free'], extra: { session: { userId: 'u1', tier: 'free', kind: 'user' }, headers: realHeaders } } };
    await capturedHandler!({ agent_id: 'robot-42' }, extra);

    expect(capturedHeaders).toBe(realHeaders);
    expect(capturedHeaders?.get('x-payment')).toBe(JSON.stringify({ txHash: '59B4F5A720E3657AA01BE4A5766BD4658EAEAC9E2CDFA8089DF734483BAF5ECF' }));
    expect(capturedHeaders?.get('x-payment-chain')).toBe('xrpl-testnet');
    expect(capturedHeaders?.get('x-payment-quote-id')).toBe('dream-quote-123');
  });

  it('falls back to undefined headers gracefully when authInfo carries no headers (unauthenticated/anon path unchanged)', async () => {
    vi.resetModules();
    let capturedHeaders: Headers | undefined;
    vi.doMock('../src/lib/mcp/gateway', () => ({
      callTool: vi.fn(async (input: { headers?: Headers }) => {
        capturedHeaders = input.headers;
        return { result: { ok: true } };
      }),
    }));
    const { registerTool } = await import('../src/lib/mcp/server');
    const { getTool } = await import('../src/lib/mcp/tools');

    let capturedHandler: ((args: unknown, extra: unknown) => Promise<unknown>) | undefined;
    const fakeServer = { tool: (_name: string, _desc: string, _shape: unknown, handler: (args: unknown, extra: unknown) => Promise<unknown>) => { capturedHandler = handler; } };
    const tool = getTool('get_dream_config')!;
    registerTool(fakeServer as never, tool);

    await capturedHandler!({ agent_id: 'robot-42' }, {});
    expect(capturedHeaders).toBeUndefined();
  });
});
