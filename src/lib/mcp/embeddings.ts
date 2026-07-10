/**
 * src/lib/mcp/embeddings.ts
 * -------------------------
 * Embedder interface + a deterministic MockEmbedder (zero-config default) and
 * an optional RemoteEmbedder (lazy fetch to an embeddings endpoint — e.g. the
 * LLM service or a bge-large host). Mock-first: no endpoint configured → mock.
 *
 * SOLID: consumers depend on the Embedder interface; the concrete impl is
 * selected by getEmbedder() from env.
 */

import { createHash } from 'node:crypto';
import { fetchWithTimeout } from './http';

export interface Embedder {
  readonly dim: number;
  embed(text: string): Promise<number[]>;
}

/** Deterministic hash-bucket embedding — same text → same vector, always. */
export class MockEmbedder implements Embedder {
  readonly dim: number;
  constructor(dim = 64) { this.dim = dim; }

  async embed(text: string): Promise<number[]> {
    const vec = new Array<number>(this.dim).fill(0);
    const tokens = text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
    for (const tok of tokens) {
      const h = parseInt(createHash('sha256').update(tok).digest('hex').slice(0, 8), 16);
      vec[h % this.dim] += 1;
    }
    // L2-normalize so cosine == dot product.
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0)) || 1;
    return vec.map((x) => x / norm);
  }
}

/** Optional remote embedder — used only when EMBEDDINGS_URL is set. */
class RemoteEmbedder implements Embedder {
  readonly dim: number;
  private fallback: MockEmbedder;
  constructor(private url: string, dim: number) { this.dim = dim; this.fallback = new MockEmbedder(dim); }

  async embed(text: string): Promise<number[]> {
    try {
      const res = await fetchWithTimeout(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ input: text }),
      });
      if (!res.ok) throw new Error(`embeddings ${res.status}`);
      const body = (await res.json()) as { embedding?: number[]; data?: { embedding: number[] }[] };
      const vec = body.embedding ?? body.data?.[0]?.embedding;
      if (!vec) throw new Error('no embedding in response');
      return vec;
    } catch {
      // Fail-safe: degrade to a mock vector of the SAME dim so cosine stays valid.
      return this.fallback.embed(text);
    }
  }
}

let cached: Embedder | null = null;

export function getEmbedder(): Embedder {
  if (cached) return cached;
  const url = process.env.EMBEDDINGS_URL;
  cached = url ? new RemoteEmbedder(url, Number(process.env.EMBEDDINGS_DIM ?? 1024)) : new MockEmbedder();
  return cached;
}

/** Test hook. */
export function _resetEmbedder(): void {
  cached = null;
}
