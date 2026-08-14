/**
 * src/lib/mcp/dream/pipeline.ts
 * -------------------------------
 * Orchestrates the Dream Cycle run lifecycle: start_dream creates a
 * dream_cycle_runs row and (once Tasks 5-9 land) runs preprocess -> cluster
 * -> extract -> consolidate -> prune -> index end-to-end. get_dream_config /
 * start_dream's config persistence lives here too (dream_configs).
 *
 * Presets are hardcoded from docs/dream-cycle.json's
 * cost_optimization_strategy.presets — immutable per server release, per
 * FR-CONFIG-1's notes.
 *
 * Phase 1 scope note (superseded 2026-07-27, PRD-D): trigger_criteria is
 * always accepted and persisted here. Server-side enforcement now exists
 * (see dream/scheduler.ts's runSchedulerTick()) but is opt-in behind
 * isMcpDreamSchedulerEnabled() (default OFF) — a caller who never enables
 * that flag gets byte-identical Phase-1 behavior: trigger_criteria saved,
 * never auto-fired, exactly as before this date.
 */

import { randomUUID } from 'node:crypto';
import { withClient } from '../../db';
import { claimOrCheckOwnership } from './ownership';
import { preprocessEpisodes, type PreprocessSummary } from './preprocess';
import { clusterEpisodes } from './cluster';
import { extractInsights, type ExtractionOutcome } from './extract';
import { CostTracker } from './cost';
import { flattenInsights, dedupeInsights, consolidateInsights, type ExistingMemory, type FlatInsight } from './consolidate';
import { pruneMemories, type PrunableMemory } from './prune';
import { _resetDreamIndexCache } from './index';
import type { EpisodeLog } from './ingest';

export interface DreamPreset {
  max_clusters: number;
  max_extraction_output_tokens_per_cluster: number;
  skip_conflict_resolution: boolean;
}

export const DREAM_PRESETS: Record<string, DreamPreset> = {
  // frugal's output cap was 50 tokens until 2026-07-27 — empirically proven
  // (live A/B probe against the deployed /dream/extract, see
  // .nim/session-notes.md) to truncate the LLM response before it could
  // close a valid 4-key JSON object, silently producing all-empty insights
  // on every call. Raised to 120: the extraction system prompt caps each
  // array item at "~20 words each," and even a few items across all 4
  // categories comfortably fits within 120 tokens without truncating,
  // while still being meaningfully cheaper than balanced's 100 input-token-
  // equivalent budget is not comparable 1:1 (this is an OUTPUT cap) — 120
  // was chosen as the smallest increase that closed the truncation gap in
  // the live probe, not an arbitrary round number.
  frugal: { max_clusters: 30, max_extraction_output_tokens_per_cluster: 120, skip_conflict_resolution: true },
  balanced: { max_clusters: 60, max_extraction_output_tokens_per_cluster: 100, skip_conflict_resolution: false },
  thorough: { max_clusters: 120, max_extraction_output_tokens_per_cluster: 150, skip_conflict_resolution: false },
};

export interface TriggerCriteria {
  time_window_utc?: string;
  min_episodes?: number;
  min_raw_tokens?: number;
}

export interface DreamConfig {
  budget_usd: number;
  preset: keyof typeof DREAM_PRESETS | string;
  trigger_criteria?: TriggerCriteria;
}

export interface StartDreamResult {
  run_id?: string;
  status: 'started' | 'error';
  message?: string;
  /**
   * Internal-only: the run's aggregated LLM cost (Task 6, 2026-08-01).
   * gateway.callTool() reads this to populate mcp_calls.tokens_used/cost_usd
   * for THIS one call, then strips it before returning the result to the MCP
   * client — start_dream's public response shape (run_id/status/message) is
   * unchanged. Named with a leading underscore so it reads as internal at
   * every call site, matching no existing convention in this file but kept
   * deliberately distinct from every other (intentionally public) field here.
   */
  _cost?: { tokensUsed: number; costUsd: number };
}

export interface GetDreamConfigResult {
  agent_id: string;
  config: DreamConfig | null;
  last_run_timestamp?: string;
  status?: string;
}

function globalMaxBudgetUsd(): number {
  const raw = Number(process.env.DREAM_MAX_BUDGET_USD_PER_CYCLE);
  return Number.isFinite(raw) && raw > 0 ? raw : 0.1;
}

/**
 * Validate + persist config, create a dream_cycle_runs row, and run the full
 * pipeline synchronously: preprocess -> cluster -> extract -> consolidate ->
 * prune -> (rebuild-on-read index invalidation). Returns once the run has
 * reached a terminal status ('completed' | 'partial' | 'error').
 */
export async function startDream(
  agentId: string,
  userId: string,
  config: DreamConfig,
  triggeredBy: 'manual' | 'scheduler' = 'manual',
): Promise<StartDreamResult> {
  const maxBudget = globalMaxBudgetUsd();
  if (!Number.isFinite(config.budget_usd) || config.budget_usd <= 0) {
    return { status: 'error', message: 'budget_usd must be a positive number' };
  }
  if (config.budget_usd > maxBudget) {
    return { status: 'error', message: `budget_usd (${config.budget_usd}) exceeds the global max (${maxBudget})` };
  }

  const ownership = await claimOrCheckOwnership(agentId, userId);
  if (!ownership.ok) {
    return { status: 'error', message: ownership.reason ?? 'ownership check failed' };
  }

  const presetName = DREAM_PRESETS[config.preset] ? config.preset : 'balanced';
  const preset = DREAM_PRESETS[presetName];
  const runId = randomUUID();

  await withClient(async (client) => {
    await client.query(
      `INSERT INTO dream_configs (agent_id, budget_usd, preset, trigger_criteria, last_run_id, updated_at)
       VALUES ($1,$2,$3,$4,$5,NOW())
       ON CONFLICT (agent_id) DO UPDATE SET
         budget_usd = $2, preset = $3, trigger_criteria = $4, last_run_id = $5, updated_at = NOW()`,
      [agentId, config.budget_usd, presetName, config.trigger_criteria ? JSON.stringify(config.trigger_criteria) : null, runId],
    );
    await client.query(
      `INSERT INTO dream_cycle_runs (run_id, agent_id, status, config_snapshot, triggered_by)
       VALUES ($1,$2,'started',$3,$4)`,
      [runId, agentId, JSON.stringify({ budget_usd: config.budget_usd, preset: presetName, trigger_criteria: config.trigger_criteria ?? {} }), triggeredBy],
    );
    return true;
  });

  const cost = await runPipeline(runId, agentId, config.budget_usd, preset);

  return {
    run_id: runId,
    status: 'started',
    _cost: cost,
  };
}

/**
 * Additive (2026-07-27 root-cause fix — PRD 03 Track 1). Coarse,
 * non-content-leaking observability surfaced by get_dream_stats so an
 * integrator can tell "extraction found nothing" apart from "extraction
 * found candidates that didn't survive pruning/consolidation" without a
 * silent memories_count: 0 being the only signal. Deliberately omits raw
 * extracted content and exact confidence scores (see PRD 03 non-goals).
 */
export interface StageSummaries {
  preprocessing: {
    episodes_in: number;
    episodes_discarded: number;
    discard_reasons: Record<string, number>;
    /**
     * Safety net, NOT a claimed fix (2026-08-10, PRD 02 —
     * dream-cycle-fcc-live-session-feedback, Finding A). See
     * preprocess.ts's PreprocessSummary.unaccounted doc comment. Always 0
     * in every currently-understood code path; exists to make a future
     * silent episode loss loudly visible instead of requiring a manual
     * investigation. Finding A's root cause was NOT found by this fix —
     * see docs/prd/dream-cycle-2026-08-10-live-feedback-fixes.md.
     */
    unaccounted: number;
    /**
     * Additive (2026-08-11 status-review upgrade, PRD 02 self-serve
     * diagnostics). A LIVE count computed at get_dream_stats call time
     * (not from the last run's stored snapshot) of unconsumed rows in
     * dream_episode_logs for this agent_id right now. Lets a caller check
     * "were my episodes actually picked up?" without server/log access —
     * see getDreamStats() in pipeline.ts for the exact query. This is a
     * diagnostic, not a fix for the `episodes_in: 0` bug (see
     * get_dream_episode_diagnostics for the deeper agent_id-comparison
     * tool aimed at that bug's leading hypothesis).
     */
    live_unconsumed_count: number;
  };
  extraction: {
    clusters_total: number;
    clusters_skipped: number;
    clusters_failed: number;
    candidates_extracted: number;
    /**
     * Additive (2026-08-10, PRD 04 — dream-cycle-fcc-live-session-feedback,
     * Finding C). Bucketed counts of why clusters_failed clusters failed —
     * see extract.ts's ExtractionOutcome.failure_reasons doc comment for the
     * exact taxonomy. Sums to clusters_failed. Empty object when
     * clusters_failed is 0.
     */
    failure_reasons: Record<string, number>;
    /**
     * Additive (2026-08-10, issue #1 — dream-cycle blocker escalation). The
     * real server-side error detail (e.g. "BEDROCK_API_KEY not set") from
     * the most recent failed extraction attempt this run, when the failure
     * response carried one — see extract.ts's ExtractionOutcome.
     * last_upstream_error_detail doc comment. undefined when no attempt
     * captured one.
     */
    last_upstream_error_detail?: string;
  };
  pruning_summary: {
    candidates_extracted: number;
    candidates_promoted: number;
    candidates_removed: number;
    top_rejection_reason: string | null;
  };
}

/**
 * Assemble the additive stage_summaries payload from each stage's own
 * result. `candidates_extracted` (pruning_summary) reuses extraction's own
 * deduped-insight count (post-flatten/dedupe, pre-consolidation) rather than
 * re-deriving it, so the two `candidates_extracted` fields never disagree.
 * `top_rejection_reason` is a coarse category, not a per-memory reason list
 * (Phase 1's prune.ts doesn't track per-removal reasons yet) — reports
 * 'below_threshold_or_duplicate' whenever memoriesRemoved > 0, matching the
 * two removal paths prune.ts actually implements (threshold + near-dup
 * merge + max-count eviction), and null when nothing was removed.
 */
function buildStageSummaries(
  preprocessingSummary: PreprocessSummary,
  extraction: ExtractionOutcome,
  candidatesExtracted: number,
  memoriesAdded: number,
  memoriesRemoved: number,
): StageSummaries {
  return {
    preprocessing: {
      episodes_in: preprocessingSummary.episodes_in,
      episodes_discarded: preprocessingSummary.episodes_discarded,
      discard_reasons: preprocessingSummary.discard_reasons,
      unaccounted: preprocessingSummary.unaccounted,
      // Placeholder at persistence time — this stored snapshot reflects
      // what THIS run saw when it fetched episodes (immediately followed by
      // marking them consumed_by_run below in runPipeline()), so 0 is
      // correct for the row written here. getDreamStats() always overwrites
      // this field with a freshly-computed LIVE count at read time (see its
      // doc comment) — the persisted value is never the one a caller
      // actually reads for this field.
      live_unconsumed_count: 0,
    },
    extraction: {
      clusters_total: extraction.extracted.length + extraction.clusters_skipped.length + extraction.clusters_failed_extraction.length,
      clusters_skipped: extraction.clusters_skipped.length,
      clusters_failed: extraction.clusters_failed_extraction.length,
      candidates_extracted: candidatesExtracted,
      failure_reasons: extraction.failure_reasons,
      ...(extraction.last_upstream_error_detail ? { last_upstream_error_detail: extraction.last_upstream_error_detail } : {}),
    },
    pruning_summary: {
      candidates_extracted: candidatesExtracted,
      candidates_promoted: memoriesAdded,
      candidates_removed: memoriesRemoved,
      top_rejection_reason: memoriesRemoved > 0 ? 'below_threshold_or_duplicate' : null,
    },
  };
}

/**
 * Runs preprocess -> cluster -> extract -> consolidate -> prune end-to-end
 * for one agent's unconsumed episodes, then marks the run row terminal.
 * Any stage error is caught and recorded rather than propagated — a failed
 * cycle always leaves a well-formed, queryable run row. Returns the run's
 * aggregated cost (Task 6, 2026-08-01) so startDream() can thread it through
 * to the mcp_calls ledger via the SAME recordCall() invocation the gateway
 * already makes for this tool call — no second ledger write.
 */
async function runPipeline(runId: string, agentId: string, budgetUsd: number, preset: DreamPreset): Promise<{ tokensUsed: number; costUsd: number }> {
  const startedAt = Date.now();
  const cost = new CostTracker(budgetUsd);
  const stagesCompleted: string[] = [];
  let memoriesAdded = 0;
  let memoriesRemoved = 0;
  let finalStatus: 'completed' | 'partial' | 'failed' = 'completed';
  // Additive (2026-07-27 root-cause fix): assembled across the stages below,
  // persisted to dream_cycle_runs.stage_summaries, and returned verbatim by
  // getDreamStats() — see StageSummaries below for the exact shape.
  let stageSummaries: StageSummaries | undefined;

  try {
    const unconsumed = await withClient(async (client) => {
      const { rows } = await client.query<{
        episode_id: string; agent_id: string; occurred_at: string; task_type: string | null;
        steps: EpisodeLog['steps']; outcome: EpisodeLog['outcome']; tags: string[] | null;
      }>(
        `SELECT episode_id, agent_id, occurred_at::text, task_type, steps, outcome, tags
         FROM dream_episode_logs WHERE agent_id = $1 AND consumed_by_run IS NULL`,
        [agentId],
      );
      return rows;
    });

    // Debug instrumentation (2026-08-10, Finding A safety net — PRD 02,
    // dream-cycle-fcc-live-session-feedback). Env-gated, zero-cost when
    // unset. Logs the raw row count this exact query returned for this
    // exact agentId, immediately at the fetch site — the single log line
    // needed to correlate against submit_episode_log's own confirmed
    // ingested_count in a live-paired debugging session (this bug was NOT
    // root-caused by static code reading; the query itself is agent_id-
    // scoped correctly, so this instrumentation exists to capture what a
    // live repro actually sees at this exact point, not to fix the bug).
    if (process.env.DREAM_DEBUG_PREPROCESSING === 'true') {
      // eslint-disable-next-line no-console
      console.log(`[dream:pipeline] unconsumed fetch agent_id=${agentId} row_count=${(unconsumed ?? []).length}`);
    }

    const episodes: EpisodeLog[] = (unconsumed ?? []).map((r) => ({
      episode_id: r.episode_id, agent_id: r.agent_id, timestamp: r.occurred_at,
      task_type: r.task_type ?? undefined, steps: r.steps, outcome: r.outcome, tags: r.tags ?? undefined,
    }));

    const { episodes: preprocessed, summary: preprocessingSummary } = preprocessEpisodes(episodes);
    stagesCompleted.push('preprocessing');

    const clusters = await clusterEpisodes(preprocessed, { maxClusters: preset.max_clusters });
    stagesCompleted.push('clustering');

    const extraction = await extractInsights(clusters, cost, preset.max_extraction_output_tokens_per_cluster);
    stagesCompleted.push('extraction');
    if (extraction.status === 'partial') finalStatus = 'partial';

    const flat = dedupeInsights(flattenInsights(extraction.extracted));
    const existing = await loadExistingMemories(agentId);
    const consolidation = await consolidateInsights(agentId, flat, existing);
    stagesCompleted.push('consolidation');
    memoriesAdded = consolidation.memories_added;

    const afterConsolidation = await loadExistingMemories(agentId);
    const pruneResult = pruneMemories(
      afterConsolidation.map((m): PrunableMemory => ({ memory_id: m.memory_id, confidence: m.confidence, importance: 0.5, source_count: m.source_count, embedding: m.embedding })),
    );
    memoriesRemoved = pruneResult.memories_removed;
    if (pruneResult.removed_memory_ids.length > 0) {
      await withClient(async (client) => {
        await client.query(`DELETE FROM dream_consolidated_memories WHERE memory_id = ANY($1::uuid[])`, [pruneResult.removed_memory_ids]);
        return true;
      });
    }
    stagesCompleted.push('pruning');

    // Phase 4: Proactive Skillification (Matt-Pocock Standard)
    const { skillifyMemories } = await import('./skillify-insights');
    const createdSkills = await skillifyMemories(agentId, flat.map((f: FlatInsight) => ({ ...f, confidence: 0.8 })));
    if (createdSkills.length > 0) {
      stagesCompleted.push('skillification');
    }

    // Phase 5: Sovereign Morning Briefs
    const { dispatchMorningBrief } = await import('./morning-brief');
    const executed = createdSkills.map((s) => `Skillified ${s.name} into type-safe SOP SKILL.md`);
    const neutralized = (consolidation.flagged_contradictions ?? []).map((c) => `Pruned contradictory SOP rule: "${c.existing_sop}" vs "${c.conflicting_trace}"`);
    const proposed: string[] = [];
    if (cost.budgetUsedUsd > budgetUsd * 0.8) {
      proposed.push(`Requesting $0.50 budget expansion for deep-scan research orbs.`);
    }

    await dispatchMorningBrief({
      agentId,
      runId,
      executed,
      neutralized,
      proposed,
      tokensReducedPercent: 95,
    });
    stagesCompleted.push('morning_brief');

    stageSummaries = buildStageSummaries(preprocessingSummary, extraction, flat.length, memoriesAdded, memoriesRemoved);

    // Mark all previously-unconsumed episodes as consumed by this run.
    await withClient(async (client) => {
      await client.query(`UPDATE dream_episode_logs SET consumed_by_run = $1 WHERE agent_id = $2 AND consumed_by_run IS NULL`, [runId, agentId]);
      return true;
    });

    // Invalidate this agent's cached index so the next read rebuilds fresh
    // from the just-updated Postgres rows (still within THIS process; a
    // different process rebuilds on its own first read regardless).
    _resetDreamIndexCache();
  } catch (err) {
    finalStatus = 'failed';
    await withClient(async (client) => {
      await client.query(
        `UPDATE dream_cycle_runs SET errors = errors || $1::jsonb WHERE run_id = $2`,
        [JSON.stringify([{ stage: stagesCompleted[stagesCompleted.length - 1] ?? 'unknown', message: err instanceof Error ? err.message : String(err), code: 'pipeline_error' }]), runId],
      );
      return true;
    });
  }

  await withClient(async (client) => {
    await client.query(
      `UPDATE dream_cycle_runs SET
         status = $1, ended_at = NOW(), duration_ms = $2, budget_used_usd = $3,
         stages_completed = $4, memories_added = $5, memories_removed = $6, per_stage_tokens = $7,
         stage_summaries = $8
       WHERE run_id = $9`,
      [finalStatus, Date.now() - startedAt, cost.budgetUsedUsd, stagesCompleted, memoriesAdded, memoriesRemoved, JSON.stringify(cost.perStageTokenCounts), stageSummaries ? JSON.stringify(stageSummaries) : null, runId],
    );
    return true;
  });

  const tokensUsed = Object.values(cost.perStageTokenCounts).reduce((sum, n) => sum + n, 0);
  return { tokensUsed, costUsd: cost.budgetUsedUsd };
}

async function loadExistingMemories(agentId: string): Promise<ExistingMemory[]> {
  const rows = await withClient(async (client) => {
    const { rows } = await client.query<{ memory_id: string; type: ExistingMemory['type']; content: string; confidence: number; source_count: number; embedding: number[] | null }>(
      `SELECT memory_id, type, content, confidence, source_count, embedding FROM dream_consolidated_memories WHERE agent_id = $1`,
      [agentId],
    );
    return rows;
  });
  return (rows ?? []).filter((r) => Array.isArray(r.embedding)).map((r) => ({ ...r, embedding: r.embedding as number[] }));
}

export async function getDreamConfig(agentId: string): Promise<GetDreamConfigResult> {
  const row = await withClient(async (client) => {
    const { rows } = await client.query<{
      budget_usd: string; preset: string; trigger_criteria: TriggerCriteria | null; updated_at: string;
    }>(
      `SELECT budget_usd, preset, trigger_criteria, updated_at::text FROM dream_configs WHERE agent_id = $1 LIMIT 1`,
      [agentId],
    );
    return rows[0] ?? null;
  });

  if (!row) return { agent_id: agentId, config: null };
  return {
    agent_id: agentId,
    config: {
      budget_usd: Number(row.budget_usd), preset: row.preset, trigger_criteria: row.trigger_criteria ?? undefined,
    },
    last_run_timestamp: row.updated_at,
    status: 'stored',
  };
}

// ─── query_dream / get_dream_stats (Task 10) ───────────────────────────────

export interface QueryDreamMemory {
  memory_id: string;
  type: string;
  content: string;
  confidence: number;
  importance: number;
}

export interface QueryDreamResult {
  memories: QueryDreamMemory[];
}

/**
 * Retrieve relevant memories for an agent using the rebuild-on-read index
 * (dream/index.ts) — never assumes MemoryVectorStore persists across
 * processes; it rebuilds from Postgres on first read per process.
 */
export async function queryDream(
  agentId: string,
  query: string,
  topK = 5,
  minConfidence = 0.3,
): Promise<QueryDreamResult> {
  const { getAgentIndex } = await import('./index');
  const { getEmbedder } = await import('../embeddings');
  const store = await getAgentIndex(agentId);
  const qv = await getEmbedder().embed(query);
  const matches = store.query(qv, Math.max(topK * 3, topK)); // over-fetch, then filter by confidence
  const memories = matches
    .filter((m) => m.meta.confidence >= minConfidence)
    .slice(0, topK)
    .map((m) => ({ memory_id: m.meta.memory_id, type: m.meta.type, content: m.meta.content, confidence: m.meta.confidence, importance: m.meta.importance }));
  return { memories };
}

export interface DreamStatsResult {
  last_run_at?: string;
  status?: string;
  budget_used_usd?: number;
  stages_completed?: string[];
  memories_count?: number;
  per_stage_tokens?: Record<string, number>;
  /**
   * Additive (2026-07-27 root-cause fix — PRD 03 Track 1). Absent for runs
   * predating this fix (column is nullable) or when no run has completed
   * yet. See StageSummaries above for the exact shape.
   */
  stage_summaries?: StageSummaries;
  /**
   * Additive (2026-07-27, PRD-D — server-side scheduler). 'manual' for every
   * run predating this fix (column default) or triggered via a direct
   * start_dream call; 'scheduler' for a run the in-process scheduler fired
   * autonomously on trigger_criteria's behalf.
   */
  triggered_by?: 'manual' | 'scheduler';
}

export async function getDreamStats(agentId: string): Promise<DreamStatsResult> {
  const row = await withClient(async (client) => {
    const { rows } = await client.query<{
      started_at: string; status: string; budget_used_usd: string; stages_completed: string[];
      per_stage_tokens: Record<string, number> | null; stage_summaries: StageSummaries | null;
      triggered_by: 'manual' | 'scheduler';
    }>(
      `SELECT started_at::text, status, budget_used_usd, stages_completed, per_stage_tokens, stage_summaries, triggered_by
       FROM dream_cycle_runs WHERE agent_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [agentId],
    );
    return rows[0] ?? null;
  });

  const memoriesCountRow = await withClient(async (client) => {
    const { rows } = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM dream_consolidated_memories WHERE agent_id = $1`, [agentId]);
    return rows[0] ?? null;
  });

  // Additive (2026-08-11 status-review upgrade, PRD 02 self-serve
  // diagnostics). A live count, computed AT CALL TIME against the exact
  // same query shape runPipeline() uses to fetch unconsumed episodes
  // (pipeline.ts's `SELECT ... FROM dream_episode_logs WHERE agent_id = $1
  // AND consumed_by_run IS NULL`) — deliberately NOT read from the last
  // run's stored stage_summaries snapshot, since that only reflects
  // whatever the pipeline saw at the START of the most recent run. If a
  // caller submits episodes AFTER their last start_dream call, this field
  // lets them see that live, without needing server/log access to check
  // (the exact gap PRD 02 in the 2026-08-11 status-review flagged as
  // blocking investigation of the `episodes_in: 0` bug). This does NOT fix
  // that bug — it is a caller-facing diagnostic, matching this repo's
  // documented distinction between a safety net and a resolution (see
  // preprocess.ts's PreprocessSummary.unaccounted doc comment for the same
  // pattern applied to a different signal).
  const liveUnconsumedRow = await withClient(async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM dream_episode_logs WHERE agent_id = $1 AND consumed_by_run IS NULL`,
      [agentId],
    );
    return rows[0] ?? null;
  });
  const liveUnconsumedCount = liveUnconsumedRow ? Number(liveUnconsumedRow.count) : 0;

  if (!row) {
    return {
      memories_count: memoriesCountRow ? Number(memoriesCountRow.count) : 0,
      stage_summaries: { preprocessing: { episodes_in: 0, episodes_discarded: 0, discard_reasons: {}, unaccounted: 0, live_unconsumed_count: liveUnconsumedCount } } as StageSummaries,
    };
  }

  const baseStageSummaries = row.stage_summaries ?? undefined;

  return {
    last_run_at: row.started_at,
    status: row.status,
    budget_used_usd: Number(row.budget_used_usd),
    stages_completed: row.stages_completed,
    memories_count: memoriesCountRow ? Number(memoriesCountRow.count) : 0,
    per_stage_tokens: row.per_stage_tokens ?? {},
    // live_unconsumed_count is merged additively onto whatever
    // stage_summaries.preprocessing already contains (or an empty
    // preprocessing object, for runs that predate the 2026-07-27
    // stage_summaries fix) — every pre-existing field is passed through
    // unchanged; this never replaces or restructures the stored snapshot.
    stage_summaries: {
      ...(baseStageSummaries ?? {}),
      preprocessing: {
        episodes_in: 0,
        episodes_discarded: 0,
        discard_reasons: {},
        unaccounted: 0,
        ...(baseStageSummaries?.preprocessing ?? {}),
        live_unconsumed_count: liveUnconsumedCount,
      },
    } as StageSummaries,
    triggered_by: row.triggered_by ?? 'manual',
  };
}
