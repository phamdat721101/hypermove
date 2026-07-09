/**
 * /api/errors
 * -----------
 * Public ingestion endpoint for HyperMove v2.0 observability events.
 *
 * Third-party integrators, hosted MCP servers, and offline batch uploaders POST
 * events here. The endpoint accepts a single event OR a batch (up to 100), runs
 * hand-rolled Zod-style validation, and persists via db.ts insertHMEvent.
 *
 * Contract:
 *  - Method: POST
 *  - Body: AgentEvent | AgentEvent[]  (max 1 MB payload)
 *  - Success: 202 Accepted + { accepted: N }
 *  - Bad shape: 400 + { error, path }
 *  - Oversize: 413
 *
 * Fire-and-forget for maximum throughput — we ack 202 before all rows are
 * flushed to Postgres. Sinks are idempotent-friendly (unique on trace_id can
 * be added by consumers if needed).
 *
 * The route itself is wrapped by wrapAgentEndpoint so we get self-observability
 * of the ingestion pipeline (dogfooding). Sentinel is intentionally omitted
 * here — the security guard covers rate-limit + sig verify.
 */

import type { NextRequest } from 'next/server';
import { wrapAgentEndpoint } from '@/lib/observability';
import { validateAgentEvent, type AgentEvent } from '@/lib/observability/types';
import { captureEventSync, getDefaultSink } from '@/lib/observability/capture';
import { guard, type GuardOutcome } from '@/lib/security';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_PAYLOAD_BYTES = 1_000_000;   // 1 MB hard cap
const MAX_BATCH = 100;

async function handlePost(req: NextRequest): Promise<Response> {
  // 1. Security guard (rate limit + sig verify + payload size)
  const guardResult: GuardOutcome = await guard(req, { endpoint: '/api/errors' });
  if (!guardResult.allow) {
    return json(guardResult.status ?? 401, { error: guardResult.reason ?? 'guard_denied' });
  }

  // 2. Read + size-check raw body
  const raw = await req.text();
  if (raw.length > MAX_PAYLOAD_BYTES) {
    return json(413, { error: 'payload_too_large', limit_bytes: MAX_PAYLOAD_BYTES });
  }

  // 3. Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json(400, { error: 'invalid_json' });
  }

  // 4. Normalize to array
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  if (arr.length === 0) {
    return json(400, { error: 'empty_batch' });
  }
  if (arr.length > MAX_BATCH) {
    return json(400, { error: 'batch_too_large', limit: MAX_BATCH });
  }

  // 5. Validate every event before we accept the batch.
  const events: AgentEvent[] = [];
  for (let i = 0; i < arr.length; i++) {
    const v = validateAgentEvent(arr[i]);
    if (!v.ok) return json(400, { error: 'validation_failed', index: i, detail: v.error });
    events.push(v.value);
  }

  // 6. Fire-and-forget writes through the default sink.
  const sink = getDefaultSink();
  queueMicrotask(() => {
    for (const ev of events) {
      captureEventSync(ev, sink).catch(() => {
        // Sink liveness contract — errors are swallowed inside the sink.
      });
    }
  });

  return json(202, { accepted: events.length });
}

export const POST = wrapAgentEndpoint({
  name: 'hypermove.errors.ingest',
  version: '1.0.0',
  handler: handlePost,
});

// GET → discovery ping so agents can confirm the endpoint exists.
export function GET() {
  return json(200, {
    endpoint: '/api/errors',
    accepts: ['application/json'],
    max_batch: MAX_BATCH,
    max_payload_bytes: MAX_PAYLOAD_BYTES,
    schema: 'AgentEvent | AgentEvent[]',
  });
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
