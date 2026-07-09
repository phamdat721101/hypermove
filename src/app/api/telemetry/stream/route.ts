import type { NextRequest } from 'next/server';
import { queryHMEvents, queryHMPolicyHits, type HMEventRow, type HMPolicyHitRow } from '@/lib/db';
import { isPlatformEnabled } from '@/lib/platform-flag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * /api/telemetry/stream
 * ----------------------
 * Server-Sent Events feed that powers the /portal/telemetry dashboard.
 *
 * Reuses the exact SSE ReadableStream pattern from /api/agent/route.ts — no
 * new abstractions, no WebSocket dependency. The client uses standard
 * EventSource (built into every browser).
 *
 * Polling model: every 2s query the two tables for rows newer than the last
 * cursor. This is intentionally coarse — the dashboard is a monitoring surface,
 * not a real-time trading UI. 2s latency is acceptable and avoids DB thrash.
 *
 * When FEATURE_HM_PLATFORM=false the stream closes immediately with an
 * end frame — dashboards render an empty state.
 */

const POLL_MS = 2_000;
const HEARTBEAT_MS = 15_000;

export async function GET(_req: NextRequest) {
  if (!isPlatformEnabled()) {
    return new Response(
      `event: end\ndata: {"reason":"platform_disabled"}\n\n`,
      { headers: sseHeaders() },
    );
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enc = new TextEncoder();
      let cursor = new Date().toISOString();
      let closed = false;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      let pollTimer: ReturnType<typeof setInterval> | null = null;

      const send = (event: string, data: unknown) => {
        if (closed) return;
        try { controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)); }
        catch { /* stream closed by client */ }
      };

      const poll = async () => {
        if (closed) return;
        try {
          const [events, hits] = await Promise.all([
            queryHMEvents({ since: cursor, limit: 50 }),
            queryHMPolicyHits(cursor, 50),
          ]);
          if (events.length > 0) send('events', events);
          if (hits.length > 0) send('policy_hits', hits);
          cursor = new Date().toISOString();
        } catch (err) {
          send('error', { message: String(err) });
        }
      };

      // Initial payload — fill the dashboard immediately.
      try {
        const [events, hits] = await Promise.all([
          queryHMEvents({ limit: 100 }),
          queryHMPolicyHits(undefined, 100),
        ]);
        send('snapshot', { events, hits });
      } catch { /* fall through to polling */ }

      pollTimer = setInterval(poll, POLL_MS);
      heartbeatTimer = setInterval(() => send('heartbeat', { t: Date.now() }), HEARTBEAT_MS);

      // Close handler.
      const cleanup = () => {
        if (closed) return;
        closed = true;
        if (pollTimer) clearInterval(pollTimer);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        try { controller.close(); } catch { /* already closed */ }
      };

      // Next.js RouteHandlers don't expose an abort event directly on the
      // controller, but the browser closing EventSource ends the stream on
      // the next enqueue attempt — the try/catch above swallows that.
      // We stop the polling loop after a 10-minute hard cap.
      setTimeout(cleanup, 10 * 60 * 1000);
    },
  });

  return new Response(stream, { headers: sseHeaders() });
}

function sseHeaders(): HeadersInit {
  return {
    'content-type': 'text/event-stream',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-hm-stream': '1',
  };
}

// Re-export types so the dashboard can import them from a single place.
export type StreamedEvent = HMEventRow;
export type StreamedPolicyHit = HMPolicyHitRow;
