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

export interface ContradictionRecord {
  existing_sop: string;
  conflicting_trace: string;
  reason: string;
}

export interface ConsolidationResult {
  memories_added: number;
  memories_merged: number;
  librarian_neutralized_count: number;
  flagged_contradictions: ContradictionRecord[];
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

const NEGATION_PATTERNS = [/not\s+/i, /never\s+/i, /don't\s+/i, /do not\s+/i, /avoid\s+/i, /instead of\s+/i, /no longer\s+/i, /deprecated\s+/i];

/**
 * Phase 3 Librarian Hygiene pass: scan new insights against existing SOPs/memories.
 * Detects contradictory instructions and records them in dream_contradictions.
 */
export async function librarianScan(
  agentId: string,
  insights: FlatInsight[],
  existingMemories: ExistingMemory[],
): Promise<ContradictionRecord[]> {
  const contradictions: ContradictionRecord[] = [];
  const rules = existingMemories.filter((m) => m.type === 'rule');

  for (const insight of insights) {
    if (insight.type !== 'rule') continue;
    const hasNegation = NEGATION_PATTERNS.some((pat) => pat.test(insight.content));

    for (const rule of rules) {
      // Check if both rules touch similar keywords but one is negative and one is affirmative
      const ruleHasNegation = NEGATION_PATTERNS.some((pat) => pat.test(rule.content));
      if (hasNegation !== ruleHasNegation) {
        // Compare overlap of words (excluding stop words and negations)
        const wordsA = new Set(insight.content.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
        const wordsB = new Set(rule.content.toLowerCase().split(/\W+/).filter((w) => w.length > 3));
        const overlap = Array.from(wordsA).filter((w) => wordsB.has(w));

        if (overlap.length >= 2) {
          const rec: ContradictionRecord = {
            existing_sop: rule.content,
            conflicting_trace: insight.content,
            reason: `Logical contradiction detected on keywords: ${overlap.join(', ')}`,
          };
          contradictions.push(rec);

          await withClient(async (client) => {
            await client.query(
              `INSERT INTO dream_contradictions (agent_id, existing_sop, conflicting_trace, reason, status)
               VALUES ($1, $2, $3, $4, 'flagged')`,
              [agentId, rule.content, insight.content, rec.reason],
            );
            return true;
          });
        }
      }
    }
  }

  return contradictions;
}

/**
 * Consolidate deduplicated insights for ONE agent against its existing
 * memories. Merges into an existing row when cosine similarity > 0.85
 * (same type only — a rule never merges into a fact), else inserts new.
 */
export async function consolidateInsights(
  agentId: string,
  insights: FlatInsight[],
  existingMemories: ExistingMemory[],
): Promise<ConsolidationResult> {
  const embedder = getEmbedder();
  let added = 0;
  let merged = 0;

  // Run Phase 3 Librarian Hygiene scan before consolidation
  const flaggedContradictions = await librarianScan(agentId, insights, existingMemories);

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

  return {
    memories_added: added,
    memories_merged: merged,
    librarian_neutralized_count: flaggedContradictions.length,
    flagged_contradictions: flaggedContradictions,
  };
}
