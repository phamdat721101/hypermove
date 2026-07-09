import type { Metadata } from 'next';
import { queryHMEvents, queryHMPolicyHits } from '@/lib/db';
import { isPlatformEnabled } from '@/lib/platform-flag';
import { TelemetrySections } from './sections';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export const metadata: Metadata = {
  title: 'Telemetry · HyperMove',
  description: 'Live errors, policy hits, and latency for HyperMove-registered endpoints.',
};

/**
 * /portal/telemetry
 * -----------------
 * HyperMove v2.0 observability dashboard — three co-located sections:
 *
 *   A. Errors    (invoke.error + invoke.success rates)
 *   B. Policies  (sentinel deny + circuit-breaker + security rejects)
 *   C. Metrics   (p50/p95 latency, endpoint volume)
 *
 * Server component fetches the initial snapshot from Postgres, then hands
 * off to the client `TelemetrySections` component which subscribes to
 * /api/telemetry/stream via EventSource for live updates.
 *
 * Zero chart libraries — sparklines are inline SVG so we add no new deps.
 */
export default async function TelemetryPage() {
  const enabled = isPlatformEnabled();
  const [events, hits] = enabled
    ? await Promise.all([queryHMEvents({ limit: 100 }), queryHMPolicyHits(undefined, 100)])
    : [[], []];

  return (
    <main className="mx-auto max-w-6xl px-4 py-10">
      <header className="mb-8 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Telemetry</h1>
          <p className="mt-1 text-sm text-neutral-400">
            HyperMove v2.0 Platform Layer — errors, policies, and metrics.{' '}
            {enabled ? (
              <span className="ml-1 rounded bg-emerald-500/10 px-1.5 py-0.5 text-xs text-emerald-400">
                live
              </span>
            ) : (
              <span className="ml-1 rounded bg-neutral-500/10 px-1.5 py-0.5 text-xs text-neutral-400">
                FEATURE_HM_PLATFORM=false
              </span>
            )}
          </p>
        </div>
        <a
          href="/docs/observability.md"
          className="text-xs text-neutral-400 underline decoration-dotted underline-offset-4 hover:text-neutral-200"
        >
          API docs
        </a>
      </header>

      {enabled ? (
        <TelemetrySections initialEvents={events} initialHits={hits} />
      ) : (
        <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-8 text-center text-sm text-neutral-400">
          Set{' '}
          <code className="rounded bg-neutral-800 px-1.5 py-0.5 font-mono text-xs text-neutral-200">
            FEATURE_HM_PLATFORM=true
          </code>{' '}
          in your environment to enable the observability layer.
        </div>
      )}
    </main>
  );
}
