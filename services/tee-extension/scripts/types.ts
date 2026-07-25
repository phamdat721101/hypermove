/**
 * types.ts
 * --------
 * SegmentResult schema — the one contract every segment (A/B/C) of the orchestrator
 * produces and the final report aggregates. Exact shape per
 * biz-team/bd-team/research/hypermove/2026-07-23-tee-proxy-e2e-script-coston2/
 * 03-architecture-and-design.md's "Status-report contract" section.
 *
 * Rules (enforced by nim-skill's enforcer at each step, see harness.ts):
 *  - status: 'real' MUST carry non-empty evidence (a tx hash or equivalent).
 *  - status: 'blocked' MUST carry blockerId + an actionable message.
 *  - status: 'simulated' is reserved for Segment B's platform-level claims — never
 *    applied to Segment C (real XRPL settlement is always 'real', regardless of
 *    which network it targets).
 */

export type SegmentId = 'A' | 'B' | 'C';
export type SegmentStatus = 'real' | 'simulated' | 'blocked' | 'error';
export type BlockerId = 'T1' | 'T2';

export interface SegmentEvidence {
  txHash?: string;
  address?: string;
  url?: string;
  /** Free-form extra evidence fields (e.g. extensionId, platform string) — kept as a
   *  typed escape hatch rather than `any` so callers still get key-level type safety. */
  extra?: Record<string, string | number | boolean>;
}

export interface SegmentResult {
  segment: SegmentId;
  step: string;
  status: SegmentStatus;
  evidence?: SegmentEvidence;
  message: string;
  blockerId?: BlockerId;
}

/** Runtime guard used by the enforcer's schema strategy and by hand-written checks —
 *  kept dependency-free (no zod) so this module has zero runtime deps of its own. */
export function isWellFormedSegmentResult(value: unknown): value is SegmentResult {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;

  if (r.segment !== 'A' && r.segment !== 'B' && r.segment !== 'C') return false;
  if (typeof r.step !== 'string' || r.step.length === 0) return false;
  if (
    r.status !== 'real' &&
    r.status !== 'simulated' &&
    r.status !== 'blocked' &&
    r.status !== 'error'
  ) {
    return false;
  }
  if (typeof r.message !== 'string' || r.message.length === 0) return false;

  // status:'real' must carry non-empty evidence.
  if (r.status === 'real') {
    const ev = r.evidence as SegmentEvidence | undefined;
    const hasEvidence =
      !!ev && (Boolean(ev.txHash) || Boolean(ev.address) || Boolean(ev.url) || Boolean(ev.extra));
    if (!hasEvidence) return false;
  }

  // status:'blocked' must carry blockerId.
  if (r.status === 'blocked') {
    if (r.blockerId !== 'T1' && r.blockerId !== 'T2') return false;
  }

  return true;
}

export interface FinalReport {
  generatedAt: string;
  results: SegmentResult[];
  /** true only if every segment's expected terminal state was reached (including an
   *  expected 'blocked' — a named blocker stopping cleanly is a successful run, not a
   *  failure of the script). */
  ranToCompletion: boolean;
}

export function isWellFormedFinalReport(value: unknown): value is FinalReport {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.generatedAt !== 'string' || r.generatedAt.length === 0) return false;
  if (typeof r.ranToCompletion !== 'boolean') return false;
  if (!Array.isArray(r.results)) return false;
  return r.results.every(isWellFormedSegmentResult);
}
