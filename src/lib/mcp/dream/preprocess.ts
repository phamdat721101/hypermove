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
 * Preprocess a batch of episodes for ONE agent. Returns only the episodes
 * that survive the discard rule; discarded episodes are simply absent from
 * the result (no rejection reasons — this is a size-reduction pass, not
 * validation, which already happened at ingest time).
 */
export function preprocessEpisodes(episodes: EpisodeLog[], config: PreprocessConfig = {}): PreprocessedEpisode[] {
  const maxChars = config.max_chars ?? DEFAULT_MAX_CHARS;
  const result: PreprocessedEpisode[] = [];

  for (const ep of episodes) {
    // Discard low-signal success episodes with <=2 steps.
    if (ep.outcome === 'success' && ep.steps.length <= 2) continue;

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

  return result;
}
