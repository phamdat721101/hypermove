/**
 * src/lib/mcp/dream/prune.ts
 * ----------------------------
 * Pruning stage (FR-PRUNE-1/2), rule-based only in Phase 1 (no LLM conflict
 * resolution — explicitly deferred per docs/prd/dream-cycle-v1.md's
 * "Backlog — Phase 2-4"). Pure function over an in-memory memory list:
 *   1. Drop memories below min_confidence or min_importance.
 *   2. Merge/drop pairs with pairwise cosine similarity > 0.95 (keep the
 *      higher-confidence one, bump its source_count).
 *   3. Enforce max_memories_per_agent — if still over the cap, drop the
 *      lowest-value (confidence * importance) memories first.
 *
 * The actual DB deletes/updates happen in pipeline.ts (Task 10); this module
 * only computes WHICH memory_ids survive and the final counts.
 */

import { cosine } from '../vector-store';

export interface PrunableMemory {
  memory_id: string;
  confidence: number;
  importance: number;
  source_count: number;
  embedding: number[];
}

export interface PruneConfig {
  min_confidence?: number; // default 0
  min_importance?: number; // default 0
  max_memories_per_agent?: number; // default 500
}

export interface PruneResult {
  surviving: PrunableMemory[];
  removed_memory_ids: string[];
  memories_removed: number;
}

const NEAR_DUPLICATE_THRESHOLD = 0.95;
const DEFAULT_MAX_MEMORIES = 500;

function value(m: PrunableMemory): number {
  return m.confidence * m.importance;
}

export function pruneMemories(memories: PrunableMemory[], config: PruneConfig = {}): PruneResult {
  const minConfidence = config.min_confidence ?? 0;
  const minImportance = config.min_importance ?? 0;
  const maxCount = config.max_memories_per_agent ?? DEFAULT_MAX_MEMORIES;
  const removedIds: string[] = [];

  // 1. Threshold pruning.
  let survivors = memories.filter((m) => {
    const keep = m.confidence >= minConfidence && m.importance >= minImportance;
    if (!keep) removedIds.push(m.memory_id);
    return keep;
  });

  // 2. Near-duplicate merge: for each pair with similarity > 0.95, drop the
  // lower-confidence one (keep the higher-confidence one, bump its
  // source_count by the dropped one's source_count).
  let changed = true;
  while (changed) {
    changed = false;
    outer: for (let i = 0; i < survivors.length; i++) {
      for (let j = i + 1; j < survivors.length; j++) {
        if (cosine(survivors[i].embedding, survivors[j].embedding) > NEAR_DUPLICATE_THRESHOLD) {
          const [keep, drop] = survivors[i].confidence >= survivors[j].confidence ? [i, j] : [j, i];
          removedIds.push(survivors[drop].memory_id);
          survivors[keep] = { ...survivors[keep], source_count: survivors[keep].source_count + survivors[drop].source_count };
          survivors = survivors.filter((_, idx) => idx !== drop);
          changed = true;
          break outer;
        }
      }
    }
  }

  // 3. Enforce max count — drop lowest-value (confidence * importance) first.
  if (survivors.length > maxCount) {
    const sorted = [...survivors].sort((a, b) => value(b) - value(a));
    const kept = sorted.slice(0, maxCount);
    const dropped = sorted.slice(maxCount);
    removedIds.push(...dropped.map((m) => m.memory_id));
    survivors = kept;
  }

  return { surviving: survivors, removed_memory_ids: removedIds, memories_removed: removedIds.length };
}
