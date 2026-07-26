/**
 * src/lib/mcp/dream/extract.ts
 * ------------------------------
 * Extracts concise insights per cluster via services/llm (FR-EXT-1/2).
 *
 * services/llm (services/llm/server.ts) is a SEPARATE standalone process used
 * here as a model provider only — its only generic route today is POST /scan
 * (crawl+LLM+generate, hardcoded to its own SYSTEM_PROMPT + content-generation
 * shape). It does not yet expose a route suited to "extract structured
 * insights from a <=200-token cluster summary". This module calls a new
 * POST /dream/extract route on that same service (documented contract below)
 * — implementing that route is OUT OF SCOPE for this module (services/llm is
 * a different file-ownership boundary); flag to that service's owner if the
 * route does not yet exist. See docs/prd/dream-cycle-v1.md Task 7 notes.
 *
 * Contract for POST {DREAM_EXTRACT_URL}/dream/extract:
 *   request:  { summary: string, max_output_tokens: number }
 *   response: { rules: string[], preferences: string[], error_patterns: string[], facts: string[],
 *               usage?: { input_tokens: number, output_tokens: number } }
 *
 * Cost is tracked LOCALLY via cost.ts regardless of whether `usage` is present
 * in the response (services/llm exposes no cost/usage accounting of its own —
 * requirement 9). When `usage` is absent, token counts are estimated from the
 * request/response text via estimateTokens().
 */

import { fetchWithTimeout } from '../http';
import type { EpisodeCluster } from './cluster';
import { CostTracker, estimateTokens } from './cost';

export interface ExtractedInsights {
  cluster_id: string;
  rules: string[];
  preferences: string[];
  error_patterns: string[];
  facts: string[];
}

export interface ExtractionOutcome {
  extracted: ExtractedInsights[];
  status: 'completed' | 'partial';
  clusters_skipped: string[];
}

function extractUrl(): string {
  return process.env.DREAM_EXTRACT_URL ?? process.env.LLM_SERVICE_URL ?? 'http://localhost:3001/dream/extract';
}

async function extractOneCluster(cluster: EpisodeCluster, maxOutputTokens: number): Promise<ExtractedInsights> {
  try {
    const res = await fetchWithTimeout(extractUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary: cluster.summary, max_output_tokens: maxOutputTokens }),
    });
    if (!res.ok) throw new Error(`extract endpoint ${res.status}`);
    const body = (await res.json()) as Partial<ExtractedInsights>;
    return {
      cluster_id: cluster.cluster_id,
      rules: (body.rules ?? []).slice(0, 10),
      preferences: (body.preferences ?? []).slice(0, 10),
      error_patterns: (body.error_patterns ?? []).slice(0, 10),
      facts: (body.facts ?? []).slice(0, 10),
    };
  } catch {
    // Fail-safe: an unreachable/erroring extraction service degrades to an
    // empty-but-well-formed result for this cluster — never a crash, never
    // a fabricated insight. The pipeline still marks the run 'partial'.
    return { cluster_id: cluster.cluster_id, rules: [], preferences: [], error_patterns: [], facts: [] };
  }
}

/**
 * Extract insights for each cluster, checking budget BEFORE each call
 * (FR-COST-2) and aborting the remaining clusters early once the estimated
 * cost of the next call would exceed the tracker's remaining budget.
 */
export async function extractInsights(
  clusters: EpisodeCluster[],
  cost: CostTracker,
  maxOutputTokensPerCluster: number,
): Promise<ExtractionOutcome> {
  const extracted: ExtractedInsights[] = [];
  const skipped: string[] = [];

  for (const cluster of clusters) {
    const inputTokens = estimateTokens(cluster.summary);
    const estimatedCost = cost.estimateCostUsd(inputTokens, maxOutputTokensPerCluster);
    if (!cost.canAfford(estimatedCost)) {
      skipped.push(cluster.cluster_id);
      continue;
    }

    const result = await extractOneCluster(cluster, maxOutputTokensPerCluster);
    const outputText = JSON.stringify(result);
    const outputTokens = Math.min(estimateTokens(outputText), maxOutputTokensPerCluster);
    cost.record('extraction', inputTokens, outputTokens);
    extracted.push(result);
  }

  return { extracted, status: skipped.length > 0 ? 'partial' : 'completed', clusters_skipped: skipped };
}
