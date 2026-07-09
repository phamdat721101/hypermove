/**
 * src/lib/platform-flag.ts
 * ------------------------
 * Single source of truth for the HyperMove v2.0 Platform Layer master flag.
 *
 * SOLID:
 *  - Single Responsibility: this module owns FEATURE_HM_PLATFORM env resolution
 *    and nothing else. Every downstream module (observability / sentinel /
 *    security / dashboard) imports isPlatformEnabled() from here.
 *  - Open/Closed: sub-features are additive — add a new sub-flag by exporting
 *    another function; existing callers remain untouched.
 *
 * Flag semantics:
 *  - FEATURE_HM_PLATFORM=true  → v2.0 observability + sentinel + security active
 *  - FEATURE_HM_PLATFORM=false → byte-identical v1.0 behavior (all wrappers are
 *    identity functions, no DB writes, no dashboard traffic)
 *
 * Default is off. This is a hard requirement: the byte-identical rollback
 * contract fails if any consumer defaults to true.
 */

export function isPlatformEnabled(): boolean {
  return process.env.FEATURE_HM_PLATFORM === 'true';
}

/** Optional Sentry-forward — only active when both master flag AND DSN set. */
export function isSentryForwardEnabled(): boolean {
  return isPlatformEnabled() && !!process.env.SENTRY_DSN;
}
