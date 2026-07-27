/**
 * src/lib/mcp/dream/consolidate.ts
 * ----------------------------------
 * Deduplication + consolidation (FR-EXT-3, FR-CONS-1/2). Two passes, both
 * non-LLM:
 *   1. Exact/near-exact string dedup across all cluster-extracted insights
 *      for this cycle (case-insensitive trim comparison).
 *   2. Per-insight, similarity-merge (cosine > 0.85, reusing the same
 *      embedder + cosine() as cluster.ts) into an EXISTING
 *      dream_consolidated_memories row (bumping confidence/source_count,
 *      preserving memory_id) — or insert a new row if no similar memory
 *      exists yet.
 */

import { getEmbedder } from '../embeddings';
import { cosine } from '../vector-store';
import { withClient } from '../../db';
import type { ExtractedInsights } from './extract';

export type MemoryType = 'rule' | 'error_pattern' | 'preference' | 'fact';

export interface FlatInsight {
  type: MemoryType;
  content: string;
}

export interface ExistingMemory {
  memory_id: string;
  type: MemoryType;
  content: string;
  confidence: number;
  source_count: number;
  embedding: number[];
}

export interface ConsolidationResult {
  memories_added: number;
  memories_merged: number;
}

const MERGE_SIMILARITY_THRESHOLD = 0.85;
const MAX_CONTENT_CHARS = 200;

/** Flatten extracted insights into (type, content) pairs, capped at 200 chars each. */
export function flattenInsights(extracted: ExtractedInsights[]): FlatInsight[] {
  const out: FlatInsight[] = [];
  for (const e of extracted) {
    for (const content of e.rules) out.push({ type: 'rule', content: content.slice(0, MAX_CONTENT_CHARS) });
    for (const content of e.preferences) out.push({ type: 'preference', content: content.slice(0, MAX_CONTENT_CHARS) });
    for (const content of e.error_patterns) out.push({ type: 'error_pattern', content: content.slice(0, MAX_CONTENT_CHARS) });
    for (const content of e.facts) out.push({ type: 'fact', content: content.slice(0, MAX_CONTENT_CHARS) });
  }
  return out;
}

/** Exact/near-exact dedup — case-insensitive, trimmed. Non-LLM (FR-EXT-3). */
export function dedupeInsights(insights: FlatInsight[]): FlatInsight[] {
  const seen = new Set<string>();
  const out: FlatInsight[] = [];
  for (const insight of insights) {
    const key = `${insight.type}:${insight.content.trim().toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(insight);
  }
  return out;
}

/**
 * Consolidate deduplicated insights for ONE agent against its existing
 * memories. Merges into an existing row when cosine similarity > 0.85
 * (same type only — a rule never merges into a fact), else inserts new.
 *
 * PRD-C note (2026-07-27 dream-cycle-practical-readiness-feedback): on a
 * fresh agent's very first start_dream call, `existingMemories` is empty, so
 * this loop's first iteration has zero merge candidates — every insight in
 * that first batch inserts as new until items start accumulating in the
 * local `memories` array mid-loop. This is intentional and already correct
 * (the local copy lets later insights in the SAME batch merge into ones
 * inserted earlier in that same call — no self-merge, no missed merges) —
 * flagged here only so a future reader doesn't mistake "first batch always
 * inserts every insight as new" for a bug. There is no minimum batch size
 * or warm-up period required before merging starts working.
 */
export async function consolidateInsights(
  agentId: string,
  insights: FlatInsight[],
  existingMemories: ExistingMemory[],
): Promise<ConsolidationResult> {
  const embedder = getEmbedder();
  let added = 0;
  let merged = 0;

  // Work on a local mutable copy so multiple insights in the same batch can
  // merge into a memory created earlier in this same call (no self-merge).
  const memories = [...existingMemories];

  for (const insight of insights) {
    const vec = await embedder.embed(insight.content);
    let bestIdx = -1;
    let bestScore = -1;
    for (let i = 0; i < memories.length; i++) {
      if (memories[i].type !== insight.type) continue;
      const score = cosine(vec, memories[i].embedding);
      if (score > bestScore) { bestScore = score; bestIdx = i; }
    }

    if (bestIdx >= 0 && bestScore > MERGE_SIMILARITY_THRESHOLD) {
      const existing = memories[bestIdx];
      const newConfidence = Math.min(1, existing.confidence + 0.05);
      const newSourceCount = existing.source_count + 1;
      await withClient(async (client) => {
        await client.query(
          `UPDATE dream_consolidated_memories SET confidence = $1, source_count = $2, last_accessed_at = NOW()
           WHERE memory_id = $3`,
          [newConfidence, newSourceCount, existing.memory_id],
        );
        return true;
      });
      memories[bestIdx] = { ...existing, confidence: newConfidence, source_count: newSourceCount };
      merged++;
    } else {
      const inserted = await withClient(async (client) => {
        const { rows } = await client.query<{ memory_id: string }>(
          `INSERT INTO dream_consolidated_memories (agent_id, type, content, confidence, importance, source_count, embedding)
           VALUES ($1,$2,$3,0.5,0.5,1,$4)
           RETURNING memory_id`,
          [agentId, insight.type, insight.content, JSON.stringify(vec)],
        );
        return rows[0]?.memory_id ?? null;
      });
      memories.push({
        memory_id: inserted ?? `local-${memories.length}`,
        type: insight.type,
        content: insight.content,
        confidence: 0.5,
        source_count: 1,
        embedding: vec,
      });
      added++;
    }
  }

  return { memories_added: added, memories_merged: merged };
}
