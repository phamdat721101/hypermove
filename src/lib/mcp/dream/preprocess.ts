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

  return {
    episodes: result,
    summary: { episodes_in: episodes.length, episodes_discarded: discardedCount, discard_reasons: discardReasons },
  };
}
