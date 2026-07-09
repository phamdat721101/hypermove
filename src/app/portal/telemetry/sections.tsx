'use client';

/**
 * src/app/portal/telemetry/sections.tsx
 * --------------------------------------
 * Three co-located dashboard sections (Errors + Policies + Metrics) + one
 * inline useTelemetryStream hook that subscribes to /api/telemetry/stream.
 *
 * Design decisions:
 *  - No chart library. Sparklines are inline SVG (12 LOC each) — zero new deps,
 *    <1KB rendered, plays nice with SSR.
 *  - Sections co-located in ONE file because they share the same live-data
 *    hook + card styling. Splitting into three files would triple boilerplate.
 *  - Client component boundary is at this file, not in page.tsx, so the
 *    initial snapshot renders on the server for fast first paint.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import type { HMEventRow, HMPolicyHitRow } from '@/lib/db';

interface Props {
  initialEvents: HMEventRow[];
  initialHits: HMPolicyHitRow[];
}

export function TelemetrySections({ initialEvents, initialHits }: Props) {
  const { events, hits, connected } = useTelemetryStream(initialEvents, initialHits);
  return (
    <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
      <ErrorsSection events={events} connected={connected} />
      <PoliciesSection hits={hits} />
      <MetricsSection events={events} />
    </div>
  );
}

// ─── A · Errors ─────────────────────────────────────────────────────────────

function ErrorsSection({ events, connected }: { events: HMEventRow[]; connected: boolean }) {
  const errors = events.filter((e) => e.kind === 'invoke.error');
  const grouped = groupBy(errors, (e) => `${e.endpoint} · ${(e.error ?? 'unknown').slice(0, 60)}`);

  return (
    <Card title="Errors" subtitle={`${errors.length} in last 100 · ${connected ? 'live' : 'reconnecting…'}`}>
      {errors.length === 0 ? (
        <Empty>No errors captured.</Empty>
      ) : (
        <ul className="space-y-2">
          {Array.from(grouped.entries()).slice(0, 8).map(([label, group]) => (
            <li key={label} className="rounded-md border border-neutral-800 bg-neutral-900/40 p-3">
              <div className="flex items-baseline justify-between gap-2">
                <p className="truncate text-sm font-medium text-neutral-100">{label}</p>
                <span className="shrink-0 rounded bg-red-500/10 px-1.5 py-0.5 text-xs text-red-400">
                  ×{group.length}
                </span>
              </div>
              <p className="mt-1 truncate text-xs text-neutral-500">
                agent {group[0].agent_id} · trace {group[0].trace_id.slice(0, 8)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ─── B · Policies ───────────────────────────────────────────────────────────

function PoliciesSection({ hits }: { hits: HMPolicyHitRow[] }) {
  const byPolicy = groupBy(hits, (h) => h.policy);
  return (
    <Card title="Policies" subtitle={`${hits.length} hits`}>
      {hits.length === 0 ? (
        <Empty>No policy hits.</Empty>
      ) : (
        <ul className="space-y-2">
          {Array.from(byPolicy.entries()).map(([policy, group]) => (
            <li key={policy} className="flex items-center justify-between rounded-md border border-neutral-800 bg-neutral-900/40 p-3">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-neutral-100">{policy}</p>
                <p className="truncate text-xs text-neutral-500">
                  {group[0].endpoint} · {group[0].reason}
                </p>
              </div>
              <span className="shrink-0 rounded bg-amber-500/10 px-1.5 py-0.5 text-xs text-amber-400">
                ×{group.length}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ─── C · Metrics ────────────────────────────────────────────────────────────

function MetricsSection({ events }: { events: HMEventRow[] }) {
  const successes = events.filter((e) => e.kind === 'invoke.success' && typeof e.duration_ms === 'number');
  const durations = successes.map((e) => e.duration_ms as number).sort((a, b) => a - b);
  const p50 = percentile(durations, 0.5);
  const p95 = percentile(durations, 0.95);
  const p99 = percentile(durations, 0.99);

  const byEndpoint = groupBy(successes, (e) => e.endpoint);
  const sparkPoints = successes.slice(0, 30).map((e) => e.duration_ms as number).reverse();

  return (
    <Card title="Metrics" subtitle={`${successes.length} successful calls`}>
      <div className="mb-4 grid grid-cols-3 gap-3 text-center">
        <Stat label="p50" value={`${p50}ms`} />
        <Stat label="p95" value={`${p95}ms`} />
        <Stat label="p99" value={`${p99}ms`} />
      </div>
      <div className="mb-4">
        <Sparkline points={sparkPoints} />
      </div>
      {byEndpoint.size === 0 ? (
        <Empty>No successful invocations yet.</Empty>
      ) : (
        <ul className="space-y-1 text-xs">
          {Array.from(byEndpoint.entries()).map(([endpoint, group]) => (
            <li key={endpoint} className="flex items-center justify-between">
              <span className="truncate text-neutral-300">{endpoint}</span>
              <span className="text-neutral-500">{group.length}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ─── Reusable primitives ────────────────────────────────────────────────────

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-neutral-800 bg-neutral-900/30 p-5">
      <header className="mb-4 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-neutral-200">{title}</h2>
        {subtitle && <p className="text-xs text-neutral-500">{subtitle}</p>}
      </header>
      {children}
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-neutral-800 bg-neutral-950 py-2">
      <div className="text-lg font-medium text-neutral-100">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-neutral-500">{label}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="rounded-md border border-dashed border-neutral-800 py-6 text-center text-xs text-neutral-500">{children}</p>;
}

function Sparkline({ points }: { points: number[] }) {
  if (points.length < 2) return <div className="h-8" />;
  const max = Math.max(...points, 1);
  const width = 240;
  const height = 32;
  const step = width / (points.length - 1);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${(i * step).toFixed(2)} ${(height - (p / max) * height).toFixed(2)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-8 w-full" preserveAspectRatio="none" aria-hidden="true">
      <path d={d} fill="none" stroke="currentColor" strokeWidth={1.5} className="text-emerald-400" />
    </svg>
  );
}

// ─── Hooks + utilities ──────────────────────────────────────────────────────

function useTelemetryStream(seedEvents: HMEventRow[], seedHits: HMPolicyHitRow[]) {
  const [events, setEvents] = useState<HMEventRow[]>(seedEvents);
  const [hits, setHits] = useState<HMPolicyHitRow[]>(seedHits);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof EventSource === 'undefined') return;
    const es = new EventSource('/api/telemetry/stream');
    esRef.current = es;
    es.addEventListener('snapshot', (raw) => {
      try {
        const p = JSON.parse((raw as MessageEvent).data) as { events: HMEventRow[]; hits: HMPolicyHitRow[] };
        if (Array.isArray(p.events)) setEvents(p.events);
        if (Array.isArray(p.hits)) setHits(p.hits);
        setConnected(true);
      } catch { /* ignore */ }
    });
    es.addEventListener('events', (raw) => {
      try {
        const rows = JSON.parse((raw as MessageEvent).data) as HMEventRow[];
        setEvents((prev) => [...rows, ...prev].slice(0, 100));
      } catch { /* ignore */ }
    });
    es.addEventListener('policy_hits', (raw) => {
      try {
        const rows = JSON.parse((raw as MessageEvent).data) as HMPolicyHitRow[];
        setHits((prev) => [...rows, ...prev].slice(0, 100));
      } catch { /* ignore */ }
    });
    es.addEventListener('heartbeat', () => setConnected(true));
    es.addEventListener('error', () => setConnected(false));
    return () => es.close();
  }, []);

  return useMemo(() => ({ events, hits, connected }), [events, hits, connected]);
}

function groupBy<T>(items: readonly T[], keyFn: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const k = keyFn(item);
    const bucket = out.get(k);
    if (bucket) bucket.push(item);
    else out.set(k, [item]);
  }
  return out;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[idx];
}
