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
import { flattenInsights, dedupeInsights, consolidateInsights, type ExistingMemory } from './consolidate';
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
  /**
   * Dream Cycle Confidential Extraction on Flare FCC, Task 2. Opt-in,
   * default false. When true, startDream() requires a settled XRPL/RLUSD
   * payment (Task 3) before runPipeline() is invoked, and extraction routes
   * through Flare's Confidential Compute TEE path (Task 4) instead of the
   * plain services/llm call. Persisted into both dream_configs and
   * dream_cycle_runs.confidential (Task 1's column) at INSERT time.
   */
  confidential?: boolean;
  /**
   * Dream Cycle Confidential Extraction on Flare FCC, Task 9. A STICKY
   * per-agent default — when set (via any start_dream call, typically once),
   * persists into dream_configs.confidential_default and is inherited by
   * every FUTURE start_dream call that omits `confidential` entirely. An
   * explicit per-call `confidential` value always overrides the stored
   * default. Distinct from `confidential` above, which only reflects THIS
   * call's own value. Omit this field to leave any existing stored default
   * untouched (never silently reset to false by a plain start_dream call).
   */
  confidential_default?: boolean;
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
  /**
   * Dream Cycle Confidential Extraction on Flare FCC, Task 3. Present only
   * on a confidential:true call rejected for lack of payment — deliberately
   * NOT underscore-prefixed (unlike _cost above), since gateway.callTool()
   * strips every underscore-prefixed field before returning to the MCP
   * client and the agent needs to see this to know how to pay. Shape matches
   * paywall.ts's buildChallenge() output exactly, so an agent handling the
   * gateway's own -32402 x402 challenge (gateway.ts) can reuse the identical
   * parsing logic for this in-band challenge.
   */
  payment_challenge?: ReturnType<typeof import('../paywall').buildChallenge>;
  /**
   * Additive (2026-08-10, PRD 03 — dream-cycle-fcc-live-session-feedback,
   * Finding B). Present ONLY when the caller's request actually touched
   * `confidential` (an explicit `confidential: true` on this call, OR an
   * inherited `confidential_default` of true) — omitted entirely for a
   * plain non-confidential call, keeping that response byte-identical to
   * before this fix. Reports whether confidential extraction was actually
   * requested and whether it actually ran, so a caller never has to make a
   * separate get_dream_config call to discover a silent downgrade (the
   * exact gap this session's live test found: `start_dream({confidential:
   * true})` against an unsatisfied gate used to return a response
   * indistinguishable from a normal call).
   */
  confidential_requested?: boolean;
  /** Additive, see confidential_requested above. True only when extraction
   *  actually routed through the Flare FCC path for this run. */
  confidential_actual?: boolean;
  /**
   * Additive, see confidential_requested above. Present only when
   * confidential_requested is true and confidential_actual is false —
   * 'feature_disabled' when isMcpDreamConfidentialEnabled() is off,
   * 'no_settled_payment' when the flag is on but no active/consumable
   * 'confidential'-tier paid session exists (mirrors the same condition
   * that produces the payment_challenge error response above, for the case
   * where the run proceeds in plaintext instead of erroring out).
   */
  confidential_fallback_reason?: 'feature_disabled' | 'no_settled_payment';
}

export interface GetDreamConfigResult {
  agent_id: string;
  config: DreamConfig | null;
  last_run_timestamp?: string;
  status?: string;
  /**
   * Dream Cycle Confidential Extraction on Flare FCC, Task 9. The agent's
   * stored settlement preference for the confidential price tier. Only
   * 'xrpl-rlusd' exists today (payment-router.ts's CONFIDENTIAL_TIER_CHAINS
   * is XRPL-only by design) but is stored explicitly rather than hardcoded
   * inline, so a future second settlement option doesn't need a schema
   * change. Absent when config is null (no stored config for this agent).
   */
  preferred_settlement?: string;
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
 *
 * Dream Cycle Confidential Extraction on Flare FCC, Tasks 3+6: when
 * config.confidential is true AND isMcpDreamConfidentialEnabled() is on
 * (default OFF — see platform-flag.ts's doc comment for why), this requires
 * an already-settled 'confidential' price-tier paid session (see paywall.ts's
 * findActiveSession/consumeSession — the SAME session mechanism gateway.ts's
 * callTool() already uses for every other metered tool, not a new payment
 * path). No dream_configs/dream_cycle_runs row is created and runPipeline()
 * is never invoked until that check passes — a confidential run never starts
 * on credit. When the flag is OFF, confidential:true is silently treated as
 * false — byte-identical to the pre-confidential-feature free path, never an
 * error — matching every other v3.0+ sub-flag's "byte-identical off" rollback
 * discipline in this codebase. The tool itself is registered unmetered:true
 * (Task 6) specifically so gateway.ts's own metering never double-charges;
 * this function is the sole payment gate for the confidential path.
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

  const { isMcpDreamConfidentialEnabled } = await import('../../platform-flag');
  // Dream Cycle Confidential Extraction on Flare FCC, Task 9. `confidential`
  // omitted entirely (undefined, not false) inherits the agent's stored
  // confidential_default; an explicit true/false always wins. This lookup
  // is a no-op read (single indexed SELECT) and only runs when needed —
  // callers who always pass an explicit confidential value never pay for it.
  let resolvedConfidential = config.confidential;
  if (resolvedConfidential === undefined) {
    const storedDefault = await withClient(async (client) => {
      const { rows } = await client.query<{ confidential_default: boolean }>(
        `SELECT confidential_default FROM dream_configs WHERE agent_id = $1 LIMIT 1`,
        [agentId],
      );
      return rows[0]?.confidential_default ?? false;
    });
    resolvedConfidential = storedDefault ?? false;
  }
  // Finding B fix (2026-08-10): `confidentialWanted` tracks the caller's
  // actual intent (explicit true, or an inherited confidential_default of
  // true) SEPARATELY from whether the gate (flag + payment) is satisfied —
  // previously `confidentialRequested` conflated the two, so a
  // flag-disabled or unpaid request silently collapsed into "false" with
  // zero trace of the original ask. `confidentialWanted` is what gets
  // reported back via confidential_requested; `confidentialRequested`
  // remains the internal "actually run confidential" gate exactly as before
  // (used for the payment check, dream_configs/dream_cycle_runs.confidential
  // persistence, and runPipeline()'s extraction routing — byte-identical
  // behavior to before this fix in every case).
  const confidentialWanted = resolvedConfidential === true;
  const featureEnabled = isMcpDreamConfidentialEnabled();
  const confidentialRequested = confidentialWanted && featureEnabled;
  // Finding B fix: when the flag is off but the caller wanted confidential,
  // the run still proceeds in plaintext exactly as before this fix (product
  // intent is "best effort," not a hard refusal — PRD 03's accepted
  // response shape) — confidentialRequested is already correctly `false`
  // for this case via the `&& featureEnabled` above, so no special-cased
  // early return is needed; the downgrade is reported at the final return
  // below instead, via confidentialFallbackReason computed once here.
  const confidentialFallbackReason: 'feature_disabled' | undefined = confidentialWanted && !featureEnabled ? 'feature_disabled' : undefined;

  if (confidentialRequested) {
    const { findActiveSession, consumeSession, buildChallenge, TIER_PRICE_USD } = await import('../paywall');
    const active = await findActiveSession(userId, 'confidential');
    const consumed = active ? await consumeSession(active.sessionId) : false;
    if (!consumed) {
      return {
        status: 'error',
        message: `Payment required for confidential Dream Cycle (${TIER_PRICE_USD.confidential} USD equivalent). Call payments.settle with tier="confidential" (XRPL/RLUSD only) to unlock.`,
        payment_challenge: buildChallenge('confidential', 0),
        confidential_requested: true,
        confidential_actual: false,
        confidential_fallback_reason: 'no_settled_payment',
      };
    }
  }

  const ownership = await claimOrCheckOwnership(agentId, userId);
  if (!ownership.ok) {
    return { status: 'error', message: ownership.reason ?? 'ownership check failed' };
  }

  const presetName = DREAM_PRESETS[config.preset] ? config.preset : 'balanced';
  const preset = DREAM_PRESETS[presetName];
  const runId = randomUUID();
  const startedAt = Date.now();

  await withClient(async (client) => {
    await client.query(
      `INSERT INTO dream_configs (agent_id, budget_usd, preset, trigger_criteria, last_run_id, confidential, confidential_default, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7, false),NOW())
       ON CONFLICT (agent_id) DO UPDATE SET
         budget_usd = $2, preset = $3, trigger_criteria = $4, last_run_id = $5, confidential = $6,
         confidential_default = COALESCE($7, dream_configs.confidential_default), updated_at = NOW()`,
      [agentId, config.budget_usd, presetName, config.trigger_criteria ? JSON.stringify(config.trigger_criteria) : null, runId, confidentialRequested, config.confidential_default ?? null],
    );
    await client.query(
      `INSERT INTO dream_cycle_runs (run_id, agent_id, status, config_snapshot, triggered_by, confidential)
       VALUES ($1,$2,'started',$3,$4,$5)`,
      [runId, agentId, JSON.stringify({ budget_usd: config.budget_usd, preset: presetName, trigger_criteria: config.trigger_criteria ?? {}, confidential: confidentialRequested }), triggeredBy, confidentialRequested],
    );
    return true;
  });

  const cost = await runPipeline(runId, agentId, config.budget_usd, preset, confidentialRequested);

  return {
    run_id: runId,
    status: 'started',
    _cost: cost,
    // Finding B fix: only present when the caller's request actually
    // touched `confidential` (explicit true, or an inherited
    // confidential_default of true) — a plain non-confidential call's
    // response stays byte-identical to before this fix (no new fields at
    // all), matching this PRD's own acceptance criterion.
    ...(confidentialWanted
      ? {
          confidential_requested: true,
          confidential_actual: confidentialRequested,
          ...(confidentialFallbackReason ? { confidential_fallback_reason: confidentialFallbackReason } : {}),
        }
      : {}),
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
async function runPipeline(runId: string, agentId: string, budgetUsd: number, preset: DreamPreset, confidential = false): Promise<{ tokensUsed: number; costUsd: number }> {
  const startedAt = Date.now();
  const cost = new CostTracker(budgetUsd);
  const stagesCompleted: string[] = [];
  let memoriesAdded = 0;
  let memoriesRemoved = 0;
  let finalStatus: 'completed' | 'partial' | 'failed' = 'completed';
  /** Dream Cycle Confidential Extraction on Flare FCC, Task 5. See its
   *  set-site in the extraction stage below and its persistence below. */
  let attestationRef: string | undefined;
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

    const extraction = await extractInsights(clusters, cost, preset.max_extraction_output_tokens_per_cluster, confidential);
    stagesCompleted.push('extraction');
    if (extraction.status === 'partial') finalStatus = 'partial';
    // Dream Cycle Confidential Extraction on Flare FCC, Task 5. Captured here,
    // persisted via its own separate UPDATE below (never as a new positional
    // param on the existing $1..$9 terminal-status UPDATE further down —
    // that query's param order is a documented fragile spot, see this file's
    // history and tests/mcp-dream-cycle.test.ts's mock comment). Empty
    // string list today for every real run (FCC/tee-extension never returns
    // genuine output yet) — see extract.ts's Task 5 doc comment.
    if (extraction.attestation_refs.length > 0) attestationRef = extraction.attestation_refs[0];

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

  // Dream Cycle Confidential Extraction on Flare FCC, Task 5. Deliberately a
  // SEPARATE query from the terminal-status UPDATE above, not a new $10 param
  // on it — that query's $1..$9 positional order is a documented fragile
  // spot (a prior additive column change there silently broke a test mock's
  // positional destructure; see tests/mcp-dream-cycle.test.ts's history).
  // No-op (skipped entirely) when attestationRef is unset, which is every run
  // today — FCC/tee-extension never returns genuine output yet.
  if (attestationRef) {
    await withClient(async (client) => {
      await client.query(`UPDATE dream_cycle_runs SET attestation_ref = $1 WHERE run_id = $2`, [attestationRef, runId]);
      return true;
    });
  }

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
      budget_usd: string; preset: string; trigger_criteria: TriggerCriteria | null; updated_at: string; confidential: boolean;
      confidential_default: boolean; preferred_settlement: string;
    }>(
      `SELECT budget_usd, preset, trigger_criteria, confidential, confidential_default, preferred_settlement, updated_at::text FROM dream_configs WHERE agent_id = $1 LIMIT 1`,
      [agentId],
    );
    return rows[0] ?? null;
  });

  if (!row) return { agent_id: agentId, config: null };
  return {
    agent_id: agentId,
    config: {
      budget_usd: Number(row.budget_usd), preset: row.preset, trigger_criteria: row.trigger_criteria ?? undefined,
      confidential: row.confidential === true,
      confidential_default: row.confidential_default === true,
    },
    preferred_settlement: row.preferred_settlement,
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
  /**
   * Dream Cycle Confidential Extraction on Flare FCC, Task 1/6. False for
   * every run predating this feature (column default) or any run that never
   * set confidential:true. attestation_ref is the TEE attestation's
   * quoteHash once Flare FCC returns genuine, attestation-verified output
   * (Task 5) — null otherwise, including for every run today since FCC is
   * not yet live off Songbird canary (see providers/flare.ts's
   * isFccLiveOnNetwork()).
   */
  confidential?: boolean;
  attestation_ref?: string | null;
}

export async function getDreamStats(agentId: string): Promise<DreamStatsResult> {
  const row = await withClient(async (client) => {
    const { rows } = await client.query<{
      started_at: string; status: string; budget_used_usd: string; stages_completed: string[];
      per_stage_tokens: Record<string, number> | null; stage_summaries: StageSummaries | null;
      triggered_by: 'manual' | 'scheduler'; confidential: boolean; attestation_ref: string | null;
    }>(
      `SELECT started_at::text, status, budget_used_usd, stages_completed, per_stage_tokens, stage_summaries, triggered_by, confidential, attestation_ref
       FROM dream_cycle_runs WHERE agent_id = $1 ORDER BY started_at DESC LIMIT 1`,
      [agentId],
    );
    return rows[0] ?? null;
  });

  const memoriesCountRow = await withClient(async (client) => {
    const { rows } = await client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM dream_consolidated_memories WHERE agent_id = $1`, [agentId]);
    return rows[0] ?? null;
  });

  if (!row) return { memories_count: memoriesCountRow ? Number(memoriesCountRow.count) : 0 };

  return {
    last_run_at: row.started_at,
    status: row.status,
    budget_used_usd: Number(row.budget_used_usd),
    stages_completed: row.stages_completed,
    memories_count: memoriesCountRow ? Number(memoriesCountRow.count) : 0,
    per_stage_tokens: row.per_stage_tokens ?? {},
    ...(row.stage_summaries ? { stage_summaries: row.stage_summaries } : {}),
    triggered_by: row.triggered_by ?? 'manual',
    confidential: row.confidential === true,
    attestation_ref: row.attestation_ref ?? null,
  };
}
