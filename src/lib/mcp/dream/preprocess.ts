/**
 * src/lib/mcp/dream/preprocess.ts
 * ---------------------------------
 * Rule-based, zero-LLM size reduction (FR-PRE-1). Pure function, no I/O:
 *  - discard success episodes with <=2 steps (low signal, high volume)
 *  - for failures, keep only the final error + the step preceding it
 *  - truncate text fields to a configurable max chars (default 200)
 *  - emit raw_input_tokens_estimate so the pipeline can log the reduction
 *
 * Runs entirely in-process on already-ingested EpisodeLog rows before
 * clustering (Task 6). No embedding/LLM call happens here.
 */

import type { EpisodeLog, EpisodeStep } from './ingest';

export interface PreprocessConfig {
  max_chars?: number; // default 200
}

export interface PreprocessedEpisode {
  episode_id: string;
  agent_id: string;
  task_type?: string;
  outcome: EpisodeLog['outcome'];
  tags?: string[];
  steps: EpisodeStep[];
  raw_input_tokens_estimate: number;
}

/**
 * Additive (2026-07-27 root-cause fix). Reports what preprocessEpisodes()
 * discarded and why — previously this stage discarded episodes silently
 * with zero client-visible signal, indistinguishable from "there was
 * nothing to discard." Surfaced end-to-end via get_dream_stats (Task 6).
 */
export interface PreprocessSummary {
  episodes_in: number;
  episodes_discarded: number;
  discard_reasons: Record<string, number>;
  /**
   * Safety net, NOT a claimed fix (2026-08-10, PRD 02 —
   * dream-cycle-fcc-live-session-feedback, Finding A). Always
   * `episodes_in - episodes_discarded - <surviving batch length>`. In every
   * currently-understood code path this is 0 — every episode is either
   * discarded (counted in episodes_discarded/discard_reasons) or survives
   * into the returned batch. Its purpose is to make a FUTURE divergence
   * (including possibly a recurrence of the live-session's `episodes_in: 0`
   * despite confirmed ingestion bug) loudly visible in the API response
   * instead of requiring a manual investigation. Finding A's actual root
   * cause was NOT found by static code reading during this fix's own
   * investigation (the unconsumed-episode query and schema are structurally
   * correct) — this field and DREAM_DEBUG_PREPROCESSING (see runPipeline()
   * in pipeline.ts and this file's DEBUG log lines) are a deliberately
   * honest safety net, not a resolution. See
   * docs/prd/dream-cycle-2026-08-10-live-feedback-fixes.md for the
   * documented open status.
   */
  unaccounted: number;
}

export interface PreprocessResult {
  episodes: PreprocessedEpisode[];
  summary: PreprocessSummary;
}

const DEFAULT_MAX_CHARS = 200;

function truncate(text: string | undefined, maxChars: number): string | undefined {
  if (text === undefined) return undefined;
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function truncateStep(step: EpisodeStep, maxChars: number): EpisodeStep {
  return {
    action: truncate(step.action, maxChars) ?? step.action,
    observation_summary: truncate(step.observation_summary, maxChars),
    error: truncate(step.error, maxChars),
    duration_ms: step.duration_ms,
  };
}

function estimateTokens(steps: EpisodeStep[], taskType?: string): number {
  const text = JSON.stringify(steps) + (taskType ?? '');
  return Math.ceil(text.length / 4);
}

/**
 * Preprocess a batch of episodes for ONE agent. Returns the episodes that
 * survive the discard rule, plus a summary of what was discarded and why —
 * this is a size-reduction pass, not validation (which already happened at
 * ingest time).
 *
 * Root-cause fix (2026-07-27): the discard rule used to drop ANY
 * success-outcome episode with <=2 steps — this silently ate exactly the
 * kind of short, high-signal episode ("ran X, it failed/succeeded
 * instantly") that error_pattern/fact extraction most needs, with zero
 * visibility into how much was being thrown away. Only genuinely empty
 * episodes (0 steps — no signal at all) are discarded now; the discard
 * count + reason breakdown is returned so a caller (get_dream_stats, via
 * pipeline.ts) can see it instead of it disappearing silently.
 */
export function preprocessEpisodes(episodes: EpisodeLog[], config: PreprocessConfig = {}): PreprocessResult {
  const maxChars = config.max_chars ?? DEFAULT_MAX_CHARS;
  const result: PreprocessedEpisode[] = [];
  const discardReasons: Record<string, number> = {};
  let discardedCount = 0;

  // Debug instrumentation (2026-08-10, Finding A safety net) — env-gated,
  // zero-cost when unset. Logs the exact input count this function received,
  // for a live-paired debugging session to correlate against the raw DB row
  // count logged in pipeline.ts's runPipeline() at the unconsumed-episode
  // fetch, immediately before this function is called.
  if (process.env.DREAM_DEBUG_PREPROCESSING === 'true') {
    // eslint-disable-next-line no-console
    console.log(`[dream:preprocess] entry episodes_in=${episodes.length}`);
  }

  for (const ep of episodes) {
    // Discard only genuinely empty episodes — zero steps carries no signal
    // at all for any outcome. (Previously also discarded success episodes
    // with <=2 steps; loosened per the 2026-07-27 root-cause fix.)
    if (ep.steps.length === 0) {
      discardedCount++;
      discardReasons.empty_steps = (discardReasons.empty_steps ?? 0) + 1;
      continue;
    }

    let steps: EpisodeStep[];
    if (ep.outcome === 'failure' || ep.outcome === 'timeout') {
      // Keep only the final step (error context) + the step preceding it.
      steps = ep.steps.slice(Math.max(0, ep.steps.length - 2));
    } else {
      steps = ep.steps;
    }
    const truncatedSteps = steps.map((s) => truncateStep(s, maxChars));

    result.push({
      episode_id: ep.episode_id,
      agent_id: ep.agent_id,
      task_type: ep.task_type,
      outcome: ep.outcome,
      tags: ep.tags,
      steps: truncatedSteps,
      raw_input_tokens_estimate: estimateTokens(truncatedSteps, ep.task_type),
    });
  }

  // Accounting invariant (Finding A safety net): every input episode must be
  // either discarded (counted above) or present in `result`. A nonzero value
  // here means episodes vanished somewhere in this function without being
  // accounted for — should be structurally impossible given the loop above
  // (every episode hits either `continue` after incrementing discardedCount,
  // or gets pushed to result), but is computed explicitly rather than
  // assumed, so a future refactor that breaks this invariant fails loudly in
  // the API response instead of silently.
  const unaccounted = episodes.length - discardedCount - result.length;

  if (process.env.DREAM_DEBUG_PREPROCESSING === 'true') {
    // eslint-disable-next-line no-console
    console.log(
      `[dream:preprocess] exit episodes_out=${result.length} discarded=${discardedCount} discard_reasons=${JSON.stringify(discardReasons)} unaccounted=${unaccounted}`,
    );
  }

  return {
    episodes: result,
    summary: { episodes_in: episodes.length, episodes_discarded: discardedCount, discard_reasons: discardReasons, unaccounted },
  };
}
