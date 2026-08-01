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

const g = await guard(req, { endpoint: '/api/paid-endpoint' });
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

## Rollback

```bash
export FEATURE_HM_PLATFORM=false
# Every wrapper becomes an identity function.
# No DB writes. No dashboard traffic. v1.0 behavior restored byte-identical.
```

## MCP Gateway Guardians (2026-08-01)

The MCP gateway (`src/lib/mcp/gateway.ts`) now wires the SAME sentinel + output-enforcer modules
documented above directly into `callTool()`, independent of `FEATURE_HM_PLATFORM`:

```bash
FEATURE_MCP_GUARDIANS=true    # default — sentinel.check()/record() + ToolDef.verify enforced
FEATURE_MCP_GUARDIANS=false   # opt-out — byte-identical to pre-2026-08-01 behavior
```

This is a **separate, independent gate** from `FEATURE_HM_PLATFORM`: `createSentinel({forceEnabled:
true})` bypasses the `isPlatformEnabled()` gate that every other sentinel consumer (above) is still
subject to, so `FEATURE_MCP_GUARDIANS` alone controls MCP tool-call enforcement even with
`FEATURE_HM_PLATFORM` at its default (off). Admin sessions bypass this check the same way they
bypass metering. Denials return a JSON-RPC error (`code: -32000`) with `data.policy`/`data.reason`.

Per-tool output verification is opt-in via `ToolDef.verify` (a tool that doesn't set it is
unaffected) — `flare.token.save` is the one tool currently wired as a proof-of-concept, checking its
`ServiceResult` envelope's `ok` field is present.

## HMCP-001 / HMCP-008 status (v2.1 planning verification, 2026-08-01)

A separate planning pass evaluated the original 8-PRD "MCP Production Playbook" against this
codebase's actual architecture. Two pillars were found to already be **substantially satisfied** by
existing code and received no new implementation this round — verified as follows, so a future
reader understands why no build task exists for them without re-deriving the analysis:

**Pillar 1 (outcome-oriented schema + progressive discovery).** `src/lib/mcp/tools.ts`'s
`getTools()` yields ≤35 tools with every flag on (11 always-on + ~24 flag-gated) — not the
playbook's assumed 45+ — and they are already outcome-shaped (`xrpl.settlement.quote`,
`flare.builder.brief`, `xrpl.yield.compare`, not atomic CRUD steps requiring multi-hop chaining).
`search` / `codemode.catalog` / `codemode.describe` / `codemode.spec` already provide progressive,
layered discovery. **The one real remaining gap**: every enabled tool is unconditionally listed in
`tools/list` — there is no semantic trimming of the disclosed tool set itself (e.g. filtering to the
top-K relevant tools per query via embedding similarity, as HMCP-001's FR-001-2 originally
requested). Flags add or remove whole tools; nothing trims the always-on set at request time. This
gap is explicitly **deferred**, not silently dropped — revisit if disclosure-token overhead on the
always-on 11-tool baseline is ever measured to be a real problem.

**Pillar 8 (agent-native observability).** `mcp_calls` (see `src/lib/db.ts`) is a real per-call audit
ledger — `tool_name`, `tier`, `params_hash`, `response_bytes`, `latency_ms`, `outcome`, and (as of
this round's Task 5/6) `tokens_used`/`cost_usd` for the one call path with genuine LLM cost. Sentinel
denials are now logged live to `hm_policy_hits` on the MCP path too (Task 2, above). **The remaining
gap**: no dashboard UI / "mission control" view exists — `mcp_calls` and `hm_policy_hits` are
queryable tables, not a rendered timeline/trace viewer. This gap is explicitly **deferred**; the data
substrate a future dashboard would read from now exists and is richer than before this round, but no
UI was built.
