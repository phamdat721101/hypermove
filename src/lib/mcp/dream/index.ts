/**
 * src/lib/mcp/dream/index.ts
 * ----------------------------
 * Rebuild-on-read per-agent vector index (FR-INDEX-1, requirement 8).
 *
 * MemoryVectorStore (vector-store.ts) is a Map-backed, in-process structure
 * with NO persistence — confirmed by reading its source. It will NOT survive
 * across serverless/Lambda invocations or multiple instances. This module
 * NEVER assumes it does: on first query_dream call or resource read per
 * process for a given agent_id, it lazily rebuilds that agent's index from
 * dream_consolidated_memories rows in Postgres, then caches the resulting
 * store in-process for the REST OF THAT PROCESS's lifetime only (a fresh
 * process — a new Lambda invocation, a restart — gets a fresh, empty cache
 * and rebuilds again on its own first read).
 */

import { withClient } from '../../db';
import { MemoryVectorStore } from '../vector-store';

export interface IndexedMemory {
  memory_id: string;
  type: string;
  content: string;
  confidence: number;
  importance: number;
  source_count: number;
}

// Per-process cache: agent_id -> store. Deliberately module-level (not a
// class instance) — every caller in this process shares the same cache, and
// a fresh process always starts with an empty Map (no assumption of
// cross-process persistence).
const perAgentCache = new Map<string, MemoryVectorStore<IndexedMemory>>();

/** Test hook — clears the per-process cache, simulating a fresh process. */
export function _resetDreamIndexCache(): void {
  perAgentCache.clear();
}

/**
 * Return the (possibly freshly rebuilt) MemoryVectorStore for one agent_id.
 * Bounded query cost: Phase 1 caps memories at 500/agent (prune.ts), so a
 * full rebuild is cheap even on a cold cache.
 */
export async function getAgentIndex(agentId: string): Promise<MemoryVectorStore<IndexedMemory>> {
  const cached = perAgentCache.get(agentId);
  if (cached) return cached;

  const store = new MemoryVectorStore<IndexedMemory>();
  const rows = await withClient(async (client) => {
    const { rows } = await client.query<{
      memory_id: string; type: string; content: string; confidence: number; importance: number; source_count: number; embedding: number[] | null;
    }>(
      `SELECT memory_id, type, content, confidence, importance, source_count, embedding
       FROM dream_consolidated_memories WHERE agent_id = $1`,
      [agentId],
    );
    return rows;
  });

  if (rows) {
    store.upsert(
      rows
        .filter((r) => Array.isArray(r.embedding))
        .map((r) => ({
          id: r.memory_id,
          embedding: r.embedding as number[],
          meta: { memory_id: r.memory_id, type: r.type, content: r.content, confidence: r.confidence, importance: r.importance, source_count: r.source_count },
        })),
    );
  }

  perAgentCache.set(agentId, store);
  return store;
}
