/**
 * src/lib/mcp/dream/ingest.ts
 * ----------------------------
 * submit_episode_log's core logic: validation + idempotent zero-LLM cold
 * storage insert into dream_episode_logs. No embedding/LLM call happens here
 * (FR-INGEST-2) — that only happens later, inside start_dream's pipeline.
 */

import { withClient } from '../../db';
import { claimOrCheckOwnership } from './ownership';

export interface EpisodeStep {
  action: string;
  result?: string;
  observation_summary?: string;
  error?: string;
  duration_ms?: number;
}

export interface EpisodeLog {
  episode_id: string;
  agent_id: string;
  timestamp: string;
  task_type?: string;
  steps: EpisodeStep[];
  outcome: 'success' | 'failure' | 'timeout';
  tags?: string[];
}

export interface RejectedEpisode {
  episode_id: string;
  reason: string;
}

export interface IngestResult {
  ingested_count: number;
  rejected: RejectedEpisode[];
  /** Additive compatibility signal for callers still sending `steps[].result`. */
  normalized_fields?: { episode_id: string; fields: string[] }[];
  /**
   * Ergonomics fix (2026-08-10, PRD 05 — dream-cycle-fcc-live-session-feedback).
   * Groups `rejected` by exact reason string and counts occurrences, so a
   * caller whose whole batch was rejected for one root cause (e.g. an
   * ownership conflict, which rejects every episode in the batch with the
   * identical message) sees one summarized count instead of having to
   * de-duplicate N identical strings themselves. Per-episode detail in
   * `rejected` is unchanged and still fully present. Omitted when
   * `rejected` is empty.
   */
  rejected_reason_summary?: Record<string, number>;
}

const VALID_OUTCOMES = new Set(['success', 'failure', 'timeout']);
const STEP_KEYS = new Set(['action', 'observation_summary', 'result', 'error', 'duration_ms']);

function normalizeEpisode(ep: unknown): { episode: EpisodeLog; normalizedFields: string[] } | { reason: string } {
  const reason = validateEpisode(ep);
  if (reason) return { reason };
  const raw = ep as EpisodeLog & { steps: Array<EpisodeStep & { result?: unknown; [key: string]: unknown }> };
  const normalizedFields: string[] = [];
  const steps: EpisodeStep[] = [];
  for (let index = 0; index < raw.steps.length; index++) {
    const step = raw.steps[index];
    if (typeof step !== 'object' || step === null || typeof step.action !== 'string' || step.action.trim().length === 0) {
      return { reason: `invalid step at index ${index}: action must be a non-empty string` };
    }
    const unknown = Object.keys(step).filter((key) => !STEP_KEYS.has(key));
    if (unknown.length > 0) return { reason: `unsupported step field(s) at index ${index}: ${unknown.join(', ')}` };
    const result = typeof step.result === 'string' ? step.result : typeof step.observation_summary === 'string' ? step.observation_summary : step.action;
    if (result.trim().length === 0) return { reason: `invalid step at index ${index}: result must be a non-empty string` };
    if (step.result !== undefined && step.observation_summary === undefined) normalizedFields.push(`steps[${index}].result→observation_summary`);
    if (step.result === undefined) normalizedFields.push(`steps[${index}].observation_summary→result`);
    steps.push({
      action: step.action,
      result,
      observation_summary: typeof step.observation_summary === 'string' ? step.observation_summary : result,
      error: typeof step.error === 'string' ? step.error : undefined,
      duration_ms: typeof step.duration_ms === 'number' ? step.duration_ms : undefined,
    });
  }
  return { episode: { ...raw, steps }, normalizedFields };
}

/** Structural validation only — no I/O. Returns a reason string, or null if valid. */
function validateEpisode(ep: unknown): string | null {
  if (typeof ep !== 'object' || ep === null) return 'episode is not an object';
  const e = ep as Partial<EpisodeLog>;
  if (!e.episode_id || typeof e.episode_id !== 'string') return 'missing or invalid episode_id';
  if (!e.agent_id || typeof e.agent_id !== 'string') return 'missing or invalid agent_id';
  if (!e.timestamp || typeof e.timestamp !== 'string' || Number.isNaN(Date.parse(e.timestamp))) {
    return 'missing or invalid timestamp (expected ISO 8601)';
  }
  if (!e.outcome || !VALID_OUTCOMES.has(e.outcome)) return 'missing or invalid outcome (success|failure|timeout)';
  if (!Array.isArray(e.steps)) return 'missing or invalid steps (expected array)';
  return null;
}

/**
 * Ingest a batch of episode logs for one agent_id. Ownership is checked once
 * for the whole batch (all episodes in a call share the same agent_id per
 * the tool's input schema). Malformed episodes are rejected individually;
 * duplicate episode_id for the same agent_id is a silent no-op (idempotent),
 * not an error, matching FR-INGEST-1/2.
 */
export async function ingestEpisodes(
  agentId: string,
  userId: string,
  episodes: unknown[],
): Promise<IngestResult> {
  const ownership = await claimOrCheckOwnership(agentId, userId);
  if (!ownership.ok) {
    const reason = ownership.reason ?? 'ownership check failed';
    const rejected = episodes.map((ep) => ({
      episode_id: (ep as Partial<EpisodeLog>)?.episode_id ?? 'unknown',
      reason,
    }));
    return {
      ingested_count: 0,
      rejected,
      ...(rejected.length > 0 ? { rejected_reason_summary: summarizeRejectionReasons(rejected) } : {}),
    };
  }

  const rejected: RejectedEpisode[] = [];
  const valid: EpisodeLog[] = [];
  const normalizedFields: { episode_id: string; fields: string[] }[] = [];

  for (const ep of episodes) {
    const normalized = normalizeEpisode(ep);
    if ('reason' in normalized) {
      rejected.push({ episode_id: (ep as Partial<EpisodeLog>)?.episode_id ?? 'unknown', reason: normalized.reason });
      continue;
    }
    const e = normalized.episode;
    if (e.agent_id !== agentId) {
      rejected.push({ episode_id: e.episode_id, reason: `episode.agent_id "${e.agent_id}" does not match the call's agent_id "${agentId}"` });
      continue;
    }
    if (normalized.normalizedFields.length > 0) normalizedFields.push({ episode_id: e.episode_id, fields: normalized.normalizedFields });
    valid.push(e);
  }

  let ingestedCount = 0;
  for (const e of valid) {
    const inserted = await withClient(async (client) => {
      const { rowCount } = await client.query(
        `INSERT INTO dream_episode_logs
           (episode_id, agent_id, occurred_at, task_type, steps, outcome, tags, raw_tokens_estimate)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (agent_id, episode_id) DO NOTHING`,
        [
          e.episode_id, e.agent_id, e.timestamp, e.task_type ?? null,
          JSON.stringify(e.steps), e.outcome, e.tags ?? null,
          estimateRawTokens(e),
        ],
      );
      return rowCount ?? 0;
    });
    // withClient() returns null when DATABASE_URL is unset (dev/mock-first) —
    // still count it as ingested so the tool is exercisable without a live DB,
    // matching every other dream_*/mcp_* module's no-op convention.
    if (inserted === null || inserted > 0) ingestedCount++;
  }

  return {
    ingested_count: ingestedCount,
    rejected,
    ...(normalizedFields.length > 0 ? { normalized_fields: normalizedFields } : {}),
    ...(rejected.length > 0 ? { rejected_reason_summary: summarizeRejectionReasons(rejected) } : {}),
  };
}

/** Groups rejected episodes by exact reason string, counting occurrences. */
function summarizeRejectionReasons(rejected: RejectedEpisode[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const r of rejected) summary[r.reason] = (summary[r.reason] ?? 0) + 1;
  return summary;
}

/** Cheap, deterministic token estimate (chars/4) — no LLM/embedding call. */
function estimateRawTokens(e: EpisodeLog): number {
  const text = JSON.stringify(e.steps) + (e.task_type ?? '');
  return Math.ceil(text.length / 4);
}
