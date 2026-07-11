/**
 * src/lib/observability/types.ts
 * -------------------------------
 * Event schema shared by the capture layer and the sentinel policy engine.
 *
 * SOLID:
 *  - Single Responsibility: this module defines types + validators only. No
 *    business logic, no I/O.
 *  - Interface Segregation: AgentEvent is the minimal wire contract; consumers
 *    project the fields they need.
 *
 * We hand-roll a tiny validator to preserve zero-new-npm-deps deployment
 * simplicity. The API mirrors a subset of Zod so it can be swapped later
 * without breaking call sites.
 */

/** Event kinds emitted by the observability layer. Keep this list small — one
 *  entry per structural event class, not per endpoint. */
export type AgentEventKind =
  | 'invoke.start'       // handler entry (before any work)
  | 'invoke.success'     // handler returned normally
  | 'invoke.error'       // handler threw
  | 'policy.deny'        // sentinel denied before handler ran
  | 'policy.allow'       // sentinel allowed (only recorded when explicitly requested)
  | 'circuit.open'       // circuit breaker opened
  | 'circuit.close'      // circuit breaker closed after cooldown
  | 'security.reject';   // security guard rejected (sig / rate / injection)

export interface AgentEvent {
  kind: AgentEventKind;
  /** Human-readable endpoint or tool name, e.g. 'hypermove.pay.x402'. */
  endpoint: string;
  /** Version tag from wrapAgentEndpoint({ version }); optional. */
  version?: string;
  /** CAIP-2 chain slug when payment-related. */
  chain?: string;
  /** ERC-8004 KYA hash / DID when known; 'anonymous' otherwise. */
  agent_id: string;
  /** UUID minted per invocation; links start/success/error frames. */
  trace_id: string;
  /** Duration in ms — only set on success/error frames. */
  duration_ms?: number;
  /** Error message when kind === 'invoke.error'. Truncated to 4KB. */
  error?: string;
  /** Stack trace when kind === 'invoke.error'. Truncated to 8KB. */
  stack?: string;
  /** SHA-256 hash of request payload (never the payload itself — PII safe). */
  payload_hash?: string;
  /** ISO-8601 UTC timestamp. */
  timestamp: string;
  /** Arbitrary structured context (limited to 2KB after JSON.stringify). */
  context?: Record<string, unknown>;
}

/** Result of a policy check — recorded to hm_policy_hits by sentinel. */
export interface PolicyHit {
  policy: string;              // e.g. 'cost_cap', 'tool_allowlist', 'prompt_injection'
  endpoint: string;
  agent_id: string;
  reason: string;              // short human-readable code
  timestamp: string;
  cost_micro_usd?: number;     // when policy === 'cost_cap'
}

// ─── Minimal Zod-shaped validator (~40 LOC, zero deps) ─────────────────────

type ValidatorFn<T> = (value: unknown) => { ok: true; value: T } | { ok: false; error: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const ALLOWED_KINDS: readonly AgentEventKind[] = [
  'invoke.start', 'invoke.success', 'invoke.error',
  'policy.deny', 'policy.allow', 'circuit.open', 'circuit.close', 'security.reject',
];

export const validateAgentEvent: ValidatorFn<AgentEvent> = (v) => {
  if (!isRecord(v)) return { ok: false, error: 'event must be an object' };
  if (typeof v.kind !== 'string' || !ALLOWED_KINDS.includes(v.kind as AgentEventKind)) {
    return { ok: false, error: `event.kind invalid: ${String(v.kind)}` };
  }
  if (typeof v.endpoint !== 'string' || v.endpoint.length === 0 || v.endpoint.length > 200) {
    return { ok: false, error: 'event.endpoint must be a non-empty string ≤200 chars' };
  }
  if (typeof v.agent_id !== 'string' || v.agent_id.length === 0 || v.agent_id.length > 128) {
    return { ok: false, error: 'event.agent_id must be a non-empty string ≤128 chars' };
  }
  if (typeof v.trace_id !== 'string' || v.trace_id.length === 0 || v.trace_id.length > 64) {
    return { ok: false, error: 'event.trace_id must be a non-empty string ≤64 chars' };
  }
  if (typeof v.timestamp !== 'string' || Number.isNaN(Date.parse(v.timestamp))) {
    return { ok: false, error: 'event.timestamp must be an ISO-8601 string' };
  }
  // Optional fields — type-check when present, ignore otherwise.
  if (v.duration_ms !== undefined && typeof v.duration_ms !== 'number') {
    return { ok: false, error: 'event.duration_ms must be a number' };
  }
  if (v.error !== undefined && typeof v.error !== 'string') {
    return { ok: false, error: 'event.error must be a string' };
  }
  return { ok: true, value: v as unknown as AgentEvent };
};

/** Cap size of stringified value to prevent unbounded payloads. */
export function truncate(value: string | undefined, maxBytes: number): string | undefined {
  if (!value) return value;
  return value.length <= maxBytes ? value : value.slice(0, maxBytes);
}
