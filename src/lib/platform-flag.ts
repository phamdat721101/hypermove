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
 * HyperMove /tools skill registry — DISCOVERY/INSTALL helper tools only
 * (skills.list / skills.install / skills.install_prompt). Skills themselves
 * install & run in the agent's workspace (SKILL.md); they are NOT exposed as MCP
 * execution tools. Opt-out (default ON when the gateway is on); disable with
 * FEATURE_HYPERMOVE_TOOLS=false.
 */
export function isMcpSkillsEnabled(): boolean {
  return subFlag('FEATURE_HYPERMOVE_TOOLS');
}

// ─── XRPL builder skills ───────────────────────────────────────────────────
//
// The two XRPL skills (xrpl-search, xrpl-research-pro) are ALWAYS listed — no
// visibility flag. Only the costly Exa deep-reasoning tier stays opt-in.

/** deep-reasoning Exa tier — opt-IN (cost guard). Default off. */
export function isXrplDeepReasoningEnabled(): boolean {
  return process.env.FEATURE_XRPL_DEEP_REASONING === 'true';
}

// ─── MCP v3.0 "Web3-Builder Output Gateway" flags ──────────────────────────
//
// v4.0 update: v3.0 sub-flags now match v2.0 semantics — default ON, opt-OUT
// via an explicit `=false`. The six weeks of v3.0 engineering (Flare/GOAT
// adapters, builder.brief synthesis, XRPL deepening, resources/prompts) sat
// fully coded but unreachable behind the old opt-in default; every code path
// already has honest `softEmpty`/mock fallbacks for anything not yet
// contract-verified, so flipping the default carries no new runtime risk.
// Each flag is still master-gated — flipping the gateway master off
// (FEATURE_HYPERMOVE_MCP_GATEWAY_V1=false) disables them regardless.

/** v3.0 sub-flag: master-gated, opt-OUT via explicit `=false`. Default ON. */
function v3Flag(name: string): boolean {
  return isMcpGatewayEnabled() && process.env[name] !== 'false';
}

/** M2 — Flare adapter (FTSO free oracle + FAssets + FDC + FCC). */
export function isMcpFlareEnabled(): boolean {
  return v3Flag('FEATURE_MCP_FLARE_V1');
}

/** M3 — GOAT data adapter (goat-geth reads + yield/settlement/identity/lending). */
export function isMcpGoatEnabled(): boolean {
  return v3Flag('FEATURE_MCP_GOAT_V1');
}

/** M5 — GOAT settlement rail (dogfood: settle HyperMove's own MCP on GOAT). */
export function isMcpGoatRailEnabled(): boolean {
  return v3Flag('FEATURE_MCP_GOAT_RAIL');
}

/** M5 — settlement-asset choice XRP|RLUSD on XRPL (Rule #33). */
export function isMcpAssetChoiceEnabled(): boolean {
  return v3Flag('FEATURE_MCP_ASSET_CHOICE');
}

/** M4 — builder.brief synthesis tier (nim-cache + nim-enforcer gated). */
export function isMcpBuilderBriefEnabled(): boolean {
  return v3Flag('FEATURE_MCP_BUILDER_BRIEF');
}

/** M1 — XRPL deepening (MPT/vault/lending+amendment/settlement-quote/x402). */
export function isMcpXrplV3Enabled(): boolean {
  return v3Flag('FEATURE_MCP_XRPL_V3');
}

/** M6 — MCP resources + prompts exposure. */
export function isMcpResourcesEnabled(): boolean {
  return v3Flag('FEATURE_MCP_RESOURCES');
}

// ─── Confidential MCP Tool Tier (Flare-oracle-only + XRPL-native settlement) ─
//
// Master flag + 3 independently-disableable sub-flags, following the exact
// v3Flag() cascade above. FEATURE_MCP_CONFIDENTIAL_V1=false disables all three
// new tools + the new price tier with zero other observable change (<30s
// rollback). Each sub-flag off never causes another sub-flag's tool to
// misbehave — every tool checks its own flag first.

/** Master flag for the confidential tool tier. Default ON, opt-out via `=false`. */
export function isMcpConfidentialEnabled(): boolean {
  return v3Flag('FEATURE_MCP_CONFIDENTIAL_V1');
}

/** confidential.attest + withAttestationGate(). Master-gated. */
export function isMcpAttestationEnabled(): boolean {
  return isMcpConfidentialEnabled() && process.env.FEATURE_MCP_ATTESTATION !== 'false';
}

/** flare.confidential.swap / flare.confidential.status (FCC-aware). Master-gated. */
export function isMcpFccEnabled(): boolean {
  return isMcpConfidentialEnabled() && process.env.FEATURE_MCP_FCC_V1 !== 'false';
}

/** XRPL-only settlement for the `confidential` price tier. Master-gated. */
export function isMcpConfidentialXrplSettlementEnabled(): boolean {
  return isMcpConfidentialEnabled() && process.env.FEATURE_MCP_CONFIDENTIAL_XRPL_SETTLEMENT !== 'false';
}

// ─── TEE-Proxy Instruction Dispatch + Token Profile (2026-07-20) ────────────
//
// Two independent top-level masters, NOT nested under isMcpConfidentialEnabled()
// above — flare.instruct.dispatch also handles the non-financial, t2_realtime-priced
// generic-agent-task path, so coupling its rollback to the confidential cascade would
// let disabling attestation tooling silently disable a non-confidential capability too.
// See biz-team/bd-team/research/hypermove/2026-07-20-tee-proxy-fcc-extension-token-profile/
// 03-architecture-and-design.md ("Why a new top-level master flag") for the full rationale.

/** flare.instruct.dispatch — submits an instruction to services/tee-extension's
 *  InstructionSender contract and polls ext-proxy for the result. Default ON. */
export function isMcpInstructEnabled(): boolean {
  return v3Flag('FEATURE_MCP_INSTRUCT_V1');
}

/** flare.token.save / flare.token.profile. Default ON. Independent of the two flags above. */
export function isMcpTokenProfileEnabled(): boolean {
  return v3Flag('FEATURE_MCP_TOKEN_PROFILE_V1');
}

// ─── Terminal device-code auth (2026-07-25) ────────────────────────────────
//
// RFC-8628-shaped device flow (/api/mcp/device/start|approve|poll) — lets a
// headless agent get a bearer token via a y/n approval typed directly in the
// SAME terminal session, no browser, no wallet, no WorkOS. Deliberately
// anonymous (see auth.ts's device-session kind) and NOT loopback-restricted —
// an accepted tradeoff, mitigated by short-lived one-shot codes + per-IP rate
// limiting on /start (see rate-limit.ts) and a hard free-tier cap enforced at
// issuance (auth.ts) and re-checked at every paywall/tier-upgrade boundary
// (payment-router.ts, paywall.ts). Master-gated; default ON, opt-out via
// FEATURE_MCP_DEVICE_AUTH=false (<60s rollback, matches every other sub-flag).
export function isMcpDeviceAuthEnabled(): boolean {
  return v3Flag('FEATURE_MCP_DEVICE_AUTH');
}

// ─── Dream Cycle (2026-07-26) ───────────────────────────────────────────────
//
// Offline memory-consolidation pipeline: agents submit episode logs
// (submit_episode_log, zero-LLM cold storage), then trigger a batch pipeline
// (start_dream: preprocess → cluster → extract → consolidate → prune → index)
// that turns them into small, durable per-agent "memories" retrievable via
// query_dream / get_dream_stats / dream/* resources + prompts at near-zero
// token cost on the read side. See docs/prd/dream-cycle-v1.md.
//
// All 5 new tools are `unmetered: true` (bypass the paywall/rate-limit tiers
// entirely — see gateway.ts) because spend is bounded by this feature's own
// per-cycle `budget_usd` guardrail, not the gateway's free-tier metering.
// Default ON (v3Flag opt-out), matching every other v3.0/v4.0 sub-flag.
export function isMcpDreamCycleEnabled(): boolean {
  return v3Flag('FEATURE_MCP_DREAM_CYCLE');
}

// ─── Dream Cycle server-side scheduler (2026-07-27, PRD-D) ─────────────────
//
// Enforces `trigger_criteria` server-side: an in-process hourly tick calls
// startDream() directly for any agent whose config's trigger_criteria are
// due, instead of relying on an external caller (cron, a script like
// ~/biz-team/bd-team/scripts/dream-cycle-daily-loop.ts) to remember to do it.
//
// Deliberately DEFAULT OFF, breaking from every other v3.0+ sub-flag's
// default-ON convention above. Rationale: this is the first feature in the
// gateway that autonomously spends budget and writes data across every
// registered agent with no per-call human trigger — every other tool/flag
// in this file only acts when a caller explicitly invokes it. A global
// cross-agent budget/count ceiling (see dream/scheduler.ts) bounds worst-case
// cost once enabled, but the operator should opt in after understanding that
// ceiling, not discover the scheduler already running via an unexpected
// budget line item. Opt in with FEATURE_MCP_DREAM_SCHEDULER=true.
export function isMcpDreamSchedulerEnabled(): boolean {
  return isMcpDreamCycleEnabled() && process.env.FEATURE_MCP_DREAM_SCHEDULER === 'true';
}
