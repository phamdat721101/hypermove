import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Regression test for docs/feedback/2026-08-17-start-dream-payment-proof-never-checked.md
 *
 * Bug: gateway.ts's start_dream metering branch, when
 * isMcpDreamPaymentBindingEnabled() is true, always called issuePaymentQuote()
 * and returned the -32402 challenge unconditionally -- even when the caller
 * already presented a valid `x-payment` proof header. The generic
 * settlePayment(headers, proof) path a few lines below was structurally
 * unreachable for start_dream under this flag.
 *
 * Fix: check `headers.get('x-payment')` first; only fall through to
 * issuePaymentQuote() when there is no proof, or when a presented proof
 * genuinely failed to settle.
 */
describe('start_dream payment-proof handling (dream-payment-binding flag)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    process.env.FEATURE_MCP_PAYWALL = 'true';
    process.env.FEATURE_MCP_DREAM_PAYMENT_BINDING = 'true';
    vi.doMock('../src/lib/db', () => ({
      withClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
    }));
  });

  it('accepts a valid x-payment proof and dispatches start_dream instead of re-issuing a quote challenge', async () => {
    vi.doMock('../src/lib/mcp/paywall', async () => {
      const actual = await vi.importActual<typeof import('../src/lib/mcp/paywall')>('../src/lib/mcp/paywall');
      return {
        ...actual,
        findActiveSession: vi.fn(async () => null),
        consumeSession: vi.fn(async () => false),
        settlePayment: vi.fn(async () => ({ ok: true, session: { sessionId: 'sess-123', tier: 'dream', chain: 'xrpl-testnet', quotaRemaining: 50 } })),
        issuePaymentQuote: vi.fn(async () => {
          throw new Error('issuePaymentQuote must NOT be called when a valid proof is already presented');
        }),
      };
    });
    const { callTool } = await import('../src/lib/mcp/gateway');
    const session = { userId: 'paid-user-dream', tier: 'free' as const, kind: 'user' as const };
    const headers = new Headers({ 'x-payment': JSON.stringify({ txHash: '59B4F5A720E3657AA01BE4A5766BD4658EAEAC9E2CDFA8089DF734483BAF5ECF' }) });
    const out = await callTool({ session, name: 'start_dream', args: { agent_id: 'robot-42', config: { budget_usd: 0.05 } }, headers });
    expect(out.error).toBeUndefined();
    expect(out.result).toBeTruthy();
  });

  it('still returns the -32402 quote challenge when no proof is presented (unpaid path unchanged)', async () => {
    vi.doMock('../src/lib/mcp/paywall', async () => {
      const actual = await vi.importActual<typeof import('../src/lib/mcp/paywall')>('../src/lib/mcp/paywall');
      return {
        ...actual,
        findActiveSession: vi.fn(async () => null),
        consumeSession: vi.fn(async () => false),
        issuePaymentQuote: vi.fn(async () => ({ ok: true, quote: { quoteId: 'q-1', tier: 'dream', amount: 0.05 } })),
      };
    });
    const { callTool } = await import('../src/lib/mcp/gateway');
    const session = { userId: 'unpaid-user-dream', tier: 'free' as const, kind: 'user' as const };
    const out = await callTool({ session, name: 'start_dream', args: { agent_id: 'robot-42', config: { budget_usd: 0.05 } }, headers: new Headers() });
    expect(out.error?.code).toBe(-32402);
    expect((out.error?.data as { payment?: unknown })?.payment).toBeTruthy();
  });

  it('falls back to a fresh quote challenge when a presented proof fails to settle (does not silently 500 or accept garbage proof)', async () => {
    vi.doMock('../src/lib/mcp/paywall', async () => {
      const actual = await vi.importActual<typeof import('../src/lib/mcp/paywall')>('../src/lib/mcp/paywall');
      return {
        ...actual,
        findActiveSession: vi.fn(async () => null),
        consumeSession: vi.fn(async () => false),
        settlePayment: vi.fn(async () => ({ ok: false, error: 'transaction_not_found', hint: 'verify the txHash on-ledger' })),
        issuePaymentQuote: vi.fn(async () => ({ ok: true, quote: { quoteId: 'q-2', tier: 'dream', amount: 0.05 } })),
      };
    });
    const { callTool } = await import('../src/lib/mcp/gateway');
    const session = { userId: 'bad-proof-user', tier: 'free' as const, kind: 'user' as const };
    const headers = new Headers({ 'x-payment': JSON.stringify({ txHash: 'deadbeef' }) });
    const out = await callTool({ session, name: 'start_dream', args: { agent_id: 'robot-42', config: { budget_usd: 0.05 } }, headers });
    expect(out.error?.code).toBe(-32402);
    const data = out.error?.data as { payment?: unknown; error?: string };
    expect(data.payment).toBeTruthy();
    expect(data.error).toBe('transaction_not_found');
  });

  /**
   * Regression for docs/feedback/2026-08-17-start-dream-still-blocked-post-redeploy-followup.md
   * The real-world shape a caller uses: bare `x-payment: {"txHash":"..."}`
   * PLUS the separate `X-Payment-Chain` / `X-Payment-Asset` selector headers
   * (not a proof nested inside a JSON object under those header names, which
   * the follow-up feedback file's own 4th attempt incorrectly guessed).
   */
  it('accepts a real already-submitted-tx-hash proof paired with X-Payment-Chain/X-Payment-Asset selector headers', async () => {
    vi.doMock('../src/lib/mcp/paywall', async () => {
      const actual = await vi.importActual<typeof import('../src/lib/mcp/paywall')>('../src/lib/mcp/paywall');
      return {
        ...actual,
        findActiveSession: vi.fn(async () => null),
        consumeSession: vi.fn(async () => false),
        settlePayment: vi.fn(async (_userId: string, _tier: string, hdrs: Headers, proof?: string) => {
          expect(proof).toBe(JSON.stringify({ txHash: '59B4F5A720E3657AA01BE4A5766BD4658EAEAC9E2CDFA8089DF734483BAF5ECF' }));
          expect(hdrs.get('x-payment-chain')).toBe('xrpl-testnet');
          expect(hdrs.get('x-payment-asset')).toBe('RLUSD');
          return { ok: true, session: { sessionId: 'sess-real-tx', tier: 'dream', chain: 'xrpl-testnet', quotaRemaining: 50 } };
        }),
        issuePaymentQuote: vi.fn(async () => {
          throw new Error('issuePaymentQuote must NOT be called for a genuinely valid, correctly-shaped proof');
        }),
      };
    });
    const { callTool } = await import('../src/lib/mcp/gateway');
    const session = { userId: 'real-tx-user', tier: 'free' as const, kind: 'user' as const };
    const headers = new Headers({
      'x-payment': JSON.stringify({ txHash: '59B4F5A720E3657AA01BE4A5766BD4658EAEAC9E2CDFA8089DF734483BAF5ECF' }),
      'x-payment-chain': 'xrpl-testnet',
      'x-payment-asset': 'RLUSD',
    });
    const out = await callTool({ session, name: 'start_dream', args: { agent_id: 'robot-42', config: { budget_usd: 0.05 } }, headers });
    expect(out.error).toBeUndefined();
    expect(out.result).toBeTruthy();
  });
});
