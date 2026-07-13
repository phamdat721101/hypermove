/**
 * src/lib/harness/types.ts
 * ------------------------
 * Shared types for the HyperMove agent-skill harness. A skill is a unit an
 * agent can download, install into its OWN workspace (as a SKILL.md), and run
 * locally by following its procedure — applying the harness pattern
 * (observability + sentinel policy + output-enforcement). `defineSkillTool()`
 * is an OPTIONAL adapter that also exposes a skill as an MCP tool; MCP itself is
 * reserved for external-protocol integration (payments, live data).
 */

import type { PriceTier } from '../mcp/catalog';

/** Which harness layers a skill opts into. Declarative — the runtime supplies them. */
export interface HarnessConfig {
  /** Structured error capture + tracing via lib/observability (always on). */
  errorHandler?: boolean;
  /** Sentinel policy: cost cap / rate / allowlist / prompt-injection. */
  policy?: boolean;
  /** Output-enforcement: verify the result before it ships; self-heal on fail. */
  outputEnforcer?: OutputEnforceConfig;
  /** Document-extraction post-processing (Upstage-style). Provider-gated. */
  docExtract?: { provider: 'upstage'; mode: 'local-only' | 'cloud' };
}

/** A single verify strategy for the output-enforcer. Data-only so it is serializable. */
export type VerifyStrategy =
  | { kind: 'nonempty' }
  | { kind: 'schema'; required: string[] }
  | { kind: 'math'; check: 'invoice-sum'; itemsField: string; totalField: string }
  | { kind: 'json' };

export interface OutputEnforceConfig {
  verify: VerifyStrategy[];
  /** self-heal → feed failure back + re-execute (bounded); block → return unverified. */
  onFail: 'self-heal' | 'block';
  maxHeals?: number;
}

/** The skill's own logic. HyperMove supplies everything around it. */
export type SkillExecute = (args: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;

export type SkillCategory = 'harness-primitive' | 'business-model';

export interface SkillDef {
  /** Bare skill name (tool becomes `skill.<name>`). */
  name: string;
  version: string;
  category: SkillCategory;
  description: string;
  /** Price tier used by the gateway paywall metering. */
  tier: PriceTier;
  /** MCP input schema (JSON-Schema subset the gateway understands). */
  inputSchema: Record<string, unknown>;
  /** Which harness layers wrap this skill's execution. */
  harness: HarnessConfig;
  /** The skill logic. */
  execute: SkillExecute;
  /** Human-readable composition note (which primitives it composes). */
  composes?: string[];
  /** Pricing shown in the catalog (display only; gateway meters by tier). */
  priceLabel?: string;
}

export interface CheckResult {
  strategy: string;
  pass: boolean;
  reason?: string;
}

export interface EnforceResult {
  verified: boolean;
  heals: number;
  checks: CheckResult[];
  output: Record<string, unknown>;
}
