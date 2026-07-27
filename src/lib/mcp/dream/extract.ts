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
  /**
   * Additive (2026-07-27 root-cause fix). Cluster ids whose extraction call
   * completed (HTTP 2xx) but ultimately failed to yield genuine insights —
   * either because the HTTP call itself threw/errored (network, non-2xx) OR
   * because the LLM's response never parsed into a valid 4-key JSON object
   * even after services/llm's internal retry (see extraction_failure_reason
   * on the raw response). Distinct from clusters_skipped, which is reserved
   * for clusters never attempted at all due to budget exhaustion. A cluster
   * landing here contributes ZERO extracted insights AND zero recorded
   * cost — see extractInsights() below.
   */
  clusters_failed_extraction: string[];
}

function extractUrl(): string {
  return process.env.DREAM_EXTRACT_URL ?? process.env.LLM_SERVICE_URL ?? 'http://localhost:3001/dream/extract';
}

/**
 * Result of one cluster's extraction attempt, tagged with whether it
 * represents genuine LLM output or services/llm's fail-safe empty stub —
 * this tag is what lets extractInsights() decide whether to charge cost.
 */
interface ClusterExtractionAttempt {
  insights: ExtractedInsights;
  /** True when the HTTP call succeeded AND the response carried NO
   *  extraction_failure_reason — i.e. genuine, cost-worthy LLM output. */
  genuine: boolean;
}

async function extractOneCluster(cluster: EpisodeCluster, maxOutputTokens: number): Promise<ClusterExtractionAttempt> {
  try {
    const res = await fetchWithTimeout(extractUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary: cluster.summary, max_output_tokens: maxOutputTokens }),
    });
    if (!res.ok) throw new Error(`extract endpoint ${res.status}`);
    const body = (await res.json()) as Partial<ExtractedInsights> & { extraction_failure_reason?: string };
    const insights: ExtractedInsights = {
      cluster_id: cluster.cluster_id,
      rules: (body.rules ?? []).slice(0, 10),
      preferences: (body.preferences ?? []).slice(0, 10),
      error_patterns: (body.error_patterns ?? []).slice(0, 10),
      facts: (body.facts ?? []).slice(0, 10),
    };
    // Root-cause fix (2026-07-27): services/llm's extractDreamInsights() now
    // tags a failed-to-parse/truncated result with extraction_failure_reason
    // even on an HTTP 200 — this is the caller-visible signal that lets us
    // tell "genuinely found nothing" apart from "the call didn't work,"
    // which is exactly what the live-session bug report could NOT
    // distinguish from the client side. Absence of the field (undefined) is
    // the only "genuine" case; any string value means treat as non-genuine.
    return { insights, genuine: body.extraction_failure_reason === undefined };
  } catch {
    // Fail-safe: an unreachable/erroring extraction service degrades to an
    // empty-but-well-formed result for this cluster — never a crash, never
    // a fabricated insight. The pipeline still marks the run 'partial'.
    // Never genuine — a thrown/network-level failure is never cost-worthy.
    return {
      insights: { cluster_id: cluster.cluster_id, rules: [], preferences: [], error_patterns: [], facts: [] },
      genuine: false,
    };
  }
}

/**
 * Extract insights for each cluster, checking budget BEFORE each call
 * (FR-COST-2) and aborting the remaining clusters early once the estimated
 * cost of the next call would exceed the tracker's remaining budget.
 *
 * Root-cause fix (2026-07-27): cost.record() is now called ONLY for
 * genuinely successful extractions (see ClusterExtractionAttempt.genuine).
 * Previously, cost was recorded for every attempted cluster regardless of
 * whether the result was real or services/llm's fail-safe empty stub —
 * this is the exact mechanism behind the live-session finding "budget_used_usd
 * and per_stage_tokens.extraction scale with batch size, but memories_count
 * stays 0": genuine LLM cost was being charged for calls that produced
 * nothing usable. A non-genuine cluster now contributes zero cost and is
 * reported in the new clusters_failed_extraction list instead.
 */
export async function extractInsights(
  clusters: EpisodeCluster[],
  cost: CostTracker,
  maxOutputTokensPerCluster: number,
): Promise<ExtractionOutcome> {
  const extracted: ExtractedInsights[] = [];
  const skipped: string[] = [];
  const failedExtraction: string[] = [];

  for (const cluster of clusters) {
    const inputTokens = estimateTokens(cluster.summary);
    const estimatedCost = cost.estimateCostUsd(inputTokens, maxOutputTokensPerCluster);
    if (!cost.canAfford(estimatedCost)) {
      skipped.push(cluster.cluster_id);
      continue;
    }

    const attempt = await extractOneCluster(cluster, maxOutputTokensPerCluster);
    if (attempt.genuine) {
      const outputText = JSON.stringify(attempt.insights);
      const outputTokens = Math.min(estimateTokens(outputText), maxOutputTokensPerCluster);
      cost.record('extraction', inputTokens, outputTokens);
      extracted.push(attempt.insights);
    } else {
      failedExtraction.push(cluster.cluster_id);
    }
  }

  return {
    extracted,
    status: skipped.length > 0 || failedExtraction.length > 0 ? 'partial' : 'completed',
    clusters_skipped: skipped,
    clusters_failed_extraction: failedExtraction,
  };
}
