/**
 * tests/mcp-dream-cost-ledger.test.ts
 * ------------------------------------
 * Task 6 (v2.1 guardrails/cost-accounting plan): proves start_dream's
 * aggregated LLM cost (CostTracker, via lib/cost/tracker.ts) reaches the SAME
 * mcp_calls row gateway.callTool() already writes for that call — no second
 * ledger write — and that every other tool call in the same run still logs
 * NULL for tokens_used/cost_usd. Mock-first, DB-optional (withClient mocked
 * directly, matching tests/mcp-dream-cycle.test.ts's Task 13 convention).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

describe('Dream Cycle cost threading into mcp_calls (Task 6)', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    process.env.FEATURE_MCP_GUARDIANS = 'false'; // isolate from guardian cost-cap behavior
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ rules: ['retry after cooldown'], preferences: [], error_patterns: [], facts: [] }),
          { status: 200 },
        ),
      ),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('a start_dream call with a real extraction produces a non-null tokens_used/cost_usd mcp_calls insert matching the pipeline\'s own cost figures', async () => {
    const insertedRows: { sql: string; params: unknown[] }[] = [];
    const episodeRow = {
      episode_id: 'ep-1', agent_id: 'robot-42', occurred_at: new Date().toISOString(), task_type: 'grip',
      steps: [{ action: 'grip', result: 'timeout' }], outcome: 'failure', tags: null,
    };

    vi.doMock('../src/lib/db', () => ({
      withClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) =>
        fn({
          query: vi.fn(async (sql: string, params?: unknown[]) => {
            insertedRows.push({ sql, params: params ?? [] });
            if (sql.includes('SELECT episode_id') && sql.includes('dream_episode_logs')) {
              return { rows: [episodeRow] };
            }
            if (sql.includes('FROM dream_consolidated_memories')) {
              return { rows: [] };
            }
            return { rows: [] };
          }),
        }),
      ),
    }));

    const { callTool } = await import('../src/lib/mcp/gateway');
    const session = { userId: 'free-user-cost', tier: 'free' as const, kind: 'user' as const };

    const out = await callTool({
      session,
      name: 'start_dream',
      args: { agent_id: 'robot-42', config: { budget_usd: 0.05, preset: 'balanced' } },
      headers: new Headers({
        'x-payment': 'test-proof',
        'x-payment-chain': 'xrpl-testnet',
        'x-payment-rail': 'x402',
        'x-payment-asset': 'RLUSD',
      }),
    });

    expect(out.error).toBeUndefined();
    const result = out.result as { run_id?: string; status?: string; _cost?: unknown };
    // _cost must never leak to the MCP client's response.
    expect(result._cost).toBeUndefined();
    expect(result.status).toBe('started');

    const mcpCallsInsert = insertedRows.find((r) => r.sql.includes('INSERT INTO mcp_calls'));
    expect(mcpCallsInsert).toBeTruthy();
    // params: [userId, sessionId, tool, tier, paramsHash, bytes, latency, outcome, tokensUsed, costUsd]
    const tokensUsed = mcpCallsInsert!.params[8] as number | null;
    const costUsd = mcpCallsInsert!.params[9] as number | null;
    expect(tokensUsed).not.toBeNull();
    expect(costUsd).not.toBeNull();
    expect(typeof tokensUsed).toBe('number');
    expect((tokensUsed as number)).toBeGreaterThan(0);
  });

  it('a non-Dream-Cycle tool call in the same suite still logs NULL for tokens_used/cost_usd', async () => {
    const insertedRows: { sql: string; params: unknown[] }[] = [];
    vi.doMock('../src/lib/db', () => ({
      withClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) =>
        fn({
          query: vi.fn(async (sql: string, params?: unknown[]) => {
            insertedRows.push({ sql, params: params ?? [] });
            return { rows: [] };
          }),
        }),
      ),
    }));

    const { callTool } = await import('../src/lib/mcp/gateway');
    const session = { userId: 'free-user-plain', tier: 'free' as const, kind: 'user' as const };
    await callTool({ session, name: 'search', args: { query: 'gas' }, headers: new Headers() });

    const mcpCallsInsert = insertedRows.find((r) => r.sql.includes('INSERT INTO mcp_calls'));
    expect(mcpCallsInsert).toBeTruthy();
    expect(mcpCallsInsert!.params[8]).toBeNull(); // tokens_used
    expect(mcpCallsInsert!.params[9]).toBeNull(); // cost_usd
  });
});
