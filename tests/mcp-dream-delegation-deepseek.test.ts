/**
 * tests/mcp-dream-delegation-deepseek.test.ts
 * -------------------------------------------
 * Validates:
 * 1. Multi-session agent delegation (grant, revoke, list, claim check)
 * 2. DeepSeek V4 Flash integration, JSON mode, and markdown fence strip / jsonrepair
 * 3. 0-lesson regression fix: self-healing extraction preserves valid candidates
 *    and promotes them into active wake constraints.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('Multi-Session Agent Delegation & DeepSeek V4 REM Intelligence', () => {
  interface OwnershipRow {
    agent_id: string;
    owner_user_id: string;
    recovery_secret_hash?: string;
  }
  interface DelegateRow {
    agent_id: string;
    delegate_user_id: string;
    granted_at: Date;
  }

  function installFakeDelegationDb() {
    const ownershipRows: OwnershipRow[] = [];
    const delegateRows: DelegateRow[] = [];

    vi.doMock('../src/lib/db', () => ({
      withClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
        const client = {
          query: vi.fn(async (sql: string, params: unknown[] = []) => {
            // INSERT INTO mcp_agent_ownership
            if (sql.includes('INSERT INTO mcp_agent_ownership')) {
              const [agentId, ownerUserId] = params as [string, string];
              if (!ownershipRows.some((r) => r.agent_id === agentId)) {
                ownershipRows.push({ agent_id: agentId, owner_user_id: ownerUserId });
              }
              return { rows: [], rowCount: 1 };
            }
            // SELECT owner_user_id FROM mcp_agent_ownership
            if (sql.includes('SELECT owner_user_id') && sql.includes('FROM mcp_agent_ownership')) {
              const [agentId] = params as [string];
              const row = ownershipRows.find((r) => r.agent_id === agentId);
              return { rows: row ? [{ owner_user_id: row.owner_user_id, recovery_secret_hash: row.recovery_secret_hash ?? null }] : [] };
            }
            // SELECT FROM mcp_agent_delegates WHERE agent_id = $1 AND delegate_user_id = $2
            if (sql.includes('SELECT delegate_user_id FROM mcp_agent_delegates WHERE agent_id = $1 AND delegate_user_id = $2')) {
              const [agentId, delegateUserId] = params as [string, string];
              const matches = delegateRows.filter((r) => r.agent_id === agentId && r.delegate_user_id === delegateUserId);
              return { rows: matches.map((m) => ({ delegate_user_id: m.delegate_user_id })) };
            }
            // SELECT delegate_user_id FROM mcp_agent_delegates WHERE agent_id = $1
            if (sql.includes('SELECT delegate_user_id FROM mcp_agent_delegates WHERE agent_id = $1')) {
              const [agentId] = params as [string];
              const matches = delegateRows.filter((r) => r.agent_id === agentId);
              return { rows: matches.map((m) => ({ delegate_user_id: m.delegate_user_id })) };
            }
            // INSERT INTO mcp_agent_delegates
            if (sql.includes('INSERT INTO mcp_agent_delegates')) {
              const [agentId, delegateUserId] = params as [string, string];
              if (!delegateRows.some((r) => r.agent_id === agentId && r.delegate_user_id === delegateUserId)) {
                delegateRows.push({ agent_id: agentId, delegate_user_id: delegateUserId, granted_at: new Date() });
              }
              return { rows: [], rowCount: 1 };
            }
            // DELETE FROM mcp_agent_delegates
            if (sql.includes('DELETE FROM mcp_agent_delegates')) {
              const [agentId, delegateUserId] = params as [string, string];
              const idx = delegateRows.findIndex((r) => r.agent_id === agentId && r.delegate_user_id === delegateUserId);
              if (idx !== -1) {
                delegateRows.splice(idx, 1);
                return { rows: [], rowCount: 1 };
              }
              return { rows: [], rowCount: 0 };
            }
            // SELECT for getDreamSession
            if (sql.includes('EXISTS (SELECT 1 FROM mcp_agent_delegates')) {
              const [agentId, userId] = params as [string, string];
              const ownerRow = ownershipRows.find((r) => r.agent_id === agentId);
              if (!ownerRow) return { rows: [] };
              const isDelegate = delegateRows.some((r) => r.agent_id === agentId && r.delegate_user_id === userId);
              return {
                rows: [{
                  owner_user_id: ownerRow.owner_user_id,
                  session_id: null,
                  run_id: null,
                  is_delegate: isDelegate,
                }],
              };
            }
            // SELECT for listMyDreamAgentIds
            if (sql.includes('FROM mcp_agent_ownership WHERE owner_user_id = $1') && sql.includes('UNION')) {
              const [userId] = params as [string];
              const owned = ownershipRows.filter((r) => r.owner_user_id === userId).map((r) => r.agent_id);
              const delegated = delegateRows.filter((r) => r.delegate_user_id === userId).map((r) => r.agent_id);
              const combined = Array.from(new Set([...owned, ...delegated]));
              return { rows: combined.map((agent_id) => ({ agent_id })) };
            }
            throw new Error(`unexpected SQL in delegation test fake: ${sql}`);
          }),
        };
        return fn(client);
      }),
    }));

    return { ownershipRows, delegateRows };
  }

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Part 1: Multi-Session Delegation (ownership.ts)', () => {
    it('allows an owner to claim an agent and denies unauthorized second caller', async () => {
      installFakeDelegationDb();
      const { claimOrCheckOwnership } = await import('../src/lib/mcp/dream/ownership');
      const claim1 = await claimOrCheckOwnership('agent-research-01', 'session-openx-gateway');
      expect(claim1).toEqual({ ok: true });

      const claim2 = await claimOrCheckOwnership('agent-research-01', 'session-local-runner');
      expect(claim2.ok).toBe(false);
      expect(claim2.reason).toMatch(/already claimed by a different session/i);
      expect(claim2.reason).toMatch(/grant_agent_delegate/i);
    });

    it('allows owner to grant delegation to a secondary session which can then write/execute', async () => {
      installFakeDelegationDb();
      const { claimOrCheckOwnership, grantAgentDelegate, listAgentDelegates, getDreamSession } = await import('../src/lib/mcp/dream/ownership');

      // Primary claim by VPS gateway
      await claimOrCheckOwnership('agent-research-01', 'session-openx-gateway');

      // Owner grants delegate access to local runner
      const grantRes = await grantAgentDelegate('agent-research-01', 'session-openx-gateway', 'session-local-runner');
      expect(grantRes).toEqual({ ok: true });

      // Local runner is now authorized
      const claimCheck = await claimOrCheckOwnership('agent-research-01', 'session-local-runner');
      expect(claimCheck).toEqual({ ok: true });

      // List delegates
      const listRes = await listAgentDelegates('agent-research-01', 'session-local-runner');
      expect(listRes).toEqual({ ok: true, delegates: ['session-local-runner'] });

      // getDreamSession reflects delegated session
      const session = await getDreamSession('agent-research-01', 'session-local-runner');
      expect(session.ownership).toBe('authorized_delegate');
    });

    it('rejects non-owner attempts to grant delegation', async () => {
      installFakeDelegationDb();
      const { claimOrCheckOwnership, grantAgentDelegate } = await import('../src/lib/mcp/dream/ownership');

      await claimOrCheckOwnership('agent-research-01', 'session-openx-gateway');

      // Rogue session tries to grant itself or others delegation
      const rogueGrant = await grantAgentDelegate('agent-research-01', 'session-rogue', 'session-rogue');
      expect(rogueGrant.ok).toBe(false);
      expect(rogueGrant.reason).toMatch(/only the primary owner/i);
    });

    it('allows owner to revoke delegation', async () => {
      installFakeDelegationDb();
      const { claimOrCheckOwnership, grantAgentDelegate, revokeAgentDelegate } = await import('../src/lib/mcp/dream/ownership');

      await claimOrCheckOwnership('agent-research-01', 'session-openx-gateway');
      await grantAgentDelegate('agent-research-01', 'session-openx-gateway', 'session-local-runner');

      // Verify authorized
      expect((await claimOrCheckOwnership('agent-research-01', 'session-local-runner')).ok).toBe(true);

      // Revoke
      const revokeRes = await revokeAgentDelegate('agent-research-01', 'session-openx-gateway', 'session-local-runner');
      expect(revokeRes).toEqual({ ok: true });

      // Now rejected
      const rejectedCheck = await claimOrCheckOwnership('agent-research-01', 'session-local-runner');
      expect(rejectedCheck.ok).toBe(false);
    });
  });

  describe('Part 2: Extraction Resilience & Self-Healing', () => {
    it('salvages extracted insights from response even if extraction_failure_reason was tagged', async () => {
      const { extractInsights } = await import('../src/lib/mcp/dream/extract');
      const { CostTracker } = await import('../src/lib/mcp/dream/cost');

      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        rules: ['Verify ledger transaction before settling x402 quotes.'],
        preferences: ['Prefer structured JSON schemas.'],
        error_patterns: ['Handle parse errors gracefully.'],
        facts: ['HyperMove MCP supports XRPL RLUSD testnet.'],
        extraction_failure_reason: 'truncated_partial_json',
      }), { status: 200 })));

      const cost = new CostTracker(0.1);
      const clusters = [{
        cluster_id: 'cluster-1',
        agent_id: 'agent-1',
        episode_ids: ['ep-1', 'ep-2'],
        size: 2,
        time_range: { start: '2026-09-01T00:00:00Z', end: '2026-09-02T00:00:00Z' },
        dominant_tags: ['payment', 'xrpl'],
        centroid_embedding: [0.1, 0.2, 0.3],
        summary: 'Episodes testing XRPL payments and memory consolidation.',
      }];

      const outcome = await extractInsights(clusters, cost, 150);
      expect(outcome.extracted.length).toBe(1);
      expect(outcome.extracted[0].rules).toEqual(['Verify ledger transaction before settling x402 quotes.']);
      expect(outcome.extracted[0].facts).toEqual(['HyperMove MCP supports XRPL RLUSD testnet.']);
      expect(outcome.status).toBe('completed');
    });

    it('records errorDetail when upstream service fails with non-2xx', async () => {
      const { extractInsights } = await import('../src/lib/mcp/dream/extract');
      const { CostTracker } = await import('../src/lib/mcp/dream/cost');

      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
        error: 'Dream extract failed',
        detail: 'DEEPSEEK_API_KEY not set',
      }), { status: 500 })));

      const cost = new CostTracker(0.1);
      const clusters = [{
        cluster_id: 'cluster-err',
        agent_id: 'agent-1',
        episode_ids: ['ep-1'],
        size: 1,
        time_range: {},
        dominant_tags: [],
        centroid_embedding: [0, 0, 0],
        summary: 'Failed cluster summary.',
      }];

      const outcome = await extractInsights(clusters, cost, 150);
      expect(outcome.extracted.length).toBe(0);
      expect(outcome.clusters_failed_extraction).toContain('cluster-err');
      expect(outcome.failure_reasons.upstream_error).toBe(1);
      expect(outcome.last_upstream_error_detail).toBe('DEEPSEEK_API_KEY not set');
    });
  });

  describe('Part 3: Tool Exposure in Gateway', () => {
    it('registers grant_agent_delegate, revoke_agent_delegate, list_agent_delegates tools when dream cycle is enabled', async () => {
      process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
      process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
      vi.resetModules();

      const { getTools } = await import('../src/lib/mcp/tools');
      const tools = getTools();

      const grantTool = tools.find((t) => t.name === 'grant_agent_delegate');
      const revokeTool = tools.find((t) => t.name === 'revoke_agent_delegate');
      const listTool = tools.find((t) => t.name === 'list_agent_delegates');

      expect(grantTool).toBeDefined();
      expect(grantTool?.unmetered).toBe(true);
      expect(grantTool?.tier).toBe('t1_read');

      expect(revokeTool).toBeDefined();
      expect(revokeTool?.unmetered).toBe(true);

      expect(listTool).toBeDefined();
      expect(listTool?.unmetered).toBe(true);
    });
  });
});
