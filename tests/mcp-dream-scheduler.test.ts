/**
 * tests/mcp-dream-scheduler.test.ts
 * -----------------------------------
 * PRD-D (2026-07-27 dream-cycle-practical-readiness-feedback): server-side
 * enforcement of trigger_criteria via an in-process hourly scheduler tick.
 * Mock-first — a fake DB implements just enough of dream_configs,
 * mcp_agent_ownership, dream_episode_logs, and dream_cycle_runs to exercise
 * the due-check, global ceiling, and audit-trail logic end-to-end without a
 * live database.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

interface FakeConfig {
  agent_id: string;
  budget_usd: number;
  preset: string;
  trigger_criteria: Record<string, unknown> | null;
}

interface FakeEpisode {
  agent_id: string;
  consumed_by_run: string | null;
  raw_tokens_estimate: number;
}

interface FakeOwnership {
  agent_id: string;
  owner_user_id: string;
}

function installFakeSchedulerDb(opts: {
  configs: FakeConfig[];
  episodes?: FakeEpisode[];
  owners?: FakeOwnership[];
}) {
  const configs = opts.configs;
  const episodes = opts.episodes ?? [];
  const owners = opts.owners ?? [];
  const runs: { run_id: string; agent_id: string; triggered_by: string }[] = [];
  const ticks: { agents_considered: number; agents_fired: number; agents_deferred: number; total_budget_usd: number; details: unknown[] }[] = [];

  vi.doMock('../src/lib/db', () => ({
    withClient: vi.fn(async (fn: (client: unknown) => Promise<unknown>) =>
      fn({
        query: vi.fn(async (sql: string, params: unknown[] = []) => {
          if (sql.includes('SELECT agent_id, budget_usd::text, preset, trigger_criteria FROM dream_configs')) {
            return { rows: configs.map((c) => ({ agent_id: c.agent_id, budget_usd: String(c.budget_usd), preset: c.preset, trigger_criteria: c.trigger_criteria })) };
          }
          if (sql.includes('SELECT raw_tokens_estimate FROM dream_episode_logs WHERE agent_id')) {
            const agentId = params[0] as string;
            return { rows: episodes.filter((e) => e.agent_id === agentId && e.consumed_by_run === null).map((e) => ({ raw_tokens_estimate: e.raw_tokens_estimate })) };
          }
          if (sql.includes('SELECT owner_user_id FROM mcp_agent_ownership WHERE agent_id')) {
            const agentId = params[0] as string;
            const owner = owners.find((o) => o.agent_id === agentId);
            return { rows: owner ? [{ owner_user_id: owner.owner_user_id }] : [] };
          }
          if (sql.includes('INSERT INTO mcp_agent_ownership')) {
            const [agentId, userId] = params as [string, string];
            if (!owners.find((o) => o.agent_id === agentId)) owners.push({ agent_id: agentId, owner_user_id: userId });
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes('INSERT INTO dream_configs')) {
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes('INSERT INTO dream_cycle_runs')) {
            const [runId, agentId, , triggeredBy] = params as [string, string, string, string];
            runs.push({ run_id: runId, agent_id: agentId, triggered_by: triggeredBy });
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes('SELECT episode_id, agent_id, occurred_at::text')) {
            return { rows: [] }; // no unconsumed episodes for runPipeline's own read — keeps the fired pipeline a fast no-op
          }
          if (sql.startsWith('UPDATE dream_cycle_runs SET')) {
            return { rows: [], rowCount: 1 };
          }
          if (sql.includes('INSERT INTO dream_scheduler_ticks')) {
            const [agentsConsidered, agentsFired, agentsDeferred, totalBudgetUsd, details] = params as [number, number, number, number, string];
            ticks.push({ agents_considered: agentsConsidered, agents_fired: agentsFired, agents_deferred: agentsDeferred, total_budget_usd: totalBudgetUsd, details: JSON.parse(details) });
            return { rows: [], rowCount: 1 };
          }
          return { rows: [], rowCount: 0 };
        }),
      }),
    ),
  }));

  return { runs, ticks };
}

beforeEach(() => {
  vi.resetModules();
  vi.useRealTimers();
});

describe('PRD-D · isDue via runSchedulerTick — due-check logic', () => {
  it('fires an agent whose min_episodes threshold is met', async () => {
    const { runs } = installFakeSchedulerDb({
      configs: [{ agent_id: 'robot-1', budget_usd: 0.05, preset: 'balanced', trigger_criteria: { min_episodes: 2 } }],
      episodes: [
        { agent_id: 'robot-1', consumed_by_run: null, raw_tokens_estimate: 10 },
        { agent_id: 'robot-1', consumed_by_run: null, raw_tokens_estimate: 10 },
      ],
      owners: [{ agent_id: 'robot-1', owner_user_id: 'user-1' }],
    });
    const { runSchedulerTick } = await import('../src/lib/mcp/dream/scheduler');
    const result = await runSchedulerTick();
    expect(result.agents_fired).toBe(1);
    expect(result.details[0]).toEqual({ agent_id: 'robot-1', decision: 'fired' });
    expect(runs).toHaveLength(1);
    expect(runs[0].triggered_by).toBe('scheduler');
  });

  it('skips an agent whose min_episodes threshold is NOT met', async () => {
    installFakeSchedulerDb({
      configs: [{ agent_id: 'robot-2', budget_usd: 0.05, preset: 'balanced', trigger_criteria: { min_episodes: 5 } }],
      episodes: [{ agent_id: 'robot-2', consumed_by_run: null, raw_tokens_estimate: 10 }],
      owners: [{ agent_id: 'robot-2', owner_user_id: 'user-2' }],
    });
    const { runSchedulerTick } = await import('../src/lib/mcp/dream/scheduler');
    const result = await runSchedulerTick();
    expect(result.agents_fired).toBe(0);
    expect(result.details[0].decision).toBe('skipped_not_due');
  });

  it('skips an agent with trigger_criteria: {} (no fields set) — never due, not silently fired', async () => {
    installFakeSchedulerDb({
      configs: [{ agent_id: 'robot-3', budget_usd: 0.05, preset: 'balanced', trigger_criteria: {} }],
      owners: [{ agent_id: 'robot-3', owner_user_id: 'user-3' }],
    });
    const { runSchedulerTick } = await import('../src/lib/mcp/dream/scheduler');
    const result = await runSchedulerTick();
    expect(result.agents_fired).toBe(0);
    expect(result.details[0].decision).toBe('skipped_not_due');
  });

  it('honors time_window_utc matching the current UTC hour', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T14:30:00Z'));
    installFakeSchedulerDb({
      configs: [{ agent_id: 'robot-4', budget_usd: 0.05, preset: 'balanced', trigger_criteria: { time_window_utc: '14:00' } }],
      owners: [{ agent_id: 'robot-4', owner_user_id: 'user-4' }],
    });
    const { runSchedulerTick } = await import('../src/lib/mcp/dream/scheduler');
    const result = await runSchedulerTick();
    expect(result.agents_fired).toBe(1);
    vi.useRealTimers();
  });

  it('skips when time_window_utc does not match the current UTC hour', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T09:00:00Z'));
    installFakeSchedulerDb({
      configs: [{ agent_id: 'robot-5', budget_usd: 0.05, preset: 'balanced', trigger_criteria: { time_window_utc: '14:00' } }],
      owners: [{ agent_id: 'robot-5', owner_user_id: 'user-5' }],
    });
    const { runSchedulerTick } = await import('../src/lib/mcp/dream/scheduler');
    const result = await runSchedulerTick();
    expect(result.agents_fired).toBe(0);
    vi.useRealTimers();
  });

  it('requires ALL configured criteria (AND, not OR) — time matches but min_episodes does not, still skipped', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-27T14:00:00Z'));
    installFakeSchedulerDb({
      configs: [{ agent_id: 'robot-6', budget_usd: 0.05, preset: 'balanced', trigger_criteria: { time_window_utc: '14:00', min_episodes: 10 } }],
      episodes: [{ agent_id: 'robot-6', consumed_by_run: null, raw_tokens_estimate: 5 }],
      owners: [{ agent_id: 'robot-6', owner_user_id: 'user-6' }],
    });
    const { runSchedulerTick } = await import('../src/lib/mcp/dream/scheduler');
    const result = await runSchedulerTick();
    expect(result.agents_fired).toBe(0);
    vi.useRealTimers();
  });

  it('resolves the real owner_user_id via mcp_agent_ownership before firing — never passes agent_id as a fake userId', async () => {
    const { runs } = installFakeSchedulerDb({
      configs: [{ agent_id: 'robot-7', budget_usd: 0.05, preset: 'balanced', trigger_criteria: { min_episodes: 1 } }],
      episodes: [{ agent_id: 'robot-7', consumed_by_run: null, raw_tokens_estimate: 5 }],
      owners: [{ agent_id: 'robot-7', owner_user_id: 'the-real-owner-session-id' }],
    });
    const { runSchedulerTick } = await import('../src/lib/mcp/dream/scheduler');
    await runSchedulerTick();
    expect(runs).toHaveLength(1);
    // Firing succeeded at all is proof ownership resolved correctly — a
    // fake/wrong userId would have made startDream() reject with "already
    // claimed by a different session" and this run would never be recorded.
  });

  it('records skipped_error (not a thrown exception) when no ownership row exists for a due agent', async () => {
    installFakeSchedulerDb({
      configs: [{ agent_id: 'robot-8', budget_usd: 0.05, preset: 'balanced', trigger_criteria: { min_episodes: 1 } }],
      episodes: [{ agent_id: 'robot-8', consumed_by_run: null, raw_tokens_estimate: 5 }],
      owners: [], // no ownership row — simulates the "shouldn't normally happen" edge case
    });
    const { runSchedulerTick } = await import('../src/lib/mcp/dream/scheduler');
    const result = await runSchedulerTick();
    expect(result.agents_fired).toBe(0);
    expect(result.details[0].decision).toBe('skipped_error');
  });
});

describe('PRD-D · global cross-agent ceiling', () => {
  it('defers agents beyond the per-tick agent count ceiling to the next tick', async () => {
    process.env.DREAM_SCHEDULER_MAX_AGENTS_PER_TICK = '2';
    const configs: FakeConfig[] = Array.from({ length: 3 }, (_, i) => ({
      agent_id: `robot-ceiling-${i}`, budget_usd: 0.01, preset: 'balanced', trigger_criteria: { min_episodes: 1 },
    }));
    const episodes: FakeEpisode[] = configs.map((c) => ({ agent_id: c.agent_id, consumed_by_run: null, raw_tokens_estimate: 5 }));
    const owners: FakeOwnership[] = configs.map((c) => ({ agent_id: c.agent_id, owner_user_id: `user-${c.agent_id}` }));
    installFakeSchedulerDb({ configs, episodes, owners });
    const { runSchedulerTick } = await import('../src/lib/mcp/dream/scheduler');
    const result = await runSchedulerTick();
    expect(result.agents_fired).toBe(2);
    expect(result.agents_deferred).toBe(1);
    delete process.env.DREAM_SCHEDULER_MAX_AGENTS_PER_TICK;
  });

  it('defers an agent whose budget would exceed the per-tick global budget ceiling', async () => {
    process.env.DREAM_SCHEDULER_MAX_BUDGET_USD_PER_TICK = '0.08';
    const configs: FakeConfig[] = [
      { agent_id: 'robot-big-1', budget_usd: 0.05, preset: 'balanced', trigger_criteria: { min_episodes: 1 } },
      { agent_id: 'robot-big-2', budget_usd: 0.05, preset: 'balanced', trigger_criteria: { min_episodes: 1 } },
    ];
    const episodes: FakeEpisode[] = configs.map((c) => ({ agent_id: c.agent_id, consumed_by_run: null, raw_tokens_estimate: 5 }));
    const owners: FakeOwnership[] = configs.map((c) => ({ agent_id: c.agent_id, owner_user_id: `user-${c.agent_id}` }));
    installFakeSchedulerDb({ configs, episodes, owners });
    const { runSchedulerTick } = await import('../src/lib/mcp/dream/scheduler');
    const result = await runSchedulerTick();
    expect(result.agents_fired).toBe(1);
    expect(result.agents_deferred).toBe(1);
    expect(result.total_budget_usd).toBe(0.05);
    delete process.env.DREAM_SCHEDULER_MAX_BUDGET_USD_PER_TICK;
  });

  it('a burst of due agents beyond the ceiling never blows past the shared budget cap in one tick', async () => {
    process.env.DREAM_SCHEDULER_MAX_BUDGET_USD_PER_TICK = '0.10';
    const configs: FakeConfig[] = Array.from({ length: 10 }, (_, i) => ({
      agent_id: `robot-burst-${i}`, budget_usd: 0.03, preset: 'balanced', trigger_criteria: { min_episodes: 1 },
    }));
    const episodes: FakeEpisode[] = configs.map((c) => ({ agent_id: c.agent_id, consumed_by_run: null, raw_tokens_estimate: 5 }));
    const owners: FakeOwnership[] = configs.map((c) => ({ agent_id: c.agent_id, owner_user_id: `user-${c.agent_id}` }));
    installFakeSchedulerDb({ configs, episodes, owners });
    const { runSchedulerTick } = await import('../src/lib/mcp/dream/scheduler');
    const result = await runSchedulerTick();
    expect(result.total_budget_usd).toBeLessThanOrEqual(0.10);
    expect(result.agents_deferred).toBeGreaterThan(0);
    delete process.env.DREAM_SCHEDULER_MAX_BUDGET_USD_PER_TICK;
  });
});

describe('PRD-D · audit trail', () => {
  it('persists a dream_scheduler_ticks row with considered/fired/deferred counts and per-agent details', async () => {
    const { ticks } = installFakeSchedulerDb({
      configs: [
        { agent_id: 'robot-audit-1', budget_usd: 0.02, preset: 'balanced', trigger_criteria: { min_episodes: 1 } },
        { agent_id: 'robot-audit-2', budget_usd: 0.02, preset: 'balanced', trigger_criteria: { min_episodes: 99 } },
      ],
      episodes: [{ agent_id: 'robot-audit-1', consumed_by_run: null, raw_tokens_estimate: 5 }],
      owners: [{ agent_id: 'robot-audit-1', owner_user_id: 'user-1' }, { agent_id: 'robot-audit-2', owner_user_id: 'user-2' }],
    });
    const { runSchedulerTick } = await import('../src/lib/mcp/dream/scheduler');
    await runSchedulerTick();
    expect(ticks).toHaveLength(1);
    expect(ticks[0].agents_considered).toBe(2);
    expect(ticks[0].agents_fired).toBe(1);
    expect(ticks[0].details).toHaveLength(2);
  });
});

describe('PRD-D · byte-identical behavior for agents that never set trigger_criteria', () => {
  it('an agent with trigger_criteria: null (never configured) is never considered/fired by the scheduler', async () => {
    // dream_configs WHERE trigger_criteria IS NOT NULL — this config never
    // appears in the query result at all, matching a real DB's filter.
    const { runs, ticks } = installFakeSchedulerDb({ configs: [] });
    const { runSchedulerTick } = await import('../src/lib/mcp/dream/scheduler');
    const result = await runSchedulerTick();
    expect(result.agents_considered).toBe(0);
    expect(result.agents_fired).toBe(0);
    expect(runs).toHaveLength(0);
    expect(ticks[0].agents_considered).toBe(0);
  });
});

describe('PRD-D · startDreamScheduler / stopDreamScheduler lifecycle', () => {
  it('is idempotent — calling start twice does not register a second interval', async () => {
    const { startDreamScheduler, stopDreamScheduler, isDreamSchedulerRunning } = await import('../src/lib/mcp/dream/scheduler');
    expect(isDreamSchedulerRunning()).toBe(false);
    startDreamScheduler(3_600_000);
    startDreamScheduler(3_600_000);
    expect(isDreamSchedulerRunning()).toBe(true);
    stopDreamScheduler();
    expect(isDreamSchedulerRunning()).toBe(false);
  });
});
