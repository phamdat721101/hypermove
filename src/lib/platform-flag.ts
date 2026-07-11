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

// ─── HyperMove MCP Gateway flags ───────────────────────────────────────────
//
// Master flag + cascading sub-flags. v2.0 semantics: ALL default ON. A single
// master flip (FEATURE_HYPERMOVE_MCP_GATEWAY_V1=false) disables the whole
// gateway regardless of sub-flag values (legacy 2-tool surface, <60s rollback).
// Each sub-flag can also be individually disabled with FEATURE_...=false.

// v2.0: the MCP gateway ships ON by default. Rollback is an explicit opt-out —
// set FEATURE_HYPERMOVE_MCP_GATEWAY_V1=false (master) or any sub-flag=false to
// disable that layer and fall back to the legacy 2-tool surface / mock path.
export function isMcpGatewayEnabled(): boolean {
  return process.env.FEATURE_HYPERMOVE_MCP_GATEWAY_V1 !== 'false';
}

function subFlag(name: string): boolean {
  return isMcpGatewayEnabled() && process.env[name] !== 'false';
}

/** WorkOS OAuth 2.1 auth gate. Off → legacy unauthenticated behavior. */
export function isMcpAuthEnabled(): boolean {
  return subFlag('FEATURE_MCP_AUTH_WORKOS');
}

/** 10-free-queries-per-24h counter. Requires auth (per-user identity). */
export function isMcpRateLimitEnabled(): boolean {
  return subFlag('FEATURE_MCP_RATE_LIMIT') && isMcpAuthEnabled();
}

/** Tiered x402/MPP paywall + multi-chain payment routing. Requires auth. */
export function isMcpPaywallEnabled(): boolean {
  return subFlag('FEATURE_MCP_PAYWALL') && isMcpAuthEnabled();
}

/** Moralis/Alchemy/QuickNode aggregation. Off → provider tools return null. */
export function isMcpDataAdaptersEnabled(): boolean {
  return subFlag('FEATURE_MCP_DATA_ADAPTERS_V1');
}

/** pgvector semantic search tier. Off → lexical-only. */
export function isMcpVectorSearchEnabled(): boolean {
  return subFlag('FEATURE_MCP_VECTOR_SEARCH');
}

/** Daily news + insight layer. */
export function isMcpNewsEnabled(): boolean {
  return subFlag('FEATURE_MCP_NEWS_V1');
}

/** Agentic meta-tools (roadmap / idea generation / skillify). */
export function isMcpAgenticEnabled(): boolean {
  return subFlag('FEATURE_MCP_AGENTIC_V1');
}

/**
 * HyperMove /tools skill registry — harness-wrapped agent-skills exposed as MCP
 * tools (skill.*, skills.list, skills.install). Opt-out (default ON when the
 * gateway is on), consistent with the other gateway sub-flags; disable with
 * FEATURE_HYPERMOVE_TOOLS=false.
 */
export function isMcpSkillsEnabled(): boolean {
  return subFlag('FEATURE_HYPERMOVE_TOOLS');
}
