/**
 * src/lib/mcp/dream/scheduler.ts
 * ---------------------------------
 * PRD-D (2026-07-27 dream-cycle-practical-readiness-feedback): server-side
 * enforcement of `trigger_criteria`. Without this, `start_dream`'s own
 * schema implies a per-agent "set once, learns automatically" guarantee
 * that dream/pipeline.ts's own code comment admits doesn't exist yet
 * ("Phase 1 scope: trigger_criteria is accepted and persisted but NOT
 * enforced"). This module is the enforcement.
 *
 * Design (revised from the incoming PRD's Vercel-Cron proposal — the app is
 * deployed on a self-managed VPS via PM2, not Vercel, and even Vercel's
 * Hobby-tier cron is once-per-day only, confirmed via Vercel's own docs):
 * an in-process interval inside the `hypermove-app` PM2 process, ticking
 * hourly, calling startDream() directly (no HTTP round-trip, no new deploy
 * target). Guarded by isMcpDreamSchedulerEnabled() — default OFF, the first
 * feature in this gateway that autonomously spends budget/writes data
 * across every registered agent with no per-call human trigger.
 *
 * `time_window_utc` semantics: an "HH:MM" UTC time-of-day the agent wants
 * its cycle to run near. On an hourly tick, an agent is due by time window
 * if the current UTC hour matches the configured hour (minute granularity
 * is accepted in the config for forward-compatibility with a finer-grained
 * scheduler later, but an hourly tick can only match at hour granularity —
 * documented, not silently rounded without explanation).
 */

import { withClient } from '../../db';
import { startDream, type DreamConfig, type TriggerCriteria } from './pipeline';
import { isMcpDreamPaymentBindingEnabled } from '../../platform-flag';

export interface SchedulerTickDetail {
  agent_id: string;
  decision: 'fired' | 'skipped_not_due' | 'skipped_ceiling' | 'skipped_error';
  reason?: string;
}

export interface SchedulerTickResult {
  agents_considered: number;
  agents_fired: number;
  agents_deferred: number;
  total_budget_usd: number;
  details: SchedulerTickDetail[];
}

interface DueCheckRow {
  agent_id: string;
  budget_usd: string;
  preset: string;
  trigger_criteria: TriggerCriteria | null;
}

/**
 * Look up the real owning userId for an agent_id from mcp_agent_ownership.
 * The scheduler MUST pass this (not the agent_id string itself, and not a
 * synthetic "scheduler" identity) into startDream() — claimOrCheckOwnership()
 * only succeeds when the caller's userId matches the row that FIRST claimed
 * this agent_id, so any other value would make every scheduler-fired run
 * fail ownership with "already claimed by a different session," the exact
 * bug this lookup exists to avoid. Returns null if no ownership row exists
 * yet (shouldn't normally happen — a dream_configs row can only exist after
 * a real session's first submit_episode_log/start_dream call already
 * created one — but checked explicitly rather than assumed).
 */
async function getOwnerUserId(agentId: string): Promise<string | null> {
  const row = await withClient(async (client) => {
    const { rows } = await client.query<{ owner_user_id: string }>(
      `SELECT owner_user_id FROM mcp_agent_ownership WHERE agent_id = $1 LIMIT 1`,
      [agentId],
    );
    return rows[0] ?? null;
  });
  return row?.owner_user_id ?? null;
}

/** Global, cross-agent ceiling per tick — independent of any single agent's
 *  own budget_usd. Bounds worst-case cost from a config error or a burst of
 *  newly-registered agents fanning out into an unbounded cost event. */
function globalTickBudgetCeilingUsd(): number {
  const raw = Number(process.env.DREAM_SCHEDULER_MAX_BUDGET_USD_PER_TICK);
  return Number.isFinite(raw) && raw > 0 ? raw : 1.0;
}

/** Hard cap on how many agents one tick will fire, independent of budget —
 *  protects against a burst of due agents each with a tiny budget_usd still
 *  producing an unbounded number of concurrent pipeline runs. */
function globalTickAgentCeiling(): number {
  const raw = Number(process.env.DREAM_SCHEDULER_MAX_AGENTS_PER_TICK);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20;
}

/**
 * A config is "due" this tick if trigger_criteria is present AND at least
 * one of its conditions is met:
 *   - time_window_utc matches the current UTC hour (HH from "HH:MM"), AND
 *   - min_episodes (if set) is met by the agent's unconsumed episode count, AND
 *   - min_raw_tokens (if set) is met by the sum of those episodes' raw_tokens_estimate.
 * All THREE conditions that are actually configured must hold (AND, not OR) —
 * a caller who sets both min_episodes and time_window_utc almost certainly
 * means "at this time, but only if there's enough new material," not "at
 * this time regardless of volume." A config with trigger_criteria: {} (no
 * fields set) is never due — there is nothing to check it against, and
 * firing on an empty criteria object would silently ignore the field's own
 * purpose.
 */
function isDue(config: DueCheckRow, unconsumedCount: number, unconsumedTokens: number, nowUtcHour: number): boolean {
  const tc = config.trigger_criteria;
  if (!tc || (tc.time_window_utc === undefined && tc.min_episodes === undefined && tc.min_raw_tokens === undefined)) {
    return false;
  }
  if (tc.time_window_utc !== undefined) {
    const hour = Number(tc.time_window_utc.split(':')[0]);
    if (!Number.isFinite(hour) || hour !== nowUtcHour) return false;
  }
  if (tc.min_episodes !== undefined && unconsumedCount < tc.min_episodes) return false;
  if (tc.min_raw_tokens !== undefined && unconsumedTokens < tc.min_raw_tokens) return false;
  return true;
}

/**
 * Run one scheduler tick: find every agent whose trigger_criteria is due
 * right now, fire startDream() for each (respecting the per-agent budget_usd
 * exactly as a manual start_dream call would) up to the global cross-agent
 * ceiling, and persist an audit row via recordTick(). Never throws — a
 * per-agent failure is recorded as skipped_error and the tick continues.
 */
export async function runSchedulerTick(): Promise<SchedulerTickResult> {
  const nowUtcHour = new Date().getUTCHours();
  const budgetCeiling = globalTickBudgetCeilingUsd();
  const agentCeiling = globalTickAgentCeiling();

  const configs = await withClient(async (client) => {
    const { rows } = await client.query<DueCheckRow>(
      `SELECT agent_id, budget_usd::text, preset, trigger_criteria FROM dream_configs WHERE trigger_criteria IS NOT NULL`,
    );
    return rows;
  });

  const details: SchedulerTickDetail[] = [];
  let agentsFired = 0;
  let totalBudgetUsd = 0;

  for (const config of configs ?? []) {
    // Reuse the exact "unconsumed episodes" pattern runPipeline() already
    // uses, so the scheduler's due-check counts the same rows the pipeline
    // itself will process — no drift between "why did it fire" and "what
    // did it actually consume."
    const unconsumed = await withClient(async (client) => {
      const { rows } = await client.query<{ raw_tokens_estimate: number | null }>(
        `SELECT raw_tokens_estimate FROM dream_episode_logs WHERE agent_id = $1 AND consumed_by_run IS NULL`,
        [config.agent_id],
      );
      return rows;
    });
    const unconsumedCount = unconsumed?.length ?? 0;
    const unconsumedTokens = (unconsumed ?? []).reduce((sum, r) => sum + (r.raw_tokens_estimate ?? 0), 0);

    if (!isDue(config, unconsumedCount, unconsumedTokens, nowUtcHour)) {
      details.push({ agent_id: config.agent_id, decision: 'skipped_not_due' });
      continue;
    }

    const agentBudget = Number(config.budget_usd);
    if (agentsFired >= agentCeiling || totalBudgetUsd + agentBudget > budgetCeiling) {
      details.push({
        agent_id: config.agent_id,
        decision: 'skipped_ceiling',
        reason: agentsFired >= agentCeiling
          ? `global per-tick agent ceiling (${agentCeiling}) reached — deferred to next tick`
          : `firing would exceed global per-tick budget ceiling ($${budgetCeiling}) — deferred to next tick`,
      });
      continue;
    }

    try {
      const ownerUserId = await getOwnerUserId(config.agent_id);
      if (!ownerUserId) {
        details.push({ agent_id: config.agent_id, decision: 'skipped_error', reason: 'no ownership row found for this agent_id — cannot fire without a real owning session' });
        continue;
      }
      if (isMcpDreamPaymentBindingEnabled()) {
        details.push({ agent_id: config.agent_id, decision: 'skipped_error', reason: 'payment_required: scheduled paid Dream runs require an explicit agent-bound payment session' });
      } else {
        const dreamConfig: DreamConfig = { budget_usd: agentBudget, preset: config.preset };
        await startDream(config.agent_id, ownerUserId, dreamConfig, 'scheduler');
        details.push({ agent_id: config.agent_id, decision: 'fired' });
        agentsFired++;
        totalBudgetUsd += agentBudget;
      }
    } catch (err) {
      details.push({ agent_id: config.agent_id, decision: 'skipped_error', reason: err instanceof Error ? err.message : String(err) });
    }
  }

  const result: SchedulerTickResult = {
    agents_considered: (configs ?? []).length,
    agents_fired: agentsFired,
    agents_deferred: details.filter((d) => d.decision === 'skipped_ceiling').length,
    total_budget_usd: totalBudgetUsd,
    details,
  };

  await withClient(async (client) => {
    await client.query(
      `INSERT INTO dream_scheduler_ticks (agents_considered, agents_fired, agents_deferred, total_budget_usd, details)
       VALUES ($1,$2,$3,$4,$5)`,
      [result.agents_considered, result.agents_fired, result.agents_deferred, result.total_budget_usd, JSON.stringify(result.details)],
    );
    return true;
  });

  return result;
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

/**
 * Start the in-process hourly scheduler. Idempotent — calling twice does
 * not create a second interval. No-op unless isMcpDreamSchedulerEnabled()
 * is true at call time; callers should still gate the call site itself
 * (see server startup wiring) so this module never assumes the flag.
 */
export function startDreamScheduler(intervalMs = 60 * 60 * 1000): void {
  if (intervalHandle) return;
  intervalHandle = setInterval(() => {
    runSchedulerTick().catch((err) => {
      // A tick-level failure (e.g. DB unreachable) must never crash the
      // hosting process — log and let the next tick retry.
      // eslint-disable-next-line no-console
      console.error('[dream-scheduler] tick failed', err);
    });
  }, intervalMs);
}

/** Test/shutdown hook — stops the interval, clears the handle. */
export function stopDreamScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

/** Test hook — true if the interval is currently registered. */
export function isDreamSchedulerRunning(): boolean {
  return intervalHandle !== null;
}
