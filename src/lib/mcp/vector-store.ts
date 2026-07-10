/**
 * src/lib/mcp/vector-store.ts
 * ---------------------------
 * VectorStore interface + a default in-process implementation. Consumers depend
 * on the interface (Dependency Inversion), so a pgvector-backed store can be
 * dropped in later with zero call-site changes.
 *
 * Why in-process by default: the v1.0 catalog is O(hundreds) of entries and
 * embeddings are deterministic + cheap, so an in-memory cosine scan is faster
 * to deploy (no `CREATE EXTENSION vector`) and has negligible latency. For
 * large-scale news volume, swap in a PgVectorStore behind this same interface.
 */

export interface VectorItem<M = unknown> {
  id: string;
  embedding: number[];
  meta: M;
}

export interface VectorMatch<M = unknown> {
  id: string;
  score: number; // cosine similarity 0..1
  meta: M;
}

export interface VectorStore<M = unknown> {
  upsert(items: VectorItem<M>[]): void;
  query(vector: number[], k: number): VectorMatch<M>[];
  size(): number;
}

export function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/** Default in-process store — deterministic ordering, no external infra. */
export class MemoryVectorStore<M = unknown> implements VectorStore<M> {
  private items = new Map<string, VectorItem<M>>();

  upsert(items: VectorItem<M>[]): void {
    for (const it of items) this.items.set(it.id, it);
  }

  query(vector: number[], k: number): VectorMatch<M>[] {
    const matches: VectorMatch<M>[] = [];
    for (const it of this.items.values()) {
      matches.push({ id: it.id, score: cosine(vector, it.embedding), meta: it.meta });
    }
    return matches
      .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
      .slice(0, Math.max(1, k));
  }

  size(): number {
    return this.items.size;
  }
}
