/**
 * tests/mcp-dream-diagnostics.test.ts
 * --------------------------------------
 * Coverage for src/lib/mcp/dream/diagnostics.ts's getDreamEpisodeDiagnostics()
 * — the new get_dream_episode_diagnostics MCP tool (2026-08-11 status-review
 * upgrade, Task 3 / PRD 02 self-serve diagnostics).
 *
 * Three cases per the plan:
 *   (a) matching agent_id strings on both write and read sides ->
 *       agent_id_exact_match: true
 *   (b) a deliberately mismatched-case/whitespace agent_id inserted
 *       directly into the mock DB -> agent_id_exact_match: false
 *   (c) ownership rejection for a caller who doesn't own the agent_id
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

interface OwnershipRow { agent_id: string; owner_user_id: string; }
interface EpisodeRow { agent_id: string; occurred_at: string; }
interface RunRow { agent_id: string; started_at: string; }

function installFakeDiagnosticsDb() {
  const owners: OwnershipRow[] = [];
  const episodes: EpisodeRow[] = [];
  const runs: RunRow[] = [];

  vi.doMock('../src/lib/db', () => ({
    withClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        if (sql.includes('INSERT INTO mcp_agent_ownership')) {
          const [agentId, ownerUserId] = params as [string, string];
          if (!owners.some((o) => o.agent_id === agentId)) owners.push({ agent_id: agentId, owner_user_id: ownerUserId });
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('SELECT owner_user_id FROM mcp_agent_ownership')) {
          const row = owners.find((o) => o.agent_id === (params[0] as string));
          return { rows: row ? [{ owner_user_id: row.owner_user_id }] : [] };
        }
        if (sql.includes('COUNT(*)::text AS count FROM dream_episode_logs WHERE agent_id = $1 AND consumed_by_run IS NULL')) {
          const agentId = params[0] as string;
          return { rows: [{ count: String(episodes.filter((e) => e.agent_id === agentId).length) }] };
        }
        if (sql.includes('SELECT agent_id, occurred_at::text FROM dream_episode_logs WHERE agent_id ILIKE')) {
          const pattern = (params[0] as string).toLowerCase();
          const matches = episodes.filter((e) => e.agent_id.toLowerCase() === pattern).sort((a, b) => b.occurred_at.localeCompare(a.occurred_at));
          return { rows: matches.length ? [matches[0]] : [] };
        }
        if (sql.includes('SELECT agent_id, started_at::text FROM dream_cycle_runs WHERE agent_id ILIKE')) {
          const pattern = (params[0] as string).toLowerCase();
          const matches = runs.filter((r) => r.agent_id.toLowerCase() === pattern).sort((a, b) => b.started_at.localeCompare(a.started_at));
          return { rows: matches.length ? [matches[0]] : [] };
        }
        return { rows: [] };
      }),
    })),
  }));

  return { owners, episodes, runs };
}

describe('Task 3 (2026-08-11 status-review upgrade) · getDreamEpisodeDiagnostics', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('(a) returns agent_id_exact_match: true when the write-side and read-side agent_id strings are byte-identical', async () => {
    const { episodes, runs } = installFakeDiagnosticsDb();
    episodes.push({ agent_id: 'robot-42', occurred_at: '2026-08-11T00:00:00.000Z' });
    runs.push({ agent_id: 'robot-42', started_at: '2026-08-11T00:05:00.000Z' });

    const { getDreamEpisodeDiagnostics } = await import('../src/lib/mcp/dream/diagnostics');
    const result = await getDreamEpisodeDiagnostics('robot-42', 'user-a');

    expect(result.ownership_error).toBeUndefined();
    expect(result.last_submit_agent_id).toBe('robot-42');
    expect(result.last_run_agent_id).toBe('robot-42');
    expect(result.agent_id_exact_match).toBe(true);
  });

  it('(b) returns agent_id_exact_match: false for a deliberately mismatched-case agent_id between write and read sides', async () => {
    const { episodes, runs } = installFakeDiagnosticsDb();
    // Write side used "Robot-42" (capital R); read side used "robot-42".
    episodes.push({ agent_id: 'Robot-42', occurred_at: '2026-08-11T00:00:00.000Z' });
    runs.push({ agent_id: 'robot-42', started_at: '2026-08-11T00:05:00.000Z' });

    const { getDreamEpisodeDiagnostics } = await import('../src/lib/mcp/dream/diagnostics');
    // Caller queries using either casing — the ILIKE match finds both rows
    // regardless, which is exactly the point: a case-insensitive lookup is
    // what makes the mismatch visible instead of one side returning zero
    // rows and hiding the discrepancy entirely.
    const result = await getDreamEpisodeDiagnostics('robot-42', 'user-a');

    expect(result.last_submit_agent_id).toBe('Robot-42');
    expect(result.last_run_agent_id).toBe('robot-42');
    expect(result.agent_id_exact_match).toBe(false);
  });

  it('returns agent_id_exact_match: null when one side has no data yet (nothing to compare)', async () => {
    const { episodes } = installFakeDiagnosticsDb();
    episodes.push({ agent_id: 'robot-42', occurred_at: '2026-08-11T00:00:00.000Z' });
    // No run recorded yet.

    const { getDreamEpisodeDiagnostics } = await import('../src/lib/mcp/dream/diagnostics');
    const result = await getDreamEpisodeDiagnostics('robot-42', 'user-a');

    expect(result.last_submit_agent_id).toBe('robot-42');
    expect(result.last_run_agent_id).toBeNull();
    expect(result.agent_id_exact_match).toBeNull();
  });

  it('(c) rejects with an ownership_error for a caller who does not own the agent_id, and returns no diagnostic data', async () => {
    const { owners, episodes } = installFakeDiagnosticsDb();
    owners.push({ agent_id: 'robot-42', owner_user_id: 'user-a' });
    episodes.push({ agent_id: 'robot-42', occurred_at: '2026-08-11T00:00:00.000Z' });

    const { getDreamEpisodeDiagnostics } = await import('../src/lib/mcp/dream/diagnostics');
    const result = await getDreamEpisodeDiagnostics('robot-42', 'user-b');

    expect(result.ownership_error).toMatch(/already claimed/i);
    expect(result.last_submit_agent_id).toBeNull();
    expect(result.last_run_agent_id).toBeNull();
    expect(result.agent_id_exact_match).toBeNull();
    expect(result.live_unconsumed_count).toBe(0);
  });

  it('the first caller for a brand-new agent_id is allowed (claim-on-first-touch, matching submit_episode_log/start_dream)', async () => {
    installFakeDiagnosticsDb();
    const { getDreamEpisodeDiagnostics } = await import('../src/lib/mcp/dream/diagnostics');
    const result = await getDreamEpisodeDiagnostics('brand-new-agent', 'user-a');
    expect(result.ownership_error).toBeUndefined();
    expect(result.live_unconsumed_count).toBe(0);
  });

  it('is registered as a free, unmetered MCP tool named get_dream_episode_diagnostics', async () => {
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    vi.resetModules();
    const { getTools } = await import('../src/lib/mcp/tools');
    const tool = getTools().find((t) => t.name === 'get_dream_episode_diagnostics');
    expect(tool).toBeDefined();
    expect(tool?.unmetered).toBe(true);
  });
});
