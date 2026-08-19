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

export interface ScoredDreamInsight {
  type: 'rule' | 'preference' | 'error_pattern' | 'fact';
  content: string;
  confidence: number;
  importance: number;
  reasoning?: string;
}

export interface ExtractedInsights {
  cluster_id: string;
  rules: string[];
  preferences: string[];
  error_patterns: string[];
  facts: string[];
  /** Additive scored records. Legacy category arrays remain supported. */
  scored_insights?: ScoredDreamInsight[];
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
  /**
   * Additive (2026-08-10, PRD 04 — dream-cycle-fcc-live-session-feedback,
   * Finding C). Bucketed counts of WHY each cluster in
   * clusters_failed_extraction failed, so a caller without server-log
   * access can distinguish "your LLM extraction backend is down" (retry
   * later) from "the deployment is misconfigured" from a parse issue —
   * three different actions that were previously indistinguishable from a
   * bare cluster-id list: 'upstream_error' (network throw OR non-2xx
   * response) and 'parse_error' (a 2xx response whose body still carried
   * extraction_failure_reason). Values always sum to
   * clusters_failed_extraction.length.
   */
  failure_reasons: Record<string, number>;
  /**
   * Additive (2026-08-10, issue #1 — dream-cycle blocker escalation). The
   * most recent real error detail string captured from services/llm's own
   * failure response body (see ClusterExtractionAttempt.errorDetail) across
   * every non-genuine attempt this run — e.g. "BEDROCK_API_KEY not set".
   * Deliberately just the LAST one, not a per-cluster list: every cluster in
   * a single run hits the SAME misconfigured backend for the SAME reason in
   * practice (this is a deployment-level failure, not a per-cluster one), so
   * one representative detail string is more useful than a repeated list.
   * undefined when no non-genuine attempt captured a detail (e.g. every
   * failure was a network-level throw with no response body to read).
   */
  last_upstream_error_detail?: string;
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
  /**
   * 'upstream_error' covers both a thrown network error and a non-2xx HTTP
   * response (merged into one bucket); 'parse_error' covers a 2xx response
   * whose body still carried extraction_failure_reason.
   */
  failureReason?: 'upstream_error' | 'parse_error';
  /**
   * Additive (2026-08-10, issue #1 — dream-cycle blocker escalation).
   * services/llm's /dream/extract route already returns an informative
   * JSON body on failure (`{"error":"Dream extract failed","detail":"..."}`
   * — see server.ts's dream/extract handler), but extractOneCluster()
   * previously discarded it entirely on the `!res.ok` path, meaning the
   * REAL reason (e.g. "BEDROCK_API_KEY not set") was computed server-side
   * and thrown away client-side every time, leaving a caller with only the
   * coarse 'upstream_error' bucket count and no way to tell "your API key
   * is missing" apart from "the network timed out" apart from "the server
   * is genuinely down." Present only on the upstream_error case when the
   * server responded with a parseable JSON error body; undefined for a
   * network-level throw (no response to read at all) or any other failure
   * kind. Capped to a short length before ever being surfaced to a caller —
   * see extractOneCluster()'s own truncation.
   */
  errorDetail?: string;
}

async function extractOneCluster(cluster: EpisodeCluster, maxOutputTokens: number): Promise<ClusterExtractionAttempt> {
  try {
    const res = await fetchWithTimeout(extractUrl(), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ summary: cluster.summary, max_output_tokens: maxOutputTokens }),
    });
    // Finding C fix (2026-08-10): a non-2xx response is tagged 'upstream_error'
    // right here rather than relying on the generic catch block below — both
    // land in the same bucket (this fix's taxonomy merges network-throw and
    // non-2xx into one 'upstream_error' bucket), but tagging it at the actual
    // failure site keeps the intent explicit rather than incidental.
    //
    // Issue #1 fix (2026-08-10): read the response body before discarding it.
    // services/llm's own /dream/extract handler already computes and returns
    // a real, specific error (e.g. {"error":"Dream extract failed",
    // "detail":"BEDROCK_API_KEY not set"}) on every failure — previously this
    // was thrown away entirely, leaving a caller with only the bucket count.
    // Best-effort: if the body isn't valid JSON or doesn't have the expected
    // shape, errorDetail stays undefined rather than fabricating one.
    if (!res.ok) {
      const detail = await res.json().then(
        (b: unknown) => (typeof b === 'object' && b !== null && 'detail' in b ? String((b as { detail: unknown }).detail) : undefined),
        () => undefined,
      );
      return emptyAttempt(cluster.cluster_id, 'upstream_error', detail?.slice(0, 200));
    }
    const body = (await res.json()) as Partial<ExtractedInsights> & { extraction_failure_reason?: string };
    const insights: ExtractedInsights = {
      cluster_id: cluster.cluster_id,
      rules: (body.rules ?? []).slice(0, 10),
      preferences: (body.preferences ?? []).slice(0, 10),
      error_patterns: (body.error_patterns ?? []).slice(0, 10),
      facts: (body.facts ?? []).slice(0, 10),
      ...(Array.isArray(body.scored_insights)
        ? { scored_insights: body.scored_insights.slice(0, 40).flatMap(normalizeScoredInsight) }
        : {}),
    };
    // Root-cause fix (2026-07-27): services/llm's extractDreamInsights() now
    // tags a failed-to-parse/truncated result with extraction_failure_reason
    // even on an HTTP 200 — this is the caller-visible signal that lets us
    // tell "genuinely found nothing" apart from "the call didn't work,"
    // which is exactly what the live-session bug report could NOT
    // distinguish from the client side. Absence of the field (undefined) is
    // the only "genuine" case; any string value means treat as non-genuine.
    if (body.extraction_failure_reason !== undefined) {
      // Finding C fix (2026-08-10): a 2xx response that still failed to
      // produce genuine output is a parse/malformed-output failure, distinct
      // from the upstream_error bucket above — the HTTP call itself worked.
      return { insights, genuine: false, failureReason: 'parse_error' };
    }
    return { insights, genuine: true };
  } catch {
    // Fail-safe: an unreachable/erroring extraction service degrades to an
    // empty-but-well-formed result for this cluster — never a crash, never
    // a fabricated insight. The pipeline still marks the run 'partial'.
    // Never genuine — a thrown/network-level failure is never cost-worthy.
    return emptyAttempt(cluster.cluster_id, 'upstream_error');
  }
}

function normalizeScoredInsight(value: unknown): ScoredDreamInsight[] {
  if (typeof value !== 'object' || value === null) return [];
  const input = value as Partial<ScoredDreamInsight>;
  if (!['rule', 'preference', 'error_pattern', 'fact'].includes(String(input.type)) || typeof input.content !== 'string') return [];
  const score = (value: unknown) => Math.min(1, Math.max(0, typeof value === 'number' && Number.isFinite(value) ? value : 0.5));
  return [{ type: input.type as ScoredDreamInsight['type'], content: input.content.slice(0, 200), confidence: score(input.confidence), importance: score(input.importance), ...(typeof input.reasoning === 'string' ? { reasoning: input.reasoning.slice(0, 300) } : {}) }];
}

function emptyAttempt(clusterId: string, failureReason: ClusterExtractionAttempt['failureReason'], errorDetail?: string): ClusterExtractionAttempt {
  return {
    insights: { cluster_id: clusterId, rules: [], preferences: [], error_patterns: [], facts: [] },
    genuine: false,
    failureReason,
    errorDetail,
  };
}

/**
 * Extract insights for each cluster, checking budget BEFORE each call
 * (FR-COST-2) and aborting the remaining clusters early once the estimated
 * cost of the next call would exceed the tracker's remaining budget.
 *
 * Root-cause fix (2026-07-27): cost.record() is now called ONLY for
 * genuinely successful extractions (see ClusterExtractionAttempt.genuine).
 *
 * FCC removal (2026-08-14): the `confidential` extraction path
 * (extractOneClusterConfidential) is removed. extractInsights() now always
 * uses the plaintext extractOneCluster() path. See
 * docs/fcc-removal-proposal-2026-08-14.md.
 */
export async function extractInsights(
  clusters: EpisodeCluster[],
  cost: CostTracker,
  maxOutputTokensPerCluster: number,
): Promise<ExtractionOutcome> {
  const extracted: ExtractedInsights[] = [];
  const skipped: string[] = [];
  const failedExtraction: string[] = [];
  // Finding C fix (2026-08-10): bucketed failure-reason counts.
  const failureReasons: Record<string, number> = {};
  // Issue #1 fix (2026-08-10): the most recent real error detail captured
  // from a failed attempt's response body, if any.
  let lastUpstreamErrorDetail: string | undefined;

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
      // Defensive fallback bucket: should not occur given extractOneCluster()
      // always sets failureReason on every non-genuine return, but never let
      // an unset reason go unaccounted.
      const reason = attempt.failureReason ?? 'unknown';
      failureReasons[reason] = (failureReasons[reason] ?? 0) + 1;
      if (attempt.errorDetail) lastUpstreamErrorDetail = attempt.errorDetail;
    }
  }

  return {
    extracted,
    status: skipped.length > 0 || failedExtraction.length > 0 ? 'partial' : 'completed',
    clusters_skipped: skipped,
    clusters_failed_extraction: failedExtraction,
    failure_reasons: failureReasons,
    ...(lastUpstreamErrorDetail ? { last_upstream_error_detail: lastUpstreamErrorDetail } : {}),
  };
}
