/**
 * src/lib/mcp/dream/cluster.ts
 * ------------------------------
 * Semantic clustering of preprocessed episodes (FR-CLUST-1/2). Non-LLM:
 * embeds via getEmbedder() (mock-first, deterministic — see embeddings.ts)
 * and groups by cosine similarity threshold, reusing cosine() from
 * vector-store.ts. Never mixes agent_id (this module is called once per
 * agent per cycle, but the guard is explicit/asserted regardless). Bounded
 * by the active preset's max_clusters.
 */

import { getEmbedder } from '../embeddings';
import { cosine } from '../vector-store';
import type { PreprocessedEpisode } from './preprocess';

export interface EpisodeCluster {
  cluster_id: string;
  agent_id: string;
  episode_ids: string[];
  size: number;
  time_range: { start?: string; end?: string };
  dominant_tags: string[];
  centroid_embedding: number[];
  /** Cheap summary text (<=200 chars) fed to the extraction stage — not a raw dump. */
  summary: string;
}

const SIMILARITY_THRESHOLD = 0.75;

function summarize(episodes: PreprocessedEpisode[]): string {
  const parts = episodes.map((e) => `${e.outcome}:${e.task_type ?? 'unknown'}:${e.steps.map((s) => s.action).join(',')}`);
  const joined = parts.join(' | ');
  return joined.length > 200 ? joined.slice(0, 200) : joined;
}

function dominantTags(episodes: PreprocessedEpisode[]): string[] {
  const counts = new Map<string, number>();
  for (const e of episodes) for (const t of e.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([tag]) => tag);
}

function centroid(vectors: number[][]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0].length;
  const sum = new Array<number>(dim).fill(0);
  for (const v of vectors) for (let i = 0; i < dim; i++) sum[i] += v[i];
  return sum.map((x) => x / vectors.length);
}

/**
 * Cluster preprocessed episodes for ONE agent. Throws if episodes from more
 * than one agent_id are passed in — this is a hard invariant, not a soft
 * filter, since cross-agent mixing would leak one agent's learned patterns
 * into another agent's memory store.
 */
export async function clusterEpisodes(
  episodes: PreprocessedEpisode[],
  opts: { maxClusters: number },
): Promise<EpisodeCluster[]> {
  if (episodes.length === 0) return [];
  const agentIds = new Set(episodes.map((e) => e.agent_id));
  if (agentIds.size > 1) {
    throw new Error(`clusterEpisodes received episodes from multiple agent_ids: ${[...agentIds].join(', ')}`);
  }
  const agentId = episodes[0].agent_id;

  const embedder = getEmbedder();
  const embeddings = await Promise.all(
    episodes.map((e) => embedder.embed(`${e.task_type ?? ''} ${e.outcome} ${e.steps.map((s) => s.action).join(' ')}`)),
  );

  // Greedy threshold clustering: for each episode, join the first existing
  // cluster whose centroid is similar enough; otherwise start a new one.
  // Bounded by maxClusters — once the cap is hit, remaining episodes join
  // their nearest existing cluster regardless of threshold (never exceed
  // the preset's cap).
  const groups: { indices: number[]; centroidVec: number[] }[] = [];

  for (let i = 0; i < episodes.length; i++) {
    const vec = embeddings[i];
    let bestIdx = -1;
    let bestScore = -1;
    for (let g = 0; g < groups.length; g++) {
      const score = cosine(vec, groups[g].centroidVec);
      if (score > bestScore) { bestScore = score; bestIdx = g; }
    }

    const canCreateNew = groups.length < opts.maxClusters;
    if (bestIdx >= 0 && (bestScore >= SIMILARITY_THRESHOLD || !canCreateNew)) {
      groups[bestIdx].indices.push(i);
      groups[bestIdx].centroidVec = centroid(groups[bestIdx].indices.map((idx) => embeddings[idx]));
    } else {
      groups.push({ indices: [i], centroidVec: vec });
    }
  }

  return groups.map((g, idx) => {
    const groupEpisodes = g.indices.map((i) => episodes[i]);
    const times = groupEpisodes.map((e) => e.episode_id); // no timestamp on PreprocessedEpisode; time_range left best-effort
    return {
      cluster_id: `${agentId}-cluster-${idx}`,
      agent_id: agentId,
      episode_ids: groupEpisodes.map((e) => e.episode_id),
      size: groupEpisodes.length,
      time_range: { start: times[0], end: times[times.length - 1] },
      dominant_tags: dominantTags(groupEpisodes),
      centroid_embedding: g.centroidVec,
      summary: summarize(groupEpisodes),
    };
  });
}
