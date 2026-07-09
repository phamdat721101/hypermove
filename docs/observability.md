# HyperMove v2.0 Observability — public API

> Ship agent-callable endpoints with structured tracing + policy enforcement +
> agentjacking defense in **one line of code**. Compatible with Sentry via
> optional forward. Rollback is a single env-var flip.

## Master flag

Everything in this module is gated by a single env var:

```bash
FEATURE_HM_PLATFORM=false   # default — byte-identical v1.0 behavior
FEATURE_HM_PLATFORM=true    # v2.0 observability + sentinel + security active
```

## Public API

```ts
import {
  wrapAgentEndpoint,
  wrapMcpTool,
  captureEvent,
  McpToolDenied,
} from '@/lib/observability';
```

### `wrapAgentEndpoint(opts)`

Wrap any Next.js Route Handler with tracing + optional policy enforcement.

```ts
// src/app/api/paid-endpoint/route.ts
import { wrapAgentEndpoint } from '@/lib/observability';
import { defaultSentinel } from '@/lib/sentinel';

async function handleGet(req) {
  // your existing handler — unchanged
}

export const GET = wrapAgentEndpoint({
  name: 'hypermove.pay.x402',
  version: '1.0.0',
  chain: 'goat-mainnet',
  sentinel: defaultSentinel(),    // optional
  handler: handleGet,
});
```

**What gets captured (per invocation):**

| Field | Source |
|---|---|
| `trace_id` | crypto.randomUUID() minted at request entry |
| `endpoint` | `opts.name` |
| `agent_id` | `x-hypermove-agent-id` / `x-agent-id` / `x-erc-8004-agent` header, else `anonymous` |
| `duration_ms` | performance.now() delta |
| `error` / `stack` | Error object when the handler throws (truncated to 4KB / 8KB) |
| `context.status` | Response.status on success |

### `wrapMcpTool(opts)`

Same shape, but for JSON-RPC MCP tool handlers.

```ts
const callPaymentX402 = wrapMcpTool({
  name: 'payment.x402',
  version: '1.0.0',
  sentinel: defaultSentinel(),
  handler: async (args, ctx) => { /* … */ },
});

// In the route handler:
const result = await callPaymentX402(args, agentId);
```

Sentinel denials throw `McpToolDenied` — translate to JSON-RPC `-32402`.

### `captureEvent(event)`

Fire a custom event through the default sink (Postgres + optional Sentry).
Non-blocking (queueMicrotask). Callers do not await.

```ts
import { captureEvent } from '@/lib/observability';

captureEvent({
  kind: 'invoke.success',
  endpoint: 'my.tool',
  agent_id: 'agent-abc',
  trace_id: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
});
```

## Sentinel

```ts
import { defaultSentinel, createSentinel } from '@/lib/sentinel';

// Env-var configured — recommended for 90% of use cases
const s = defaultSentinel();

// Or explicit
const s = createSentinel({
  costCaps: { perAgentDailyUsd: 50, perAgentHourlyUsd: 10 },
  policies: { endpointAllowlist: ['hypermove.pay.x402'], promptInjection: 'strict' },
  circuitBreaker: { errorThreshold: 0.5, cooldownMs: 60_000 },
});
```

Enforcement pipeline:

1. **Endpoint allowlist** — deny endpoints not in the set
2. **Circuit breaker** — deny while the breaker is open (opens on ≥ threshold error-rate over sliding window)
3. **Cost caps** — daily + hourly per-agent
4. **Prompt-injection heuristic** — regex + token deny-list on the payload

**Telemetry-resilience contract**: DB outages **never** disable enforcement. Cost + circuit state is memory-first; DB writes are best-effort.

## Security guard (agentjacking defense)

```ts
import { guard } from '@/lib/security';

const g = await guard(req, { endpoint: '/api/errors' });
if (!g.allow) return new Response(g.reason, { status: g.status ?? 401 });
// Optional per-agent context
const rateLimiter = g.context!.isolate('rate', () => new Map());
```

Six CSA-recommended defenses:

1. Sliding-window rate limit (default 100/min per agent)
2. Payload size cap (Content-Length hint)
3. Header prompt-injection scan (shared with sentinel — never duplicated)
4. ed25519 signature verification (`HM_ED25519_PUBKEY` env; skipped when unset)
5. ERC-8004 sender attestation cross-check (stub — returns `attested: false` gracefully)
6. Per-agent isolation contexts (bounded LRU, 5k agents max)

## Sentry-forward (enterprise buyers)

Set `SENTRY_DSN` in the environment. HyperMove lazy-imports `@sentry/nextjs` at
first `invoke.error` capture. If the package is not installed, the sink silently
degrades to a no-op. Zero required dependency, zero performance impact on the
primary path.

## Dashboard

Enable `FEATURE_HM_PLATFORM=true` and open `/portal/telemetry` — three sections
render live via SSE (Errors + Policies + Metrics). Set
`DATABASE_URL` for persistence (Supabase pooler recommended; see main README).

## Rollback

```bash
export FEATURE_HM_PLATFORM=false
# Every wrapper becomes an identity function.
# No DB writes. No dashboard traffic. v1.0 behavior restored byte-identical.
```
