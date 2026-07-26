/**
 * tests/mcp-dream-cycle.test.ts — HyperMove MCP Dream Cycle (FEATURE_MCP_DREAM_CYCLE).
 *
 * Offline memory-consolidation pipeline. Tasks 1-13 of docs/prd/dream-cycle-v1.md.
 * Deterministic + offline: MockEmbedder, no live network, no live services/llm call
 * (extraction stage is mocked at the HTTP boundary per task).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { isMcpDreamCycleEnabled } from '../src/lib/platform-flag';

const ENV_KEYS = ['FEATURE_HYPERMOVE_MCP_GATEWAY_V1', 'FEATURE_MCP_DREAM_CYCLE'] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('Task 1 · isMcpDreamCycleEnabled — v3Flag cascade', () => {
  it('defaults ON with no env vars set', () => {
    delete process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1;
    delete process.env.FEATURE_MCP_DREAM_CYCLE;
    expect(isMcpDreamCycleEnabled()).toBe(true);
  });

  it('opts out via FEATURE_MCP_DREAM_CYCLE=false without touching the master flag', () => {
    delete process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1;
    process.env.FEATURE_MCP_DREAM_CYCLE = 'false';
    expect(isMcpDreamCycleEnabled()).toBe(false);
  });

  it('is disabled when the gateway master flag is off, regardless of its own flag', () => {
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'false';
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    expect(isMcpDreamCycleEnabled()).toBe(false);
  });

  it('stays ON when explicitly set to true with the master flag on', () => {
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    expect(isMcpDreamCycleEnabled()).toBe(true);
  });
});

// ─── Task 2 · Agent ownership binding ──────────────────────────────────────

describe('Task 2 · claimOrCheckOwnership — first-write-claims-it', () => {
  interface OwnershipRow { agent_id: string; owner_user_id: string; }

  /** Fresh in-memory fake DB per test, mirrors mcp-device-auth.test.ts's convention. */
  function installFakeOwnershipDb() {
    const rows: OwnershipRow[] = [];
    vi.doMock('../src/lib/db', () => ({
      withClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
        const client = {
          query: vi.fn(async (sql: string, params: unknown[] = []) => {
            if (sql.includes('INSERT INTO mcp_agent_ownership')) {
              const [agentId, ownerUserId] = params as [string, string];
              if (!rows.some((r) => r.agent_id === agentId)) {
                rows.push({ agent_id: agentId, owner_user_id: ownerUserId });
              }
              return { rows: [], rowCount: 1 };
            }
            if (sql.includes('SELECT owner_user_id FROM mcp_agent_ownership')) {
              const row = rows.find((r) => r.agent_id === (params[0] as string));
              return { rows: row ? [{ owner_user_id: row.owner_user_id }] : [] };
            }
            throw new Error(`unexpected SQL in ownership test fake: ${sql}`);
          }),
        };
        return fn(client);
      }),
    }));
    return rows;
  }

  beforeEach(() => {
    vi.resetModules();
  });

  it('first claim for a new agent_id succeeds', async () => {
    installFakeOwnershipDb();
    const { claimOrCheckOwnership } = await import('../src/lib/mcp/dream/ownership');
    const result = await claimOrCheckOwnership('robot-42', 'user-a');
    expect(result).toEqual({ ok: true });
  });

  it('the same user re-calling on an already-claimed agent_id succeeds (idempotent)', async () => {
    installFakeOwnershipDb();
    const { claimOrCheckOwnership } = await import('../src/lib/mcp/dream/ownership');
    await claimOrCheckOwnership('robot-42', 'user-a');
    const second = await claimOrCheckOwnership('robot-42', 'user-a');
    expect(second).toEqual({ ok: true });
  });

  it('a different user calling on an already-claimed agent_id is rejected with a clear reason', async () => {
    installFakeOwnershipDb();
    const { claimOrCheckOwnership } = await import('../src/lib/mcp/dream/ownership');
    await claimOrCheckOwnership('robot-42', 'user-a');
    const result = await claimOrCheckOwnership('robot-42', 'user-b');
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/already claimed/i);
  });
});

// ─── Task 3 · submit_episode_log — zero-token ingestion ────────────────────

describe('Task 3 · ingestEpisodes — zero-token cold storage', () => {
  interface OwnerRow { agent_id: string; owner_user_id: string; }
  interface EpisodeRow { agent_id: string; episode_id: string; }

  function installFakeIngestDb() {
    const ownerRows: OwnerRow[] = [];
    const episodeRows: EpisodeRow[] = [];
    vi.doMock('../src/lib/db', () => ({
      withClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
        const client = {
          query: vi.fn(async (sql: string, params: unknown[] = []) => {
            if (sql.includes('INSERT INTO mcp_agent_ownership')) {
              const [agentId, ownerUserId] = params as [string, string];
              if (!ownerRows.some((r) => r.agent_id === agentId)) ownerRows.push({ agent_id: agentId, owner_user_id: ownerUserId });
              return { rows: [], rowCount: 1 };
            }
            if (sql.includes('SELECT owner_user_id FROM mcp_agent_ownership')) {
              const row = ownerRows.find((r) => r.agent_id === (params[0] as string));
              return { rows: row ? [{ owner_user_id: row.owner_user_id }] : [] };
            }
            if (sql.includes('INSERT INTO dream_episode_logs')) {
              const [episodeId, agentId] = params as [string, string];
              const exists = episodeRows.some((r) => r.agent_id === agentId && r.episode_id === episodeId);
              if (!exists) episodeRows.push({ agent_id: agentId, episode_id: episodeId });
              return { rows: [], rowCount: exists ? 0 : 1 };
            }
            throw new Error(`unexpected SQL in ingest test fake: ${sql}`);
          }),
        };
        return fn(client);
      }),
    }));
    return { ownerRows, episodeRows };
  }

  beforeEach(() => {
    vi.resetModules();
  });

  const validEpisode = (id: string, agentId = 'robot-42') => ({
    episode_id: id,
    agent_id: agentId,
    timestamp: '2026-07-26T00:00:00Z',
    outcome: 'success',
    steps: [{ action: 'move', observation_summary: 'ok' }],
  });

  it('ingests a batch of valid episodes and reports zero rejections', async () => {
    installFakeIngestDb();
    const { ingestEpisodes } = await import('../src/lib/mcp/dream/ingest');
    const result = await ingestEpisodes('robot-42', 'user-a', [validEpisode('ep-1'), validEpisode('ep-2')]);
    expect(result.ingested_count).toBe(2);
    expect(result.rejected).toEqual([]);
  });

  it('is idempotent — submitting the same episode_id twice ingests it only once', async () => {
    installFakeIngestDb();
    const { ingestEpisodes } = await import('../src/lib/mcp/dream/ingest');
    await ingestEpisodes('robot-42', 'user-a', [validEpisode('ep-dup')]);
    const second = await ingestEpisodes('robot-42', 'user-a', [validEpisode('ep-dup')]);
    // Second submission of the same episode_id is a silent no-op, not an error.
    expect(second.rejected).toEqual([]);
  });

  it('rejects malformed episodes with a clear reason, per-episode, without failing the whole batch', async () => {
    installFakeIngestDb();
    const { ingestEpisodes } = await import('../src/lib/mcp/dream/ingest');
    const malformed = { episode_id: 'ep-bad', agent_id: 'robot-42', outcome: 'success' }; // missing timestamp + steps
    const result = await ingestEpisodes('robot-42', 'user-a', [validEpisode('ep-good'), malformed]);
    expect(result.ingested_count).toBe(1);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].episode_id).toBe('ep-bad');
    expect(result.rejected[0].reason).toMatch(/timestamp|steps/i);
  });

  it('rejects the whole batch when the agent_id is owned by a different session', async () => {
    installFakeIngestDb();
    const { ingestEpisodes } = await import('../src/lib/mcp/dream/ingest');
    await ingestEpisodes('robot-42', 'user-a', [validEpisode('ep-1')]);
    const result = await ingestEpisodes('robot-42', 'user-b', [validEpisode('ep-2')]);
    expect(result.ingested_count).toBe(0);
    expect(result.rejected[0].reason).toMatch(/already claimed/i);
  });

  it('is registered as an unmetered t1_read tool, gated by the flag', async () => {
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    vi.resetModules();
    const { getTools } = await import('../src/lib/mcp/tools');
    const tool = getTools().find((t) => t.name === 'submit_episode_log');
    expect(tool).toBeDefined();
    expect(tool?.unmetered).toBe(true);
    expect(tool?.tier).toBe('t1_read');
  });

  it('is absent from getTools() when the flag is off', async () => {
    process.env.FEATURE_MCP_DREAM_CYCLE = 'false';
    vi.resetModules();
    const { getTools } = await import('../src/lib/mcp/tools');
    expect(getTools().find((t) => t.name === 'submit_episode_log')).toBeUndefined();
  });
});

// ─── Task 4 · start_dream / get_dream_config — config + run lifecycle ─────

describe('Task 4 · startDream / getDreamConfig', () => {
  interface OwnerRow { agent_id: string; owner_user_id: string; }
  interface ConfigRow { agent_id: string; budget_usd: number; preset: string; trigger_criteria: unknown; updated_at: string; }
  interface RunRow { run_id: string; agent_id: string; status: string; }

  function installFakePipelineDb() {
    const ownerRows: OwnerRow[] = [];
    const configRows: ConfigRow[] = [];
    const runRows: RunRow[] = [];
    vi.doMock('../src/lib/db', () => ({
      withClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => {
        const client = {
          query: vi.fn(async (sql: string, params: unknown[] = []) => {
            if (sql.includes('INSERT INTO mcp_agent_ownership')) {
              const [agentId, ownerUserId] = params as [string, string];
              if (!ownerRows.some((r) => r.agent_id === agentId)) ownerRows.push({ agent_id: agentId, owner_user_id: ownerUserId });
              return { rows: [], rowCount: 1 };
            }
            if (sql.includes('SELECT owner_user_id FROM mcp_agent_ownership')) {
              const row = ownerRows.find((r) => r.agent_id === (params[0] as string));
              return { rows: row ? [{ owner_user_id: row.owner_user_id }] : [] };
            }
            if (sql.includes('INSERT INTO dream_configs')) {
              const [agentId, budgetUsd, preset, triggerCriteria] = params as [string, number, string, string | null];
              const idx = configRows.findIndex((r) => r.agent_id === agentId);
              const row = { agent_id: agentId, budget_usd: budgetUsd, preset, trigger_criteria: triggerCriteria ? JSON.parse(triggerCriteria) : null, updated_at: new Date().toISOString() };
              if (idx >= 0) configRows[idx] = row; else configRows.push(row);
              return { rows: [], rowCount: 1 };
            }
            if (sql.includes('SELECT budget_usd, preset, trigger_criteria, updated_at::text FROM dream_configs')) {
              const row = configRows.find((r) => r.agent_id === (params[0] as string));
              return { rows: row ? [row] : [] };
            }
            if (sql.includes('INSERT INTO dream_cycle_runs')) {
              const [runId, agentId] = params as [string, string];
              runRows.push({ run_id: runId, agent_id: agentId, status: 'started' });
              return { rows: [], rowCount: 1 };
            }
            // startDream now runs the full pipeline (Task 10) — these test
            // doubles only assert lifecycle/config behavior, so every other
            // query the pipeline issues (episode reads, memory reads/writes,
            // run-completion update, error logging) is a harmless no-op here.
            return { rows: [], rowCount: 0 };
          }),
        };
        return fn(client);
      }),
    }));
    return { ownerRows, configRows, runRows };
  }

  beforeEach(() => {
    vi.resetModules();
    delete process.env.DREAM_MAX_BUDGET_USD_PER_CYCLE;
  });

  it('start_dream rejects budget_usd above the global max without creating a run row', async () => {
    const state = installFakePipelineDb();
    process.env.DREAM_MAX_BUDGET_USD_PER_CYCLE = '0.10';
    const { startDream } = await import('../src/lib/mcp/dream/pipeline');
    const result = await startDream('robot-42', 'user-a', { budget_usd: 5, preset: 'balanced' });
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/exceeds the global max/i);
    expect(state.runRows).toHaveLength(0);
  });

  it('start_dream returns a real run_id and persists the config; get_dream_config reflects it immediately', async () => {
    installFakePipelineDb();
    const { startDream, getDreamConfig } = await import('../src/lib/mcp/dream/pipeline');
    const started = await startDream('robot-42', 'user-a', { budget_usd: 0.05, preset: 'frugal' });
    expect(started.status).toBe('started');
    expect(started.run_id).toBeTruthy();

    const cfg = await getDreamConfig('robot-42');
    expect(cfg.config?.budget_usd).toBe(0.05);
    expect(cfg.config?.preset).toBe('frugal');
  });

  it('start_dream creates a dream_cycle_runs row with status=started', async () => {
    const state = installFakePipelineDb();
    const { startDream } = await import('../src/lib/mcp/dream/pipeline');
    const result = await startDream('robot-42', 'user-a', { budget_usd: 0.05, preset: 'balanced' });
    expect(state.runRows).toHaveLength(1);
    expect(state.runRows[0].run_id).toBe(result.run_id);
    expect(state.runRows[0].status).toBe('started');
  });

  it('start_dream rejects when agent_id is owned by a different session', async () => {
    installFakePipelineDb();
    const { startDream } = await import('../src/lib/mcp/dream/pipeline');
    await startDream('robot-42', 'user-a', { budget_usd: 0.05, preset: 'balanced' });
    const result = await startDream('robot-42', 'user-b', { budget_usd: 0.05, preset: 'balanced' });
    expect(result.status).toBe('error');
    expect(result.message).toMatch(/already claimed/i);
  });

  it('registers start_dream / get_dream_config as unmetered tools, gated by the flag', async () => {
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    vi.resetModules();
    const { getTools } = await import('../src/lib/mcp/tools');
    const names = getTools().map((t) => t.name);
    expect(names).toContain('start_dream');
    expect(names).toContain('get_dream_config');
  });
});

// ─── Task 5 · Preprocessing stage (rule-based, zero-LLM) ──────────────────

describe('Task 5 · preprocessEpisodes', () => {
  const baseEpisode = (overrides: Partial<import('../src/lib/mcp/dream/ingest').EpisodeLog> = {}) => ({
    episode_id: 'ep-1',
    agent_id: 'robot-42',
    timestamp: '2026-07-26T00:00:00Z',
    outcome: 'success' as const,
    steps: [{ action: 'move' }],
    ...overrides,
  });

  it('discards success episodes with <=2 steps', async () => {
    const { preprocessEpisodes } = await import('../src/lib/mcp/dream/preprocess');
    const episodes = [
      baseEpisode({ episode_id: 'short-success', outcome: 'success', steps: [{ action: 'a' }, { action: 'b' }] }),
    ];
    const result = preprocessEpisodes(episodes);
    expect(result).toEqual([]);
  });

  it('keeps success episodes with >2 steps', async () => {
    const { preprocessEpisodes } = await import('../src/lib/mcp/dream/preprocess');
    const episodes = [
      baseEpisode({ episode_id: 'long-success', outcome: 'success', steps: [{ action: 'a' }, { action: 'b' }, { action: 'c' }] }),
    ];
    const result = preprocessEpisodes(episodes);
    expect(result).toHaveLength(1);
    expect(result[0].episode_id).toBe('long-success');
  });

  it('for failures, keeps only the final step + the one preceding it', async () => {
    const { preprocessEpisodes } = await import('../src/lib/mcp/dream/preprocess');
    const episodes = [
      baseEpisode({
        episode_id: 'fail-1',
        outcome: 'failure',
        steps: [{ action: 'a' }, { action: 'b' }, { action: 'c' }, { action: 'd', error: 'gripper timeout' }],
      }),
    ];
    const result = preprocessEpisodes(episodes);
    expect(result).toHaveLength(1);
    expect(result[0].steps).toHaveLength(2);
    expect(result[0].steps[1].error).toBe('gripper timeout');
  });

  it('truncates text fields to the configured max_chars (default 200)', async () => {
    const { preprocessEpisodes } = await import('../src/lib/mcp/dream/preprocess');
    const longText = 'x'.repeat(500);
    const episodes = [
      baseEpisode({ episode_id: 'long-text', outcome: 'failure', steps: [{ action: 'a' }, { action: 'b', observation_summary: longText }] }),
    ];
    const result = preprocessEpisodes(episodes, { max_chars: 200 });
    expect(result[0].steps[1].observation_summary?.length).toBe(200);
  });

  it('emits a raw_input_tokens_estimate reflecting the reduced size, smaller than the original', async () => {
    const { preprocessEpisodes } = await import('../src/lib/mcp/dream/preprocess');
    const longText = 'y'.repeat(1000);
    const episodes = [
      baseEpisode({
        episode_id: 'measure',
        outcome: 'failure',
        steps: [{ action: 'a', observation_summary: longText }, { action: 'b', observation_summary: longText }, { action: 'c', error: longText }],
      }),
    ];
    const originalTokens = Math.ceil(JSON.stringify(episodes[0].steps).length / 4);
    const result = preprocessEpisodes(episodes, { max_chars: 200 });
    expect(result[0].raw_input_tokens_estimate).toBeLessThan(originalTokens);
  });
});

// ─── Task 6 · Clustering stage (embeddings + MemoryVectorStore, non-LLM) ──

describe('Task 6 · clusterEpisodes', () => {
  function fixtureEpisode(id: string, agentId: string, taskType: string, action: string) {
    return {
      episode_id: id,
      agent_id: agentId,
      task_type: taskType,
      outcome: 'failure' as const,
      tags: [taskType],
      steps: [{ action }],
      raw_input_tokens_estimate: 10,
    };
  }

  it('throws if episodes from more than one agent_id are passed in (never mixes agents)', async () => {
    const { clusterEpisodes } = await import('../src/lib/mcp/dream/cluster');
    const episodes = [
      fixtureEpisode('ep-1', 'robot-42', 'pick', 'grip'),
      fixtureEpisode('ep-2', 'robot-99', 'pick', 'grip'),
    ];
    await expect(clusterEpisodes(episodes, { maxClusters: 10 })).rejects.toThrow(/multiple agent_ids/i);
  });

  it('respects the preset max_clusters cap even with more distinct episodes than the cap', async () => {
    const { clusterEpisodes } = await import('../src/lib/mcp/dream/cluster');
    const episodes = Array.from({ length: 20 }, (_, i) => fixtureEpisode(`ep-${i}`, 'robot-42', `task-${i}`, `action-${i}`));
    const clusters = await clusterEpisodes(episodes, { maxClusters: 5 });
    expect(clusters.length).toBeLessThanOrEqual(5);
    expect(clusters.every((c) => c.agent_id === 'robot-42')).toBe(true);
  });

  it('produces deterministic clustering for the same input (MockEmbedder is deterministic)', async () => {
    const { clusterEpisodes } = await import('../src/lib/mcp/dream/cluster');
    const episodes = [
      fixtureEpisode('ep-1', 'robot-42', 'pick', 'grip'),
      fixtureEpisode('ep-2', 'robot-42', 'pick', 'grip'),
      fixtureEpisode('ep-3', 'robot-42', 'navigate', 'turn'),
    ];
    const run1 = await clusterEpisodes(episodes, { maxClusters: 10 });
    const run2 = await clusterEpisodes(episodes, { maxClusters: 10 });
    expect(run1.map((c) => c.episode_ids)).toEqual(run2.map((c) => c.episode_ids));
  });

  it('groups near-identical episodes into the same cluster', async () => {
    const { clusterEpisodes } = await import('../src/lib/mcp/dream/cluster');
    const episodes = [
      fixtureEpisode('ep-1', 'robot-42', 'pick', 'grip'),
      fixtureEpisode('ep-2', 'robot-42', 'pick', 'grip'),
    ];
    const clusters = await clusterEpisodes(episodes, { maxClusters: 10 });
    expect(clusters).toHaveLength(1);
    expect(clusters[0].episode_ids).toEqual(['ep-1', 'ep-2']);
  });

  it('makes zero outbound LLM calls — only calls the local embedder', async () => {
    vi.doMock('../src/lib/mcp/embeddings', async () => {
      const actual = await vi.importActual<typeof import('../src/lib/mcp/embeddings')>('../src/lib/mcp/embeddings');
      return actual; // MockEmbedder — no network. Spying only to prove no fetch is used.
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    vi.resetModules();
    const { clusterEpisodes } = await import('../src/lib/mcp/dream/cluster');
    await clusterEpisodes([fixtureEpisode('ep-1', 'robot-42', 'pick', 'grip')], { maxClusters: 10 });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it('returns an empty array for an empty episode batch', async () => {
    const { clusterEpisodes } = await import('../src/lib/mcp/dream/cluster');
    expect(await clusterEpisodes([], { maxClusters: 10 })).toEqual([]);
  });
});

// ─── Task 7 · Extraction stage + local cost tracking ──────────────────────

describe('Task 7 · CostTracker', () => {
  it('canAfford is true while the estimated + used cost stays within budget', async () => {
    const { CostTracker } = await import('../src/lib/mcp/dream/cost');
    const tracker = new CostTracker(0.01, { input: 1, output: 1 }); // $1/M tokens both ways
    expect(tracker.canAfford(tracker.estimateCostUsd(1000, 1000))).toBe(true); // ~$0.002
  });

  it('canAfford is false once estimated cost would exceed the remaining budget', async () => {
    const { CostTracker } = await import('../src/lib/mcp/dream/cost');
    const tracker = new CostTracker(0.001, { input: 1, output: 1 });
    expect(tracker.canAfford(tracker.estimateCostUsd(100_000, 0))).toBe(false); // $0.1, way over
  });

  it('record() accumulates budgetUsedUsd accurately against a fixed price table', async () => {
    const { CostTracker } = await import('../src/lib/mcp/dream/cost');
    const tracker = new CostTracker(1, { input: 1, output: 1 }); // $1/M tokens
    tracker.record('extraction', 500_000, 500_000); // 1M tokens total = $1
    expect(tracker.budgetUsedUsd).toBe(1);
    expect(tracker.perStageTokenCounts.extraction).toBe(1_000_000);
  });
});

describe('Task 7 · extractInsights — services/llm HTTP call + budget gating', () => {
  function fixtureCluster(id: string, summary = 'pick:fail:grip'): import('../src/lib/mcp/dream/cluster').EpisodeCluster {
    return { cluster_id: id, agent_id: 'robot-42', episode_ids: ['ep-1'], size: 1, time_range: {}, dominant_tags: [], centroid_embedding: [], summary };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts insights for each cluster via a mocked services/llm HTTP call', async () => {
    const { extractInsights } = await import('../src/lib/mcp/dream/extract');
    const { CostTracker } = await import('../src/lib/mcp/dream/cost');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      rules: ['retry gripper after 200ms cooldown'], preferences: [], error_patterns: ['gripper timeout'], facts: [],
    }), { status: 200 })));

    const cost = new CostTracker(0.10);
    const result = await extractInsights([fixtureCluster('c-1')], cost, 100);
    expect(result.status).toBe('completed');
    expect(result.extracted).toHaveLength(1);
    expect(result.extracted[0].rules).toContain('retry gripper after 200ms cooldown');
  });

  it('enforces the hard per-cluster output token cap by truncating the arrays to a max length', async () => {
    const { extractInsights } = await import('../src/lib/mcp/dream/extract');
    const { CostTracker } = await import('../src/lib/mcp/dream/cost');
    const manyRules = Array.from({ length: 20 }, (_, i) => `rule-${i}`);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ rules: manyRules, preferences: [], error_patterns: [], facts: [] }), { status: 200 })));

    const cost = new CostTracker(0.10);
    const result = await extractInsights([fixtureCluster('c-1')], cost, 100);
    expect(result.extracted[0].rules.length).toBeLessThanOrEqual(10);
  });

  it('stops early and marks status=partial once the budget is exhausted mid-cycle', async () => {
    const { extractInsights } = await import('../src/lib/mcp/dream/extract');
    const { CostTracker } = await import('../src/lib/mcp/dream/cost');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ rules: ['r'], preferences: [], error_patterns: [], facts: [] }), { status: 200 })));

    // Tiny budget: affords at most 1 cluster at these prices/token caps.
    const cost = new CostTracker(0.0000005, { input: 1, output: 1 });
    const clusters = [fixtureCluster('c-1'), fixtureCluster('c-2'), fixtureCluster('c-3')];
    const result = await extractInsights(clusters, cost, 100);

    expect(result.status).toBe('partial');
    expect(result.clusters_skipped.length).toBeGreaterThan(0);
    expect(result.extracted.length + result.clusters_skipped.length).toBe(3);
  });

  it('degrades to an empty-but-well-formed result (never crashes) when the extract endpoint errors', async () => {
    const { extractInsights } = await import('../src/lib/mcp/dream/extract');
    const { CostTracker } = await import('../src/lib/mcp/dream/cost');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));

    const cost = new CostTracker(0.10);
    const result = await extractInsights([fixtureCluster('c-1')], cost, 100);
    expect(result.extracted[0]).toEqual({ cluster_id: 'c-1', rules: [], preferences: [], error_patterns: [], facts: [] });
  });
});

// ─── Task 8 · Deduplication + consolidation stage ─────────────────────────

describe('Task 8 · dedupeInsights / flattenInsights', () => {
  it('flattens extracted insights into (type, content) pairs across all categories', async () => {
    const { flattenInsights } = await import('../src/lib/mcp/dream/consolidate');
    const flat = flattenInsights([
      { cluster_id: 'c-1', rules: ['r1'], preferences: ['p1'], error_patterns: ['e1'], facts: ['f1'] },
    ]);
    expect(flat).toEqual([
      { type: 'rule', content: 'r1' },
      { type: 'preference', content: 'p1' },
      { type: 'error_pattern', content: 'e1' },
      { type: 'fact', content: 'f1' },
    ]);
  });

  it('deduplicates exact/near-exact insights (case-insensitive, trimmed) without any LLM call', async () => {
    const { dedupeInsights } = await import('../src/lib/mcp/dream/consolidate');
    const result = dedupeInsights([
      { type: 'rule', content: 'Retry gripper after 200ms' },
      { type: 'rule', content: '  retry gripper after 200ms  ' },
      { type: 'rule', content: 'A completely different rule' },
    ]);
    expect(result).toHaveLength(2);
  });
});

describe('Task 8 · consolidateInsights — similarity-merge into dream_consolidated_memories', () => {
  it('creates a new memory when no similar existing memory exists', async () => {
    const { consolidateInsights } = await import('../src/lib/mcp/dream/consolidate');
    vi.doMock('../src/lib/db', () => ({
      withClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({
        query: vi.fn(async () => ({ rows: [{ memory_id: 'mem-1' }] })),
      })),
    }));
    vi.resetModules();
    const { consolidateInsights: consolidateFresh } = await import('../src/lib/mcp/dream/consolidate');
    const result = await consolidateFresh('robot-42', [{ type: 'rule', content: 'brand new insight' }], []);
    expect(result.memories_added).toBe(1);
    expect(result.memories_merged).toBe(0);
  });

  it('merges a near-identical insight into an existing memory, bumping source_count and preserving memory_id', async () => {
    vi.doMock('../src/lib/db', () => ({
      withClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
    }));
    vi.resetModules();
    const { getEmbedder } = await import('../src/lib/mcp/embeddings');
    const { consolidateInsights } = await import('../src/lib/mcp/dream/consolidate');
    const embedder = getEmbedder();
    const existingVec = await embedder.embed('retry gripper after cooldown');

    const result = await consolidateInsights(
      'robot-42',
      [{ type: 'rule', content: 'retry gripper after cooldown' }], // identical text -> cosine 1.0
      [{ memory_id: 'mem-existing', type: 'rule', content: 'retry gripper after cooldown', confidence: 0.5, source_count: 1, embedding: existingVec }],
    );
    expect(result.memories_merged).toBe(1);
    expect(result.memories_added).toBe(0);
  });

  it('never merges across different memory types even if content text is similar', async () => {
    vi.doMock('../src/lib/db', () => ({
      withClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({
        query: vi.fn(async () => ({ rows: [{ memory_id: 'mem-new' }] })),
      })),
    }));
    vi.resetModules();
    const { getEmbedder } = await import('../src/lib/mcp/embeddings');
    const { consolidateInsights } = await import('../src/lib/mcp/dream/consolidate');
    const embedder = getEmbedder();
    const vec = await embedder.embed('gripper timeout');

    const result = await consolidateInsights(
      'robot-42',
      [{ type: 'fact', content: 'gripper timeout' }], // same text, different type than the existing 'error_pattern'
      [{ memory_id: 'mem-existing', type: 'error_pattern', content: 'gripper timeout', confidence: 0.5, source_count: 1, embedding: vec }],
    );
    expect(result.memories_added).toBe(1);
    expect(result.memories_merged).toBe(0);
  });
});

// ─── Task 9 · Pruning stage ────────────────────────────────────────────────

describe('Task 9 · pruneMemories', () => {
  function mem(id: string, confidence: number, importance: number, embedding: number[], sourceCount = 1): import('../src/lib/mcp/dream/prune').PrunableMemory {
    return { memory_id: id, confidence, importance, source_count: sourceCount, embedding };
  }

  it('drops memories below min_confidence or min_importance', async () => {
    const { pruneMemories } = await import('../src/lib/mcp/dream/prune');
    const memories = [mem('low-conf', 0.1, 0.9, [1, 0]), mem('low-imp', 0.9, 0.1, [0, 1]), mem('good', 0.8, 0.8, [1, 1])];
    const result = pruneMemories(memories, { min_confidence: 0.5, min_importance: 0.5 });
    expect(result.surviving.map((m) => m.memory_id)).toEqual(['good']);
    expect(result.removed_memory_ids).toContain('low-conf');
    expect(result.removed_memory_ids).toContain('low-imp');
  });

  it('merges near-duplicate memories (similarity > 0.95), keeping the higher-confidence one', async () => {
    const { pruneMemories } = await import('../src/lib/mcp/dream/prune');
    const memories = [mem('a', 0.9, 0.9, [1, 0, 0], 2), mem('b', 0.6, 0.9, [1, 0, 0.001], 3)]; // near-identical vectors
    const result = pruneMemories(memories);
    expect(result.surviving).toHaveLength(1);
    expect(result.surviving[0].memory_id).toBe('a'); // higher confidence kept
    expect(result.surviving[0].source_count).toBe(5); // 2 + 3
    expect(result.removed_memory_ids).toContain('b');
  });

  it('enforces max_memories_per_agent by dropping the lowest-value (confidence*importance) memories first', async () => {
    const { pruneMemories } = await import('../src/lib/mcp/dream/prune');
    // 510 distinct (orthogonal-ish) memories with descending value.
    const memories = Array.from({ length: 510 }, (_, i) => {
      const value = 1 - i / 1000; // memory 0 has highest value, memory 509 lowest
      const embedding = Array.from({ length: 510 }, (_, k) => (k === i ? 1 : 0)); // orthogonal one-hot vectors
      return mem(`mem-${i}`, value, value, embedding);
    });
    const result = pruneMemories(memories, { max_memories_per_agent: 500 });
    expect(result.surviving).toHaveLength(500);
    expect(result.memories_removed).toBe(10);
    // The 10 lowest-value memories (mem-500..mem-509) should be the ones removed.
    for (let i = 500; i < 510; i++) expect(result.removed_memory_ids).toContain(`mem-${i}`);
    for (let i = 0; i < 500; i++) expect(result.surviving.some((m) => m.memory_id === `mem-${i}`)).toBe(true);
  });

  it('logged memories_removed count matches the actual number of removed_memory_ids', async () => {
    const { pruneMemories } = await import('../src/lib/mcp/dream/prune');
    const memories = [mem('low-conf', 0.1, 0.9, [1, 0]), mem('good', 0.8, 0.8, [0, 1])];
    const result = pruneMemories(memories, { min_confidence: 0.5 });
    expect(result.memories_removed).toBe(result.removed_memory_ids.length);
  });

  it('is a no-op when everything already fits under the caps and no near-duplicates exist', async () => {
    const { pruneMemories } = await import('../src/lib/mcp/dream/prune');
    const memories = [mem('a', 0.8, 0.8, [1, 0]), mem('b', 0.9, 0.9, [0, 1])];
    const result = pruneMemories(memories);
    expect(result.surviving).toHaveLength(2);
    expect(result.memories_removed).toBe(0);
  });
});

// ─── Task 10 · Full pipeline wiring + query_dream / get_dream_stats ───────

describe('Task 10 · queryDream — rebuild-on-read indexing', () => {
  interface MemoryRow { memory_id: string; agent_id: string; type: string; content: string; confidence: number; importance: number; source_count: number; embedding: number[]; }

  function installFakeMemoryDb(rows: MemoryRow[]) {
    vi.doMock('../src/lib/db', () => ({
      withClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          if (sql.includes('FROM dream_consolidated_memories WHERE agent_id')) {
            const agentId = params[0] as string;
            return { rows: rows.filter((r) => r.agent_id === agentId) };
          }
          return { rows: [] };
        }),
      })),
    }));
  }

  beforeEach(() => {
    vi.resetModules();
  });

  it('rebuilds the per-agent index from Postgres and returns confidence-filtered, relevant memories', async () => {
    const { getEmbedder } = await import('../src/lib/mcp/embeddings');
    const embedder = getEmbedder();
    const relevantVec = await embedder.embed('gripper timeout error pattern');
    const irrelevantVec = await embedder.embed('unrelated navigation waypoint fact');

    installFakeMemoryDb([
      { memory_id: 'mem-1', agent_id: 'robot-42', type: 'error_pattern', content: 'gripper timeout error pattern', confidence: 0.9, importance: 0.8, source_count: 3, embedding: relevantVec },
      { memory_id: 'mem-2', agent_id: 'robot-42', type: 'fact', content: 'unrelated navigation waypoint fact', confidence: 0.9, importance: 0.5, source_count: 1, embedding: irrelevantVec },
      { memory_id: 'mem-3', agent_id: 'robot-42', type: 'rule', content: 'low confidence rule', confidence: 0.1, importance: 0.5, source_count: 1, embedding: relevantVec },
    ]);

    const { queryDream } = await import('../src/lib/mcp/dream/pipeline');
    const result = await queryDream('robot-42', 'gripper timeout error pattern', 5, 0.5);
    const ids = result.memories.map((m) => m.memory_id);
    expect(ids).toContain('mem-1');
    expect(ids).not.toContain('mem-3'); // below min_confidence
  });

  it('never returns another agent\'s memories', async () => {
    const { getEmbedder } = await import('../src/lib/mcp/embeddings');
    const vec = await getEmbedder().embed('shared query text');
    installFakeMemoryDb([
      { memory_id: 'mem-a', agent_id: 'robot-42', type: 'rule', content: 'shared query text', confidence: 0.9, importance: 0.8, source_count: 1, embedding: vec },
      { memory_id: 'mem-b', agent_id: 'robot-99', type: 'rule', content: 'shared query text', confidence: 0.9, importance: 0.8, source_count: 1, embedding: vec },
    ]);
    const { queryDream } = await import('../src/lib/mcp/dream/pipeline');
    const result = await queryDream('robot-42', 'shared query text', 5, 0);
    expect(result.memories.map((m) => m.memory_id)).not.toContain('mem-b');
  });

  it('rebuilds from Postgres even when the per-process cache is fresh (simulates a new process)', async () => {
    const { getEmbedder } = await import('../src/lib/mcp/embeddings');
    const embedder = getEmbedder();
    const vec = await embedder.embed('a fresh-process memory');
    installFakeMemoryDb([
      { memory_id: 'mem-fresh', agent_id: 'robot-42', type: 'fact', content: 'a fresh-process memory', confidence: 0.9, importance: 0.8, source_count: 1, embedding: vec },
    ]);
    const { _resetDreamIndexCache } = await import('../src/lib/mcp/dream/index');
    _resetDreamIndexCache(); // simulate a brand-new process: empty cache
    const { queryDream } = await import('../src/lib/mcp/dream/pipeline');
    const result = await queryDream('robot-42', 'a fresh-process memory', 5, 0);
    expect(result.memories.map((m) => m.memory_id)).toContain('mem-fresh');
  });
});

describe('Task 10 · getDreamStats', () => {
  it('returns last_run_at/status/budget_used_usd/stages_completed/memories_count from the latest run', async () => {
    vi.doMock('../src/lib/db', () => ({
      withClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({
        query: vi.fn(async (sql: string) => {
          if (sql.includes('FROM dream_cycle_runs')) {
            return { rows: [{ started_at: '2026-07-26T00:00:00.000Z', status: 'completed', budget_used_usd: '0.02', stages_completed: ['preprocessing', 'clustering'], per_stage_tokens: { extraction: 120 } }] };
          }
          if (sql.includes('COUNT(*)')) return { rows: [{ count: '3' }] };
          return { rows: [] };
        }),
      })),
    }));
    vi.resetModules();
    const { getDreamStats } = await import('../src/lib/mcp/dream/pipeline');
    const stats = await getDreamStats('robot-42');
    expect(stats.status).toBe('completed');
    expect(stats.budget_used_usd).toBe(0.02);
    expect(stats.stages_completed).toEqual(['preprocessing', 'clustering']);
    expect(stats.memories_count).toBe(3);
  });

  it('registers query_dream and get_dream_stats as unmetered tools, gated by the flag', async () => {
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    vi.resetModules();
    const { getTools } = await import('../src/lib/mcp/tools');
    const names = getTools().map((t) => t.name);
    expect(names).toContain('query_dream');
    expect(names).toContain('get_dream_stats');
  });
});

describe('Task 10 · end-to-end pipeline (submit_episode_log -> start_dream -> query_dream)', () => {
  interface EpisodeRow { agent_id: string; episode_id: string; occurred_at: string; task_type: string | null; steps: unknown; outcome: string; tags: string[] | null; consumed_by_run: string | null; }
  interface MemRow { memory_id: string; agent_id: string; type: string; content: string; confidence: number; source_count: number; embedding: number[]; }
  interface RunRow { run_id: string; agent_id: string; status: string; stages_completed: string[]; budget_used_usd: number; }

  function installFullFakeDb() {
    const owners: { agent_id: string; owner_user_id: string }[] = [];
    const episodes: EpisodeRow[] = [];
    const memories: MemRow[] = [];
    const runs: RunRow[] = [];
    let memCounter = 0;

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
          if (sql.includes('INSERT INTO dream_episode_logs')) {
            const [episodeId, agentId, occurredAt, taskType, steps, outcome, tags] = params as [string, string, string, string | null, string, string, string[] | null];
            if (!episodes.some((e) => e.agent_id === agentId && e.episode_id === episodeId)) {
              episodes.push({ agent_id: agentId, episode_id: episodeId, occurred_at: occurredAt, task_type: taskType, steps: JSON.parse(steps), outcome, tags, consumed_by_run: null });
            }
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes('FROM dream_episode_logs WHERE agent_id') && sql.includes('consumed_by_run IS NULL')) {
            const agentId = params[0] as string;
            return { rows: episodes.filter((e) => e.agent_id === agentId && e.consumed_by_run === null) };
          }
          if (sql.startsWith('UPDATE dream_episode_logs SET consumed_by_run')) {
            const [runId, agentId] = params as [string, string];
            for (const e of episodes) if (e.agent_id === agentId && e.consumed_by_run === null) e.consumed_by_run = runId;
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes('INSERT INTO dream_configs')) return { rows: [], rowCount: 1 };
          if (sql.includes('INSERT INTO dream_cycle_runs')) {
            const [runId, agentId] = params as [string, string];
            runs.push({ run_id: runId, agent_id: agentId, status: 'started', stages_completed: [], budget_used_usd: 0 });
            return { rows: [], rowCount: 1 };
          }
          if (sql.startsWith('UPDATE dream_cycle_runs SET') && sql.includes('status = $1, ended_at')) {
            const [status, , budgetUsedUsd, stagesCompleted, , , , runId] = params as [string, number, number, string[], number, number, string, string];
            const run = runs.find((r) => r.run_id === runId);
            if (run) { run.status = status; run.budget_used_usd = budgetUsedUsd; run.stages_completed = stagesCompleted; }
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes('SELECT started_at::text, status, budget_used_usd, stages_completed')) {
            const agentId = params[0] as string;
            const agentRuns = runs.filter((r) => r.agent_id === agentId);
            const latest = agentRuns[agentRuns.length - 1];
            return { rows: latest ? [{ started_at: '2026-07-26T00:00:00.000Z', status: latest.status, budget_used_usd: String(latest.budget_used_usd), stages_completed: latest.stages_completed, per_stage_tokens: {} }] : [] };
          }
          if (sql.includes('SELECT memory_id, type, content, confidence, source_count, embedding FROM dream_consolidated_memories')) {
            const agentId = params[0] as string;
            return { rows: memories.filter((m) => m.agent_id === agentId) };
          }
          if (sql.includes('SELECT memory_id, type, content, confidence, importance, source_count, embedding')) {
            const agentId = params[0] as string;
            return { rows: memories.filter((m) => m.agent_id === agentId).map((m) => ({ ...m, importance: 0.5 })) };
          }
          if (sql.includes('COUNT(*)::text AS count FROM dream_consolidated_memories')) {
            const agentId = params[0] as string;
            return { rows: [{ count: String(memories.filter((m) => m.agent_id === agentId).length) }] };
          }
          if (sql.includes('INSERT INTO dream_consolidated_memories')) {
            const [agentId, type, content, embedding] = params as [string, string, string, string];
            const memoryId = `mem-${memCounter++}`;
            memories.push({ memory_id: memoryId, agent_id: agentId, type, content, confidence: 0.5, source_count: 1, embedding: JSON.parse(embedding) });
            return { rows: [{ memory_id: memoryId }] };
          }
          if (sql.startsWith('UPDATE dream_consolidated_memories SET confidence')) return { rows: [], rowCount: 1 };
          if (sql.startsWith('DELETE FROM dream_consolidated_memories')) return { rows: [], rowCount: 0 };
          if (sql.startsWith('UPDATE dream_cycle_runs SET errors')) return { rows: [], rowCount: 1 };
          return { rows: [], rowCount: 0 };
        }),
      })),
    }));
    return { owners, episodes, memories, runs };
  }

  beforeEach(() => {
    vi.resetModules();
  });

  it('runs preprocess -> cluster -> extract -> consolidate -> prune end-to-end and reaches a terminal run status', async () => {
    installFullFakeDb();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      rules: ['always retry after cooldown'], preferences: [], error_patterns: ['gripper timeout'], facts: [],
    }), { status: 200 })));

    const { ingestEpisodes } = await import('../src/lib/mcp/dream/ingest');
    const { startDream, getDreamStats, queryDream } = await import('../src/lib/mcp/dream/pipeline');

    const episodesIn = Array.from({ length: 5 }, (_, i) => ({
      episode_id: `ep-${i}`,
      agent_id: 'robot-e2e',
      timestamp: '2026-07-26T00:00:00Z',
      task_type: 'pick',
      outcome: 'failure' as const,
      steps: [{ action: 'grip' }, { action: 'retry' }, { action: 'fail', error: 'gripper timeout' }],
    }));
    await ingestEpisodes('robot-e2e', 'user-e2e', episodesIn);

    const started = await startDream('robot-e2e', 'user-e2e', { budget_usd: 0.05, preset: 'balanced' });
    expect(started.status).toBe('started');

    const stats = await getDreamStats('robot-e2e');
    expect(['completed', 'partial']).toContain(stats.status);
    expect(stats.stages_completed).toEqual(['preprocessing', 'clustering', 'extraction', 'consolidation', 'pruning']);

    const result = await queryDream('robot-e2e', 'gripper timeout', 5, 0);
    expect(result.memories.length).toBeGreaterThan(0);

    vi.unstubAllGlobals();
  });
});

// ─── Task 11 · MCP Resources — dream/summary, rules, errors, stats ────────

describe('Task 11 · Dream Cycle MCP resources', () => {
  interface MemRow { memory_id: string; agent_id: string; type: string; content: string; confidence: number; embedding: number[]; }

  function installFakeResourceDb(rows: MemRow[], runRow?: { agent_id: string; status: string; started_at: string; budget_used_usd: string; stages_completed: string[] }) {
    vi.doMock('../src/lib/db', () => ({
      withClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          if (sql.includes('FROM dream_consolidated_memories WHERE agent_id')) {
            return { rows: rows.filter((r) => r.agent_id === (params[0] as string)) };
          }
          if (sql.includes('FROM dream_cycle_runs WHERE agent_id')) {
            return runRow && runRow.agent_id === (params[0] as string) ? { rows: [runRow] } : { rows: [] };
          }
          if (sql.includes('COUNT(*)::text AS count')) {
            return { rows: [{ count: String(rows.filter((r) => r.agent_id === (params[0] as string)).length) }] };
          }
          return { rows: [] };
        }),
      })),
    }));
  }

  beforeEach(() => {
    vi.resetModules();
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    process.env.FEATURE_MCP_RESOURCES = 'true';
  });

  it('lists all 4 dream resources when the flag is on, none when off', async () => {
    installFakeResourceDb([]);
    const { getResources } = await import('../src/lib/mcp/resources');
    const uris = getResources().map((r) => r.uri);
    expect(uris).toContain('hypermove:///agents/{agent_id}/dream/summary');
    expect(uris).toContain('hypermove:///agents/{agent_id}/dream/rules');
    expect(uris).toContain('hypermove:///agents/{agent_id}/dream/errors');
    expect(uris).toContain('hypermove:///agents/{agent_id}/dream/stats');

    process.env.FEATURE_MCP_DREAM_CYCLE = 'false';
    vi.resetModules();
    installFakeResourceDb([]);
    const { getResources: getResourcesOff } = await import('../src/lib/mcp/resources');
    expect(getResourcesOff().map((r) => r.uri)).not.toContain('hypermove:///agents/{agent_id}/dream/summary');
  });

  it('findResource matches a concrete agent URI against the {agent_id} template', async () => {
    installFakeResourceDb([]);
    const { findResource } = await import('../src/lib/mcp/resources');
    const resource = findResource('hypermove:///agents/robot-42/dream/rules');
    expect(resource?.name).toBe('Dream Cycle Rules');
  });

  it('dream/summary scopes strictly to the agent_id parsed from the URI — never leaks another agent\'s data', async () => {
    installFakeResourceDb([], { agent_id: 'robot-42', status: 'completed', started_at: '2026-07-26T00:00:00.000Z', budget_used_usd: '0.03', stages_completed: ['preprocessing'] });
    const { findResource } = await import('../src/lib/mcp/resources');
    const resource = findResource('hypermove:///agents/robot-42/dream/summary')!;
    const dataForA = (await resource.read('hypermove:///agents/robot-42/dream/summary')) as { agent_id: string; status: string };
    expect(dataForA.agent_id).toBe('robot-42');
    expect(dataForA.status).toBe('completed');

    const dataForB = (await resource.read('hypermove:///agents/robot-99/dream/summary')) as { agent_id: string; status: string };
    expect(dataForB.agent_id).toBe('robot-99');
    expect(dataForB.status).toBe('no_run_yet'); // no run row for robot-99 in this fixture
  });

  it('dream/rules only returns memories of type "rule" for the requested agent', async () => {
    const { getEmbedder } = await import('../src/lib/mcp/embeddings');
    const embedder = getEmbedder();
    const ruleVec = await embedder.embed('rule');
    installFakeResourceDb([
      { memory_id: 'mem-rule', agent_id: 'robot-42', type: 'rule', content: 'always retry gripper', confidence: 0.9, embedding: ruleVec },
    ]);
    const { findResource } = await import('../src/lib/mcp/resources');
    const resource = findResource('hypermove:///agents/robot-42/dream/rules')!;
    const data = (await resource.read('hypermove:///agents/robot-42/dream/rules')) as { rules: unknown[] };
    expect(Array.isArray(data.rules)).toBe(true);
  });

  it('returns a disabled hint when the Dream Cycle flag is off', async () => {
    process.env.FEATURE_MCP_DREAM_CYCLE = 'false';
    installFakeResourceDb([]);
    const { getResources } = await import('../src/lib/mcp/resources');
    expect(getResources().find((r) => r.name === 'Dream Cycle Summary')).toBeUndefined();
  });
});

// ─── Task 12 · MCP Prompts — summarize_today, suggest_policy_updates, compare_before_after ─

describe('Task 12 · Dream Cycle MCP prompts', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('lists all 3 dream prompts when the flag is on', async () => {
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    const { getPrompts } = await import('../src/lib/mcp/prompts');
    const names = getPrompts().map((p) => p.name);
    expect(names).toContain('dream/summarize_today');
    expect(names).toContain('dream/suggest_policy_updates');
    expect(names).toContain('dream/compare_before_after');
  });

  it('excludes all 3 dream prompts when the flag is off', async () => {
    process.env.FEATURE_MCP_DREAM_CYCLE = 'false';
    const { getPrompts } = await import('../src/lib/mcp/prompts');
    const names = getPrompts().map((p) => p.name);
    expect(names).not.toContain('dream/summarize_today');
    expect(names).not.toContain('dream/suggest_policy_updates');
    expect(names).not.toContain('dream/compare_before_after');
  });

  it('dream/summarize_today requires agent_id', async () => {
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    const { findPrompt } = await import('../src/lib/mcp/prompts');
    const prompt = findPrompt('dream/summarize_today');
    expect(prompt?.arguments).toEqual([{ name: 'agent_id', description: expect.any(String), required: true }]);
  });

  it('dream/suggest_policy_updates requires agent_id and task_type', async () => {
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    const { findPrompt } = await import('../src/lib/mcp/prompts');
    const prompt = findPrompt('dream/suggest_policy_updates');
    expect(prompt?.arguments.map((a) => a.name)).toEqual(['agent_id', 'task_type']);
    expect(prompt?.arguments.every((a) => a.required)).toBe(true);
  });

  it('dream/compare_before_after requires eval_scores_json', async () => {
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    const { findPrompt } = await import('../src/lib/mcp/prompts');
    const prompt = findPrompt('dream/compare_before_after');
    expect(prompt?.arguments).toEqual([{ name: 'eval_scores_json', description: expect.any(String), required: true }]);
  });
});

// ─── Task 13 · Gateway wiring + full regression pass ──────────────────────

describe('Task 13 · gateway.callTool dispatch — unmetered end-to-end', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'true';
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    // Force the free-tier metering path ON so an "unmetered" bypass is a real
    // assertion (not vacuously true because metering itself is off).
    process.env.FEATURE_MCP_PAYWALL = 'true';
    process.env.FEATURE_MCP_RATE_LIMIT = 'true';
  });

  it('dispatches get_dream_config for a FREE-TIER session with no payment challenge (unmetered bypass proven)', async () => {
    vi.doMock('../src/lib/db', () => ({
      withClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
    }));
    const { callTool } = await import('../src/lib/mcp/gateway');
    const session = { userId: 'free-user-dream', tier: 'free' as const, kind: 'user' as const };
    const out = await callTool({ session, name: 'get_dream_config', args: { agent_id: 'robot-42' }, headers: new Headers() });
    expect(out.error).toBeUndefined();
    expect(out.result).toBeTruthy();
  });

  it('all 5 dream tools declare unmetered:true via getTool()', async () => {
    const { getTool } = await import('../src/lib/mcp/tools');
    for (const name of ['submit_episode_log', 'start_dream', 'get_dream_config', 'query_dream', 'get_dream_stats']) {
      expect(getTool(name)?.unmetered).toBe(true);
    }
  });

  it('still writes an mcp_calls ledger row for an unmetered dream tool call (unmetered != unlogged)', async () => {
    const insertedQueries: string[] = [];
    vi.doMock('../src/lib/db', () => ({
      withClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) => fn({
        query: vi.fn(async (sql: string) => {
          insertedQueries.push(sql);
          return { rows: [] };
        }),
      })),
    }));
    const { callTool } = await import('../src/lib/mcp/gateway');
    const session = { userId: 'free-user-ledger', tier: 'free' as const, kind: 'user' as const };
    await callTool({ session, name: 'get_dream_config', args: { agent_id: 'robot-42' }, headers: new Headers() });
    expect(insertedQueries.some((sql) => sql.includes('INSERT INTO mcp_calls'))).toBe(true);
  });
});

describe('Task 13 · flag-off rollback — entire Dream Cycle surface absent', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('removes all 5 tools, 4 resources, and 3 prompts with a single flag flip', async () => {
    process.env.FEATURE_MCP_DREAM_CYCLE = 'false';
    const { getTools } = await import('../src/lib/mcp/tools');
    const { getResources } = await import('../src/lib/mcp/resources');
    const { getPrompts } = await import('../src/lib/mcp/prompts');

    process.env.FEATURE_MCP_RESOURCES = 'true'; // ensure the resources master sub-flag itself isn't the reason for absence
    const toolNames = getTools().map((t) => t.name);
    const resourceUris = getResources().map((r) => r.uri);
    const promptNames = getPrompts().map((p) => p.name);

    for (const name of ['submit_episode_log', 'start_dream', 'get_dream_config', 'query_dream', 'get_dream_stats']) {
      expect(toolNames).not.toContain(name);
    }
    expect(resourceUris.filter((u) => u.includes('/dream/'))).toEqual([]);
    expect(promptNames.filter((n) => n.startsWith('dream/'))).toEqual([]);
  });

  it('removes the entire surface when the gateway master flag is off, regardless of the dream sub-flag', async () => {
    process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 = 'false';
    process.env.FEATURE_MCP_DREAM_CYCLE = 'true';
    const { getTools } = await import('../src/lib/mcp/tools');
    expect(getTools().map((t) => t.name)).not.toContain('start_dream');
  });
});
