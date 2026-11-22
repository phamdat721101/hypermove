# Public stateless flashloan research

## Client outcome

An MCP agent connects to https://mcp.overguild.com without any credentials,
cookies or MCP session ID, discovers eleven tools, and receives bounded research
results directly. EVM snapshots/plans and XRPL route data travel inline with
automatic integrity proofs. No public jobs, artifacts or knowledge are persisted.

## Audience

MCP research agents and developers using public market evidence without accounts.

## Scope

Eleven public stateless tools, proven inline data, shared research execution,
bounded isolated computation, private API compatibility and public deployment.

## Non-goals

No signing, broadcasting, bridge execution, shared public memory, caller identity,
new chain families, private identity-database repair or protocol-revision migration.

## Alternatives considered

Anonymous sessions were rejected in favor of stateless requests. Shared anonymous
ownership would expose other callers' artifacts. A combined pipeline would reduce
agent control over separate steps. Caller-editable snapshots would weaken the
existing verification boundary. A second research engine would duplicate math.

## Selected approach and why

The owner selected stateless requests, separate research steps, server-produced
inline payloads, the complete six-tool research workflow, and isolated bounded
CPU computation. Authentication and payment rules for the existing gateway are
retained. Root requests containing credentials stay on that existing gateway;
the canonical public path is /api/mcp/flashloan.

Shared ResearchEngine functions execute the same domain logic for private jobs
and public calls. PublicResearch bypasses repositories and knowledge; it uses a
shared two-slot admission controller (at most one public request), bounded hashed
IP counters, and worker threads for EVM/XRPL searches. Rust remains a bounded
subprocess. Gateway/worker transport is authenticated even though public callers
do not authenticate. No new runtime packages or database migrations are required.

## Public contracts

The deployed public version is `flashloan.public.v3`. The added mover tool
returns `flashloan.movers.v1`; existing proof envelopes remain version 2. A public
version change invalidates old registry-bound proofs: fetch a fresh snapshot/plan
after upgrading both app and worker. See the dated mover rollout verification
below for this version; older observations describe their original releases.

Canonical schemas: src/lib/mcp/flashloan/public-contracts.ts. Every root input is
strict. The catalog contains capabilities and the six existing discovery,
snapshot, sizing and simulation names. Public inputs omit idempotency keys and
replace stored snapshot/plan/route IDs with inline proven envelopes. Amounts are
exact uint256 decimal strings, and XRPL retains issuer-aware assets/funding modes.

Success is {schema_version, request_id, operation, ok:true, data, warnings,
execution:false}. Tool failures use MCP isError with {ok:false,error:{code,message,
retryable,retry_after_ms?}}. Request-level errors use 400/403/413/429/503 as
appropriate and never send an authentication challenge. A zero-candidate
discovery and NO_OPPORTUNITY/INCONCLUSIVE sizing report are valid outcomes.

Envelope fields: version=2, kind=evm_snapshot|evm_plan|xrpl_routes|sui_snapshot|sui_plan, issued_at,
expires_at, registry_version, content_hash, payload, proof={algorithm:HS256,
key_id:v2,signature}. HMAC signs canonical bytes of every non-proof field and a
domain prefix. Verification compares signatures in constant time. Registry and
effective-limit changes invalidate proofs; changing public engine semantics
requires bumping PUBLIC_VERSION. Proofs last at most ten minutes, and plans cannot
outlive source snapshots. They establish provenance, not privacy or identity.

The worker key is at least 32 random bytes, server-only, and separate from the
transport credential. EVM sizing/simulation rejects noncanonical blocks. Direct
RPC URLs, RPC methods, binaries, filesystem paths, signed XRPL transactions and
knowledge activation are never public inputs.

## Resource and transport policy

Hard ceilings: 2 MiB bodies/wire responses; 1 MiB envelopes; 30 tokens; four pools;
bitmap word_range<=1; 2,000 initialized ticks total; four XRPL assets; three routes;
500 evaluations; five-second CPU search budget; 30-second operation deadline;
60-second EVM simulation deadline; six computations and 60 transport requests per
IP/minute; one public/two total computations. Supported environment overrides can
lower these ceilings, never increase them. Invalid configuration fails closed.

Cancellation propagates from request through worker to CPU thread/native process.
Admission slots release only after computation finishes or cancellation cleanup.
No public queue exists. Oversized output fails explicitly, including MCP's
duplicated structured/text representation. Origin validation, TLS verification,
server-controlled destinations and existing deployment runtime attestation remain.
Production app/worker ports bind loopback; Caddy overwrites the trusted client-IP
header. Public application requests do not query the identity database.

## Risks

Anonymous traffic can exhaust finite capacity; per-IP quotas and shared hard
concurrency/byte/deadline limits fail explicitly. IP limits are fairness controls,
not identity. RPC availability, stale snapshots, reorgs, partial tick coverage,
proof expiry and generic EVM fidelity remain contextual limitations. Resource
cleanup and final wire-size caps prevent stalled requests or amplified replies.

## Token movers: public-only bounded discovery

`flashloan_get_token_movers` returns up to ten tokens per requested chain with
an absolute provider-reported 24h change of at least 10%. Supported chain keys:
`base` (8453), `arbitrum` (42161), `robinhood` (4663), and `sui` (mainnet; no EVM
chain ID). No wallet, RPC credential or market-data API key is needed for this
operation. It uses the existing protected worker and public admission limits.

```json
{
  "networks": ["base", "arbitrum", "robinhood", "sui"],
  "direction": "both",
  "min_change_24h_pct": 10,
  "limit_per_chain": 10,
  "min_liquidity_usd": 15000,
  "seed_tokens": {}
}
```

All fields are optional with the defaults shown. Networks must be unique.
Direction is `both`, `gainers` or `losers`; threshold is finite and at least 10;
limit is 1–10; liquidity is finite and nonnegative. Optional `seed_tokens` maps
requested networks to at most 30 token identifiers each. EVM addresses normalize
to lowercase; Sui uses package-normalized Move coin types, preserving module/type
case. Unknown fields and wrong-family identifiers are rejected.

The scan uses official DexScreener latest profiles, latest boosts, top boosts,
and two searches per chain: Base `base`/`WETH USDC`, Arbitrum `arbitrum`/`ARB USDC`,
Robinhood `robinhood`/`USDG`, Sui `sui`/`SUI USDC`. Search results are filtered by
actual chain identity. These are biased, bounded candidate sources, not a complete
chain token index. The official API has no documented chain-wide mover ranking.
See https://docs.dexscreener.com/api/reference and
https://docs.robinhood.com/chain/connecting/.

Candidates are deduplicated per chain, capped at 60 and prioritized caller →
search → profiles → latest boosts → top boosts, with lexical identifier ordering
within each priority. Metrics use `/tokens/v1/{chain}/{tokens}` batches of 30;
these responses do not establish exhaustive pool inventory.

For each token, select its highest-liquidity returned base-token market with a
positive price/liquidity and creation timestamp at least 24h before scan start.
Break market ties by 24h volume, then provider pool ID. Select before applying
movement thresholds. Missing/invalid change excludes that token; optional invalid
metadata does not promote a thinner market. Conflicting pool asset identities
are excluded and diagnosed. Quote-token changes are never inferred or inverted.
Apply the liquidity floor, then inclusive direction-specific ±threshold tests.
Rank by absolute change, liquidity, volume, then token identity. Single-pool tokens
remain eligible. Return fewer than ten when fewer qualify.

The standard public envelope contains a `flashloan.movers.v1` data payload with
`provider`, `started_at`, `completed_at`, normalized `parameters`, `chains`, and
`warnings`. Each chain includes `network`, nullable EVM `chain_id`, `environment`,
`outcome`, ranked `tokens`, `coverage` and bounded `diagnostics`.

Each token includes rank, canonical `token_id`, nullable name/symbol, signed
`price_change_24h_pct`, gain/loss direction, decimal-string USD price/liquidity,
nullable decimal-string volume, discovery sources and representative market
identity, quote token, creation/retrieval timestamps. Market provenance declares
`selection=highest_liquidity_observed`, `metric=dexscreener.priceChange.h24`, and
`provider_updated_at=null`: retrieval does not prove provider price freshness.

Coverage declares `scope=bounded_discovery`, `exhaustive=false`, candidate,
scanned, eligible, matched, returned and truncated-candidate counts, exclusion
reason counts and per-source outcomes/attempts/counts/timestamps. `SUCCESS` and
`EMPTY` require completed sources; `PARTIAL` retains useful data with failures,
malformed records or candidate truncation; `UNAVAILABLE` means no meaningful
evaluation succeeded. Empty responses do not prove an unsupported chain.

Maximum initial calls: 19; attempts including retries: 24; concurrent requests: 3.
Pair/search requests share inventory's limiter; feeds share a conservative
60/minute limiter. Individual requests have a five-second timeout; the scan uses
80% of the configured public operation deadline, retaining time to serialize.
Transient requests retry once. Retry-After beyond the scan budget fails that
source. Internal expiry returns completed data; caller cancellation aborts the
whole call. Responses are size-bounded, diagnostics capped at 64 per chain, and
there is no stale-data cache, public knowledge, filesystem or repository write.

Pass each returned chain's `token_id` values to
`flashloan_discover_arbitrage_pools` for independent full token-pair inventory.
Movement is not evidence of connected routes, funding, security or profit.

Verification: `pnpm exec vitest run tests/flashloan-movers.test.ts
tests/flashloan-public.test.ts`; opt-in live verification:
`FLASHLOAN_MOVERS_LIVE=1 pnpm exec vitest run tests/flashloan-movers.test.ts`.
The SDK E2E checks all four chains, tool annotations, pool-discovery composition,
protected internal transport, credential-free ingress and no storage access.
No new dependency, schema migration or required environment variable is added.

## Acceptance criteria

Automated public SDK E2E verifies no Authorization/session headers, eleven tools,
protected worker transport and no repository calls. The real Anvil/Rust pipeline
verifies public inline snapshots/plans, repayment, transfer-tax rejection and
cooldown rejection without broadcasting. Unit/integration checks cover proof
modification, expiry, registry/kind mismatch, schema/UTF-8/depth limits, quotas,
shared capacity, cancellation cleanup and feature rollback. Existing private,
PostgreSQL and four-network read-only tests remain acceptance gates.

Live deployment acceptance must independently verify public root and canonical
path, private endpoint auth, trusted proxy behavior, no session allocation, public
read-only EVM/XRPL research and the actual Linux engine. Inconclusive markets do
not justify fabricated plans or profitable-trade claims. Generic Cancun remains
incomplete chain-native verification; reports keep can_execute=false and
chain_native_verified=false. No procedure or rule is approved by this feature.

See flashloan-public-stateless-map.md for executable boundary proofs. Deployment
is opt-in via FEATURE_MCP_FLASHLOAN_PUBLIC_STATELESS. Rollback disables that flag
and restores the previous root proxy route without modifying private ownership.

## Rollout and rollback

Build an isolated Linux release, run local/native proofs and public acceptance,
then enable the public flag and route the public root. Retain credential-bearing
root/private routing. Restore Caddyfile.pre-public-stateless and the previous
PM2 release to roll back; preserve the existing private data directory.

## Environment contract

See services/flashloan/environment-contract.json. The separate server-only
integrity key is mandatory when the public flag is enabled. Internal transport
retains its bearer credential and loopback binding. External RPC TLS verifies
hostnames. Public calls have no identity, SQL, artifact or knowledge side effects;
the existing private queue retains its PostgreSQL startup requirement.

## Post-delivery evidence

Record actual public HTTPS/SDK responses, Linux native proof logs, deployed source
fingerprints, full regression/types/build, private PostgreSQL, four-network live
results and all five executable map edges. Local .nim evidence contains no secret
values; it is intentionally not committed. Completion requires both delivery
checks and the executable map verification, not just the existence of this brief.

## Verified mover rollout — 2026-10-28

Gateway and worker release `worktree-movers-5c3499ba3e74` is deployed at
`https://mcp.overguild.com` and `/api/mcp/flashloan`. Independent credential-free
HTTPS SDK checks from the VPS and development host verified the same eleven-tool
catalog, public v3, four-chain mover coverage and inventory composition. The
external scan returned four Robinhood movers; the other chains had zero
qualifying tokens in that bounded scan. A returned Robinhood token produced
three observed pools when passed to pool discovery. Results vary with markets.

The isolated Linux candidate passed 64 focused tests (one opt-in live case
skipped), service TypeScript
compilation, production Next build and the Anvil/Rust native E2E. All 37 source
fingerprints matched the reviewed files. Gateway/worker use Node 22.15.0 and
PM2 state is saved; private MCP returns 401 without credentials. Existing Dream
disablement, stopped LLM and `/llm/health` HTTP 410 are preserved. External worker
data and server credentials are unchanged. The previous active release remains
at `/home/ubuntu/hypermove-public-backup-20261028-movers` for rollback.

Sanitized evidence, source manifest, compiled deployment specification and
delivery receipts are local `.nim/movers-vps-*` artifacts. No procedure or rule
was approved by this deployment.

## Verified rollout — 2026-10-25

The public root and canonical path were verified with no credentials/session IDs.
All seven tools were advertised; both credential-bearing root variants and private
/api/mcp authentication were preserved. Live proven snapshots covered Ethereum,
Arbitrum and Base; sampled Base sizing returned NO_OPPORTUNITY. Native XRPL returned
NATIVE_DRY_RUN without applying the transaction. The actual Linux engine passed
public inline repayment, transfer-tax and cooldown E2E. Private PostgreSQL tests,
all eight explicit live read-only checks, full regression, TypeScript and production
build passed. No live feasible/profitable EVM opportunity was asserted.

Active app/worker: /home/ubuntu/hypermove-public-release. The previous release and
/etc/caddy/Caddyfile.pre-public-stateless remain available for rollback. Public
requests bypass private storage; existing private artifacts/knowledge keep their
previous data directory. Lint remains unconfigured, as before this upgrade.

## v2 coverage extension

The coverage contract in flashloan-pool-coverage.md supersedes the original
seven-tool/no-new-chain assumptions. It adds the optional official Sui SDK and
three gated native tools, provider-scoped inventory and major-version proofs.
