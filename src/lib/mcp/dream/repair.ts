/**
 * Non-destructive repair for a completed Dream run with semantically generic
 * memories. Preview is read-only; apply requires explicit selected IDs and
 * replays only the source run's retained episode rows.
 */

import { withClient } from '../../db';
import { claimOrCheckOwnership } from './ownership';
import { formatEpisodeSemanticText } from './preprocess';
import { filterGenericInsights, replayDreamRun } from './pipeline';
import type { FlatInsight } from './consolidate';
import type { EpisodeLog } from './ingest';
import { _resetDreamIndexCache } from './index';

interface RepairMemory extends FlatInsight { memory_id: string; }

async function sourceText(agentId: string, runId: string): Promise<string | null> {
  const rows = await withClient(async (client) => {
    const { rows } = await client.query<{
      episode_id: string; agent_id: string; task_type: string | null; outcome: EpisodeLog['outcome']; tags: string[] | null; steps: EpisodeLog['steps'];
    }>(
      `SELECT episode_id, agent_id, task_type, outcome, tags, steps
       FROM dream_episode_logs WHERE agent_id = $1 AND consumed_by_run = $2`,
      [agentId, runId],
    );
    return rows;
  });
  if (!rows || rows.length === 0) return null;
  return rows.map((row) => formatEpisodeSemanticText({
    task_type: row.task_type ?? undefined,
    outcome: row.outcome,
    tags: row.tags ?? undefined,
    steps: row.steps,
  })).join('\n');
}

export async function previewDreamRepair(agentId: string, userId: string, sourceRunId: string) {
  const ownership = await claimOrCheckOwnership(agentId, userId);
  if (!ownership.ok) return { ok: false, reason: ownership.reason ?? 'ownership check failed', suggested_memory_ids: [] as string[] };
  const source = await sourceText(agentId, sourceRunId);
  if (!source) return { ok: false, reason: 'source run has no retained episodes for this agent', suggested_memory_ids: [] as string[] };
  const memories = await withClient(async (client) => {
    const { rows } = await client.query<RepairMemory>(
      `SELECT memory_id, type, content FROM dream_consolidated_memories
       WHERE agent_id = $1 AND quarantined_at IS NULL`, [agentId],
    );
    return rows;
  }) ?? [];
  const generic = filterGenericInsights(memories, source).rejected;
  const suggested = new Set(generic.map((memory) => (memory as RepairMemory).memory_id));
  return {
    ok: true,
    source_run_id: sourceRunId,
    source_chars: source.length,
    suggested_memory_ids: memories.filter((memory) => suggested.has(memory.memory_id)).map((memory) => memory.memory_id),
  };
}

export async function applyDreamRepair(agentId: string, userId: string, sourceRunId: string, memoryIds: string[], confirm: boolean) {
  if (!confirm) return { ok: false, reason: 'set confirm=true after reviewing the repair preview' };
  if (memoryIds.length === 0) return { ok: false, reason: 'select at least one memory_id to quarantine' };
  const preview = await previewDreamRepair(agentId, userId, sourceRunId);
  if (!preview.ok) return preview;
  const suggested = new Set(preview.suggested_memory_ids);
  const invalid = memoryIds.filter((id) => !suggested.has(id));
  if (invalid.length > 0) return { ok: false, reason: `memory_ids are not suggested by this source run: ${invalid.join(', ')}` };
  await withClient(async (client) => {
    await client.query(
      `UPDATE dream_consolidated_memories
       SET quarantined_at = NOW(), quarantine_reason = $1
       WHERE agent_id = $2 AND memory_id = ANY($3::uuid[]) AND quarantined_at IS NULL`,
      [`semantic repair from run ${sourceRunId}`, agentId, memoryIds],
    );
    return true;
  });
  _resetDreamIndexCache();
  const replay = await replayDreamRun(agentId, userId, sourceRunId);
  return { ok: replay.status !== 'error', quarantined_memory_ids: memoryIds, replay };
}
