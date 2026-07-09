/**
 * src/lib/observability/capture.ts
 * ---------------------------------
 * Non-blocking event capture with pluggable Strategy-pattern sinks.
 *
 * SOLID:
 *  - Strategy (Dependency Inversion): consumers depend on the EventSink
 *    interface, never on a concrete sink. Add Grafana/Datadog by writing one
 *    class — zero consumer changes.
 *  - Liskov: every sink is guaranteed non-throwing. Telemetry failures MUST
 *    NEVER break the agent execution path (agentsentinel.dev principle).
 *  - Open/Closed: composeSinks() takes any number of sinks; the composite is
 *    also an EventSink, enabling nested composition.
 *
 * Performance contract:
 *  - captureEvent() returns synchronously in <1ms — actual I/O is scheduled
 *    via queueMicrotask so the hot request path is never blocked.
 *  - Errors from any sink are swallowed and logged; other sinks still fire.
 */

import { isPlatformEnabled, isSentryForwardEnabled } from '../platform-flag';
import { insertHMEvent, type HMEventRow } from '../db';
import { truncate, type AgentEvent } from './types';

/** Strategy interface — one method, one contract. */
export interface EventSink {
  readonly name: string;
  /** MUST NOT throw. Return a promise that resolves when the write is done
   *  (or dropped after retries). Callers never await this promise directly. */
  emit(event: AgentEvent): Promise<void>;
}

// ─── PostgresSink — primary transport ───────────────────────────────────────

class PostgresSink implements EventSink {
  readonly name = 'postgres';

  async emit(event: AgentEvent): Promise<void> {
    const row: HMEventRow = {
      kind: event.kind,
      endpoint: event.endpoint,
      version: event.version,
      chain: event.chain,
      agent_id: event.agent_id,
      trace_id: event.trace_id,
      duration_ms: event.duration_ms,
      error: truncate(event.error, 4096),
      stack: truncate(event.stack, 8192),
      payload_hash: event.payload_hash,
      context: event.context,
    };
    try {
      const res = await insertHMEvent(row);
      if (!res.ok && !res.noopReason) {
        // eslint-disable-next-line no-console
        console.warn('[observability] postgres sink dropped event', { trace_id: event.trace_id });
      }
    } catch (err) {
      // Never surface. Sink liveness contract.
      // eslint-disable-next-line no-console
      console.warn('[observability] postgres sink threw', err);
    }
  }
}

// ─── SentryForwardSink — optional dual-write ────────────────────────────────
//
// Lazy-imports @sentry/nextjs the same way agent.ts lazy-imports
// @anthropic-ai/sdk. No npm dep is required; if the package is not installed,
// the sink degrades to a no-op.

class SentryForwardSink implements EventSink {
  readonly name = 'sentry-forward';
  private mod: unknown | null = null;
  private tried = false;

  async emit(event: AgentEvent): Promise<void> {
    if (event.kind !== 'invoke.error' && event.kind !== 'security.reject') return;
    try {
      if (!this.tried) {
        this.tried = true;
        // Optional peer dep. Both webpack (webpackIgnore) and vite (@vite-ignore)
        // are told to skip static resolution — the module is only imported when
        // SENTRY_DSN is set, and if it isn't installed we degrade to a no-op.
        const spec = '@sentry/nextjs';
        this.mod = await import(/* webpackIgnore: true */ /* @vite-ignore */ spec).catch(() => null);
      }
      const sentry = this.mod as { captureException?: (e: unknown, ctx?: unknown) => void } | null;
      if (!sentry?.captureException) return;
      const err = event.error ? new Error(event.error) : new Error(`${event.kind}@${event.endpoint}`);
      if (event.stack) err.stack = event.stack;
      sentry.captureException(err, {
        tags: { endpoint: event.endpoint, chain: event.chain, agent_id: event.agent_id },
        extra: { trace_id: event.trace_id, ...event.context },
      });
    } catch {
      // Sink liveness contract — never throw upstream.
    }
  }
}

// ─── CompositeSink — fan-out to multiple sinks ─────────────────────────────

class CompositeSink implements EventSink {
  readonly name = 'composite';
  constructor(private sinks: readonly EventSink[]) {}
  async emit(event: AgentEvent): Promise<void> {
    // Fire-and-forget in parallel. No sink can block another.
    await Promise.allSettled(this.sinks.map((s) => s.emit(event)));
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

let cachedSink: EventSink | null = null;

/** Build the default sink for the current process, respecting env flags. */
export function getDefaultSink(): EventSink {
  if (cachedSink) return cachedSink;
  const sinks: EventSink[] = [new PostgresSink()];
  if (isSentryForwardEnabled()) sinks.push(new SentryForwardSink());
  cachedSink = new CompositeSink(sinks);
  return cachedSink;
}

/** For tests. */
export function _resetSinkCacheForTests(): void {
  cachedSink = null;
}

/**
 * Fire an event through the default sink. Non-blocking (returns immediately
 * via queueMicrotask). Callers do not await.
 *
 * When FEATURE_HM_PLATFORM=false this is a byte-identical no-op.
 */
export function captureEvent(event: AgentEvent): void {
  if (!isPlatformEnabled()) return;
  const sink = getDefaultSink();
  queueMicrotask(() => {
    sink.emit(event).catch(() => {
      // Fully swallowed. Sink liveness contract.
    });
  });
}

/** Escape hatch for tests + advanced integrators: emit synchronously and await. */
export async function captureEventSync(event: AgentEvent, sink: EventSink = getDefaultSink()): Promise<void> {
  if (!isPlatformEnabled()) return;
  await sink.emit(event);
}
