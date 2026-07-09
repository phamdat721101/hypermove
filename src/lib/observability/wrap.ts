/**
 * src/lib/observability/wrap.ts
 * ------------------------------
 * Public wrappers that make any HTTP handler or MCP tool auto-instrumented.
 *
 * SOLID:
 *  - Single Responsibility: this file ONLY does tracing + event capture around
 *    a user-supplied handler. It never handles I/O directly — capture.ts owns
 *    that. It never enforces policy — sentinel owns that (accepted as an
 *    optional dependency, Dependency Inversion).
 *  - Open/Closed: adding a new endpoint kind is a new wrap<Foo> function; the
 *    existing wrap functions never change.
 *  - Liskov: the returned function has the same signature as the input, so
 *    consumers can swap wrap on / wrap off with no other code change.
 *
 * Flag semantics: when FEATURE_HM_PLATFORM=false, both wrappers are identity
 * functions (byte-identical v1.0 behavior). This is the rollback contract.
 */

import type { NextRequest } from 'next/server';
import { randomUUID, createHash } from 'node:crypto';
import { captureEvent } from './capture';
import { isPlatformEnabled } from '../platform-flag';
import type { AgentEvent } from './types';

// ─── Sentinel injection contract ────────────────────────────────────────────
//
// wrap.ts accepts a minimal Sentinel interface. The concrete implementation
// lives in src/lib/sentinel. Keeping the contract tiny avoids circular imports
// and lets tests inject a fake without any framework.

export interface SentinelCheck {
  /** True when the request may proceed. `reason` populated on deny. */
  check(input: { endpoint: string; agent_id: string; payload?: unknown }): Promise<{
    allow: boolean;
    reason?: string;
    policy?: string;
  }>;
  /** Called after handler finishes so the sentinel can update its counters. */
  record?(outcome: { endpoint: string; agent_id: string; success: boolean; cost_micro_usd?: number }): void;
}

// ─── HTTP wrapper (Next.js Route Handler) ──────────────────────────────────

export interface WrapAgentOptions {
  /** Stable endpoint identity, e.g. 'hypermove.pay.x402'. */
  name: string;
  /** Semver tag; surfaces on the dashboard. */
  version?: string;
  /** CAIP-2 chain slug when payment-related. */
  chain?: string;
  /** Optional Sentinel middleware. */
  sentinel?: SentinelCheck;
  /** The handler being wrapped. */
  handler: (req: NextRequest) => Promise<Response> | Response;
}

/**
 * Wrap a Next.js Route Handler with structured tracing + policy enforcement.
 * When the platform flag is off, returns the handler unchanged.
 */
export function wrapAgentEndpoint(opts: WrapAgentOptions): (req: NextRequest) => Promise<Response> {
  if (!isPlatformEnabled()) {
    // Identity path: byte-identical v1.0 semantics.
    return async (req) => opts.handler(req);
  }

  return async (req) => {
    const trace_id = randomUUID();
    const started = performance.now();
    const agent_id = extractAgentId(req);
    const nowIso = () => new Date().toISOString();

    // 1. Policy check (sentinel). Deny short-circuits the handler.
    if (opts.sentinel) {
      let decision: Awaited<ReturnType<SentinelCheck['check']>>;
      try {
        decision = await opts.sentinel.check({ endpoint: opts.name, agent_id });
      } catch {
        // Sentinel failure MUST NOT block the agent. Treat as allow.
        decision = { allow: true };
      }
      if (!decision.allow) {
        captureEvent(buildEvent('policy.deny', opts, {
          agent_id, trace_id, timestamp: nowIso(),
          duration_ms: Math.round(performance.now() - started),
          context: { reason: decision.reason, policy: decision.policy },
        }));
        return jsonResponse(429, {
          error: 'policy_denied',
          reason: decision.reason ?? 'unknown',
          policy: decision.policy ?? 'unspecified',
        });
      }
    }

    // 2. Start frame.
    captureEvent(buildEvent('invoke.start', opts, { agent_id, trace_id, timestamp: nowIso() }));

    // 3. Delegate + capture outcome.
    try {
      const res = await opts.handler(req);
      const duration_ms = Math.round(performance.now() - started);
      captureEvent(buildEvent('invoke.success', opts, {
        agent_id, trace_id, timestamp: nowIso(), duration_ms,
        context: { status: res.status },
      }));
      opts.sentinel?.record?.({ endpoint: opts.name, agent_id, success: res.ok });
      return res;
    } catch (err) {
      const duration_ms = Math.round(performance.now() - started);
      const e = err as Error;
      captureEvent(buildEvent('invoke.error', opts, {
        agent_id, trace_id, timestamp: nowIso(), duration_ms,
        error: e?.message ?? String(err),
        stack: e?.stack,
      }));
      opts.sentinel?.record?.({ endpoint: opts.name, agent_id, success: false });
      throw err;
    }
  };
}

// ─── MCP tool wrapper (JSON-RPC handler) ───────────────────────────────────

export interface WrapMcpToolOptions<TArgs, TRes> {
  name: string;
  version?: string;
  sentinel?: SentinelCheck;
  handler: (args: TArgs) => Promise<TRes> | TRes;
}

/**
 * Wrap an MCP tool handler function with tracing + policy. Signature
 * matches the input handler so callers can swap in-place.
 */
export function wrapMcpTool<TArgs, TRes>(
  opts: WrapMcpToolOptions<TArgs, TRes>,
): (args: TArgs, agent_id?: string) => Promise<TRes> {
  if (!isPlatformEnabled()) {
    return async (args) => opts.handler(args);
  }

  return async (args, agentIdHint = 'anonymous') => {
    const trace_id = randomUUID();
    const started = performance.now();
    const nowIso = () => new Date().toISOString();
    const agent_id = agentIdHint;

    if (opts.sentinel) {
      let decision: Awaited<ReturnType<SentinelCheck['check']>>;
      try {
        decision = await opts.sentinel.check({ endpoint: opts.name, agent_id, payload: args });
      } catch {
        decision = { allow: true };
      }
      if (!decision.allow) {
        captureEvent({
          kind: 'policy.deny',
          endpoint: opts.name,
          version: opts.version,
          agent_id, trace_id, timestamp: nowIso(),
          context: { reason: decision.reason, policy: decision.policy },
        });
        throw new McpToolDenied(decision.reason ?? 'policy_denied');
      }
    }

    captureEvent({ kind: 'invoke.start', endpoint: opts.name, version: opts.version, agent_id, trace_id, timestamp: nowIso() });

    try {
      const result = await opts.handler(args);
      captureEvent({
        kind: 'invoke.success',
        endpoint: opts.name,
        version: opts.version,
        agent_id, trace_id, timestamp: nowIso(),
        duration_ms: Math.round(performance.now() - started),
        payload_hash: hashPayload(args),
      });
      opts.sentinel?.record?.({ endpoint: opts.name, agent_id, success: true });
      return result;
    } catch (err) {
      const e = err as Error;
      captureEvent({
        kind: 'invoke.error',
        endpoint: opts.name,
        version: opts.version,
        agent_id, trace_id, timestamp: nowIso(),
        duration_ms: Math.round(performance.now() - started),
        error: e?.message ?? String(err),
        stack: e?.stack,
      });
      opts.sentinel?.record?.({ endpoint: opts.name, agent_id, success: false });
      throw err;
    }
  };
}

/** Thrown by wrapMcpTool when the sentinel denies. Callers translate to JSON-RPC. */
export class McpToolDenied extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'McpToolDenied';
  }
}

// ─── Internal helpers ──────────────────────────────────────────────────────

function buildEvent(
  kind: AgentEvent['kind'],
  opts: WrapAgentOptions,
  rest: Omit<AgentEvent, 'kind' | 'endpoint' | 'version' | 'chain'>,
): AgentEvent {
  return {
    kind,
    endpoint: opts.name,
    version: opts.version,
    chain: opts.chain,
    ...rest,
  };
}

function extractAgentId(req: NextRequest): string {
  // Prefer explicit agent identity headers set by n-payment / ERC-8004 KYA.
  const candidates = [
    req.headers.get('x-hypermove-agent-id'),
    req.headers.get('x-agent-id'),
    req.headers.get('x-erc-8004-agent'),
  ];
  for (const c of candidates) {
    if (c && c.length > 0 && c.length <= 128) return c;
  }
  return 'anonymous';
}

function hashPayload(args: unknown): string {
  try {
    return createHash('sha256').update(JSON.stringify(args ?? '')).digest('hex').slice(0, 32);
  } catch {
    return '';
  }
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
