import { describe, it, expect, beforeEach, vi } from 'vitest';

describe('start_dream quote-bound payment handling', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
    process.env.FEATURE_MCP_AUTH_WORKOS = 'true';
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    process.env.FEATURE_MCP_PAYWALL = 'true';
    process.env.FEATURE_MCP_DREAM_PAYMENT_BINDING = 'true';
    vi.doMock('../src/lib/db', () => ({
      withClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
    }));
  });

  it('issues a Dream quote for an unpaid call', async () => {
    vi.doMock('../src/lib/mcp/paywall', async () => {
      const actual = await vi.importActual<typeof import('../src/lib/mcp/paywall')>('../src/lib/mcp/paywall');
      return {
        ...actual,
        findActiveSession: vi.fn(async () => null),
        consumeSession: vi.fn(async () => false),
        issuePaymentQuote: vi.fn(async () => ({ ok: true, quote: { quoteId: 'q-1', tier: 'dream', agentId: 'robot-42', amount: '0.05' } })),
      };
    });
    const { callTool } = await import('../src/lib/mcp/gateway');
    const out = await callTool({ session: { userId: 'unpaid-user', tier: 'free', kind: 'user' }, name: 'start_dream', args: { agent_id: 'robot-42', config: { budget_usd: 0.05 } }, headers: new Headers() });
    expect(out.error?.code).toBe(-32402);
    const data = out.error?.data as { payment?: { quoteId?: string }; retry_with_quote?: string };
    expect(data.payment?.quoteId).toBe('q-1');
    expect(data.retry_with_quote).toContain('X-Payment-Quote-Id');
  });

  it('settles the exact user, Dream-tier, agent-bound quote before dispatching', async () => {
    const settleQuote = vi.fn(async (userId: string, quoteId: string, proof: string | undefined, expected: unknown) => {
      expect(userId).toBe('paid-user');
      expect(quoteId).toBe('q-123');
      expect(proof).toBe(JSON.stringify({ txHash: '59B4F5A720E3657AA01BE4A5766BD4658EAEAC9E2CDFA8089DF734483BAF5ECF' }));
      expect(expected).toEqual({ tier: 'dream', agentId: 'robot-42' });
      return { ok: true, session: { sessionId: 'sess-123', tier: 'dream', chain: 'xrpl-testnet', quotaRemaining: 50 } };
    });
    vi.doMock('../src/lib/mcp/paywall', async () => {
      const actual = await vi.importActual<typeof import('../src/lib/mcp/paywall')>('../src/lib/mcp/paywall');
      return { ...actual, findActiveSession: vi.fn(async () => null), consumeSession: vi.fn(async () => false), settleQuote, settlePayment: vi.fn() };
    });
    const { callTool } = await import('../src/lib/mcp/gateway');
    const headers = new Headers({
      'x-payment-quote-id': 'q-123',
      'x-payment': JSON.stringify({ txHash: '59B4F5A720E3657AA01BE4A5766BD4658EAEAC9E2CDFA8089DF734483BAF5ECF' }),
      'x-payment-chain': 'xrpl-testnet',
      'x-payment-asset': 'RLUSD',
    });
    const out = await callTool({ session: { userId: 'paid-user', tier: 'free', kind: 'user' }, name: 'start_dream', args: { agent_id: 'robot-42', config: { budget_usd: 0.05 } }, headers });
    expect(out.error).toBeUndefined();
    expect(out.result).toBeTruthy();
    expect(settleQuote).toHaveBeenCalledTimes(1);
  });

  it('rejects an invalid or mismatched quote without falling back to unbound settlement', async () => {
    vi.doMock('../src/lib/mcp/paywall', async () => {
      const actual = await vi.importActual<typeof import('../src/lib/mcp/paywall')>('../src/lib/mcp/paywall');
      return {
        ...actual,
        findActiveSession: vi.fn(async () => null),
        consumeSession: vi.fn(async () => false),
        settleQuote: vi.fn(async () => ({ ok: false, error: 'payment quote is bound to a different agent_id' })),
        settlePayment: vi.fn(async () => ({ ok: true })),
      };
    });
    const { callTool } = await import('../src/lib/mcp/gateway');
    const out = await callTool({
      session: { userId: 'paid-user', tier: 'free', kind: 'user' }, name: 'start_dream', args: { agent_id: 'robot-42', config: { budget_usd: 0.05 } },
      headers: new Headers({ 'x-payment-quote-id': 'other-agent-quote', 'x-payment': 'proof' }),
    });
    expect(out.error?.code).toBe(-32402);
    expect((out.error?.data as { error?: string }).error).toMatch(/different agent_id/);
  });

  it('retains direct proof settlement when Dream binding is disabled', async () => {
    process.env.FEATURE_MCP_DREAM_PAYMENT_BINDING = 'false';
    vi.doMock('../src/lib/mcp/paywall', async () => {
      const actual = await vi.importActual<typeof import('../src/lib/mcp/paywall')>('../src/lib/mcp/paywall');
      return {
        ...actual,
        findActiveSession: vi.fn(async () => null),
        consumeSession: vi.fn(async () => false),
        settlePayment: vi.fn(async () => ({ ok: true, session: { sessionId: 'legacy-session', tier: 'dream', chain: 'xrpl-testnet', quotaRemaining: 50 } })),
      };
    });
    const { callTool } = await import('../src/lib/mcp/gateway');
    const out = await callTool({ session: { userId: 'legacy-user', tier: 'free', kind: 'user' }, name: 'start_dream', args: { agent_id: 'robot-42', config: { budget_usd: 0.05 } }, headers: new Headers({ 'x-payment': 'legacy-proof' }) });
    expect(out.error).toBeUndefined();
  });
});
