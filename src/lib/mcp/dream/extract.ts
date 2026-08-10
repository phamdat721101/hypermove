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
  /**
   * Dream Cycle Confidential Extraction on Flare FCC, Task 5. Every genuine
   * attestation quoteHash produced by this run's confidential extraction
   * attempts (see ClusterExtractionAttempt.attestationRef). Empty for a
   * plaintext run and for a confidential run where no attempt reached
   * genuine:true (today's real state, since FCC/tee-extension never returns
   * genuine output yet). pipeline.ts persists the first entry (if any) into
   * dream_cycle_runs.attestation_ref — one attestation ref per run is
   * sufficient today since a single run's clusters all execute inside the
   * same TEE session in practice; storing the full list here (rather than
   * only the first) keeps this module honest about multi-cluster runs
   * without forcing pipeline.ts to guess which one "the" ref is.
   */
  attestation_refs: string[];
  /**
   * Additive (2026-08-10, PRD 04 — dream-cycle-fcc-live-session-feedback,
   * Finding C). Bucketed counts of WHY each cluster in
   * clusters_failed_extraction failed, so a caller without server-log
   * access can distinguish "your LLM extraction backend is down" (retry
   * later) from "the deployment is misconfigured" from a parse issue —
   * three different actions that were previously indistinguishable from a
   * bare cluster-id list. Two buckets for the plaintext path (see
   * extractOneCluster()): 'upstream_error' (network throw OR non-2xx
   * response — merged into one bucket per this fix's own taxonomy
   * decision, keeping parity with the confidential path's coarser
   * fcc_dispatch_failed granularity) and 'parse_error' (a 2xx response
   * whose body still carried extraction_failure_reason — the LLM's output
   * never parsed into a valid 4-key JSON object). Values always sum to
   * clusters_failed_extraction.length. Confidential-path failures
   * (fcc_not_live/fcc_not_configured/fcc_dispatch_failed) are NOT
   * aggregated here — the confidential path already has its own richer,
   * differently-shaped failureReason taxonomy surfaced via a separate
   * mechanism (dream_cycle_runs.attestation_ref + this file's own doc
   * comments); mixing the two taxonomies into one bucket set would lose
   * the confidential path's existing granularity for no benefit, since a
   * single run is never a mix of both paths (see extractInsights()'s
   * `confidential` boolean — a run is one or the other, never both).
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
   * failure was a network-level throw with no response body to read, or the
   * run used the confidential path, which has its own separate taxonomy).
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
   * Dream Cycle Confidential Extraction on Flare FCC, Task 4, extended
   * 2026-08-10 (PRD 04, Finding C) to also cover the PLAINTEXT path.
   * 'fcc_not_live' | 'fcc_not_configured' | 'fcc_dispatch_failed' are
   * CONFIDENTIAL-path-only (see extractOneClusterConfidential()).
   * 'upstream_error' | 'parse_error' are PLAINTEXT-path-only (see
   * extractOneCluster() below) — 'upstream_error' covers both a thrown
   * network error and a non-2xx HTTP response (merged into one bucket per
   * this fix's taxonomy decision); 'parse_error' covers a 2xx response
   * whose body still carried extraction_failure_reason. The two path's
   * value sets never mix within one attempt (a run is confidential or
   * plaintext, never both — see extractInsights()'s `confidential` arg).
   */
  failureReason?: 'fcc_not_live' | 'fcc_not_configured' | 'fcc_dispatch_failed' | 'upstream_error' | 'parse_error';
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
   * is genuinely down." Present only on the plaintext path's upstream_error
   * case when the server responded with a parseable JSON error body;
   * undefined for a network-level throw (no response to read at all) or any
   * other failure kind. Capped to a short length before ever being surfaced
   * to a caller — see extractOneCluster()'s own truncation.
   */
  errorDetail?: string;
  /**
   * Dream Cycle Confidential Extraction on Flare FCC, Task 5. Present only
   * on a genuine CONFIDENTIAL attempt (see extractOneClusterConfidential())
   * — the verified TEE attestation's quoteHash (confidential.ts's
   * verifyAttestation()), threaded up to ExtractionOutcome so pipeline.ts
   * can persist it into dream_cycle_runs.attestation_ref (Task 1's column).
   * Always undefined for the plaintext path and for any non-genuine
   * confidential attempt.
   */
  attestationRef?: string;
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

function emptyAttempt(clusterId: string, failureReason: ClusterExtractionAttempt['failureReason'], errorDetail?: string): ClusterExtractionAttempt {
  return {
    insights: { cluster_id: clusterId, rules: [], preferences: [], error_patterns: [], facts: [] },
    genuine: false,
    failureReason,
    errorDetail,
  };
}

/**
 * Dream Cycle Confidential Extraction on Flare FCC, Task 4. Extraction backed
 * by Flare's Confidential Compute (FCC) TEE instead of the plain services/llm
 * HTTP call above — routed through flare-instruct.ts's dispatchInstruction()
 * (GENERIC_AGENT_TASK opType), exactly like flare.instruct.dispatch already
 * does. Liveness is checked FIRST via the same honest, fail-closed check
 * flare.confidential.status already uses (providers/flare.ts's private
 * isFccLiveOnNetwork(), reached only via buildRouter().dispatch({method:
 * 'flareConfidentialStatus'}) — never duplicated here as a second check).
 *
 * Fails closed at every stage, matching extractOneCluster()'s discipline
 * exactly: FCC not live -> zero cost, failureReason:'fcc_not_live'. TEE
 * extension not configured (no TEE_EXTENSION_PROXY_URL/
 * FLARE_INSTRUCTION_SENDER_ADDRESS) -> zero cost, failureReason:
 * 'fcc_not_configured'. Dispatch itself fails -> zero cost, failureReason:
 * 'fcc_dispatch_failed'. As of this writing FCC is live on Songbird canary
 * only and services/tee-extension's processGenericAgentTask ALWAYS returns a
 * structured refusal by design (see its README's "honest-stub boundary") —
 * so every real call today lands in one of the four non-genuine branches
 * below (the fourth being Task 5's attestation-rejection branch). This is
 * expected, not a bug: the plumbing is real and ready for the day Flare ships
 * a real GENERIC_AGENT_TASK implementation, with zero further code change
 * required here.
 *
 * Network selection (2026-08-08, real Coston2 deployment): HyperMove's own
 * services/tee-extension runs on Coston2 under SIMULATED_TEE=true — a dev
 * testnet simulation, NOT real Flare FCC hardware (which stays Songbird-only,
 * see providers/flare.ts's isFccLiveOnNetwork()). This function therefore
 * checks Coston2 liveness via the DISTINCT `hypermoveTeeExtensionStatus`
 * method (providers/flare.ts's isHyperMoveTeeExtensionLive()) rather than
 * `flareConfidentialStatus` — deliberately never conflating "our own
 * simulated dev extension answered" with "real Flare FCC is live." If real
 * FCC ever ships on Songbird AND this module is pointed at it instead, use
 * `flareConfidentialStatus`/network:'songbird' — the two paths are kept
 * separate on purpose so a Coston2 dev run can never be mistaken for a
 * real-FCC-verified one in logs, tests, or downstream reporting.
 *
 * Task 5 (attestation binding): a dispatch is only ever treated as genuine if
 * its `data` payload carries BOTH an `attestationQuote` AND `insights` in the
 * ExtractedInsights shape, AND that quote passes confidential.ts's
 * verifyAttestation() (real Phala Cloud API call, fails closed on any
 * ambiguity — see that module's doc comment). This is the documented,
 * forward-looking contract for the day services/tee-extension's
 * processGenericAgentTask stops refusing and starts returning real output;
 * until then this exact branch is unreachable in production (the extension
 * never populates `data.attestationQuote`), but it is fully implemented and
 * covered by tests using a mocked "FCC now live + extension returns real
 * data" scenario (see tests/mcp-dream-extract-confidential.test.ts's Task 5
 * suite) so the path is proven correct rather than merely aspirational.
 * withAttestationGate() is NOT used here (unlike flare.confidential.swap) —
 * that helper expects a caller-supplied quote to gate a caller-initiated
 * action; here the quote arrives FROM the dispatch result itself, so this
 * calls verifyAttestation() directly, mirroring withAttestationGate()'s own
 * internal shape (check → structured refusal, or proceed) at the one point
 * that differs (the quote's origin).
 */
async function extractOneClusterConfidential(cluster: EpisodeCluster, maxOutputTokens: number): Promise<ClusterExtractionAttempt> {
  const network = process.env.DREAM_CONFIDENTIAL_NETWORK ?? 'coston2';
  const { buildRouter } = await import('../providers');
  const livenessMethod = network === 'coston2' ? 'hypermoveTeeExtensionStatus' : 'flareConfidentialStatus';
  const liveness = await buildRouter().dispatch({ chain: network, method: livenessMethod, params: {} });
  if (!liveness.ok) {
    return emptyAttempt(cluster.cluster_id, 'fcc_not_live');
  }

  try {
    const { dispatchInstruction } = await import('../flare-instruct');
    const result = await dispatchInstruction({
      opType: 'GENERIC_AGENT_TASK',
      message: { taskType: 'dream.extract', payload: cluster.summary },
      network,
    });
    if (!result.ok) {
      // Covers 'feature_disabled' / 'not_configured' / 'dispatch_failed' /
      // 'enforcer_block' uniformly — none are cost-worthy, and the module's
      // own error.code already distinguishes them for anyone inspecting
      // clusters_failed_extraction's raw log if needed.
      return emptyAttempt(cluster.cluster_id, result.error.code === 'not_configured' ? 'fcc_not_configured' : 'fcc_dispatch_failed');
    }

    const data = result.data.data as { attestationQuote?: string; insights?: Partial<ExtractedInsights> } | null;
    if (!data?.attestationQuote || !data.insights) {
      // The documented current reality: processGenericAgentTask's honest
      // refusal stub never populates these fields. Reaching here with a
      // successful dispatch but no attestation contract is expected, not an
      // error worth a distinct failureReason — same bucket as any other
      // dispatch that didn't produce usable output.
      return emptyAttempt(cluster.cluster_id, 'fcc_dispatch_failed');
    }

    const { verifyAttestation } = await import('../confidential');
    const attestation = await verifyAttestation({ quote: data.attestationQuote });
    if (!attestation.ok) {
      // A genuine dispatch whose attestation fails verification is NEVER
      // silently trusted — this is the fail-closed core of Task 5. Tagged
      // distinctly so observability can tell "FCC answered but we couldn't
      // trust it" apart from every other non-genuine reason.
      return emptyAttempt(cluster.cluster_id, 'fcc_dispatch_failed');
    }

    return {
      insights: {
        cluster_id: cluster.cluster_id,
        rules: (data.insights.rules ?? []).slice(0, 10),
        preferences: (data.insights.preferences ?? []).slice(0, 10),
        error_patterns: (data.insights.error_patterns ?? []).slice(0, 10),
        facts: (data.insights.facts ?? []).slice(0, 10),
      },
      genuine: true,
      attestationRef: attestation.data.quoteHash,
    };
  } catch {
    return emptyAttempt(cluster.cluster_id, 'fcc_dispatch_failed');
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
  /**
   * Dream Cycle Confidential Extraction on Flare FCC, Task 4. Default false
   * — byte-identical behavior (the plaintext extractOneCluster() path) for
   * every existing caller. When true, every cluster routes through
   * extractOneClusterConfidential() instead; there is no per-cluster mixing
   * within a single run — a run is confidential or it isn't, matching
   * start_dream's config.confidential being a run-level flag (Task 2/3).
   */
  confidential = false,
): Promise<ExtractionOutcome> {
  const extracted: ExtractedInsights[] = [];
  const skipped: string[] = [];
  const failedExtraction: string[] = [];
  const attestationRefs: string[] = [];
  // Finding C fix (2026-08-10): bucketed failure-reason counts, aggregated
  // only from the plaintext/confidential path actually used this run (see
  // the `confidential` boolean below) — never mixed.
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

    const attempt = confidential
      ? await extractOneClusterConfidential(cluster, maxOutputTokensPerCluster)
      : await extractOneCluster(cluster, maxOutputTokensPerCluster);
    if (attempt.genuine) {
      const outputText = JSON.stringify(attempt.insights);
      const outputTokens = Math.min(estimateTokens(outputText), maxOutputTokensPerCluster);
      cost.record('extraction', inputTokens, outputTokens);
      extracted.push(attempt.insights);
      if (attempt.attestationRef) attestationRefs.push(attempt.attestationRef);
    } else {
      failedExtraction.push(cluster.cluster_id);
      // Defensive fallback bucket: should not occur given extractOneCluster()/
      // extractOneClusterConfidential() always set failureReason on every
      // non-genuine return, but never let an unset reason go unaccounted.
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
    attestation_refs: attestationRefs,
    failure_reasons: failureReasons,
    ...(lastUpstreamErrorDetail ? { last_upstream_error_detail: lastUpstreamErrorDetail } : {}),
  };
}
