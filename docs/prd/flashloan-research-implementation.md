# Flashloan research implementation and delivery contract

Status: implemented research-only feature, opt-in. User-approved architecture:
existing gateway plus worker; Ethereum, Arbitrum, Base and native XRPL; no signing,
broadcasting, bridge execution or MCP revision migration. Source requirements are
preserved in `docs/flashloan-mcp.md`; this document records the resolved scope.

## Components and data flow

```text
authenticated tools/call -> full native Zod schema -> gateway metering
 -> authenticated worker HTTP -> owned PostgreSQL queue
 -> discovery -> pinned Multicall snapshot -> bounded sizing
 -> exact compiled executor transaction -> Rust fork + reference eth_call
 -> strict harness output check -> atomic artifact/job publication
 -> explicit evidence proposal -> validate -> commit -> query -> hydrate
```

`services/flashloan/server.ts` binds loopback. It accepts no client RPC URL,
filesystem path, owner override inside tool input, shell command or signing key.
Gateway derives the owner from its authenticated session. Worker transport requires
a timing-safe checked bearer token, minimum 32 characters. Remote worker transport
requires HTTPS. Worker PostgreSQL uses verified TLS on non-loopback endpoints and
does not inherit the legacy application's Supabase TLS relaxation.

Run only one worker instance against a queue. Startup marks interrupted running jobs
failed; horizontal recovery coordination is outside this release. Claims use atomic
`FOR UPDATE SKIP LOCKED` updates. Queue admission is transactionally capped at 16
outstanding jobs per owner and 256 globally. Queued jobs expire after 15 minutes.
Requests are bounded to 1 MB; artifacts to 8 MB; heavy jobs to two concurrent runs
and 120 seconds by default. Rust execution is a killable, 45-second subprocess.

## Public input and output

Canonical schemas are in `src/lib/mcp/flashloan/contracts.ts`. Both MCP transports
enforce the complete object, including top-level strictness and nested validators.
No tools are registered unless `FEATURE_MCP_FLASHLOAN=true` and the gateway is on.
Protocol versions remain those supported by the existing installed MCP SDK.

All heavy operations require a caller-selected `idempotency_key`. Reusing a key
with different normalized input fails; a lost response can be retried with the same
key. Retrying failed analysis against refreshed state requires a new key.

Example discovery input:

```json
{
  "idempotency_key": "round-42-discovery",
  "network": "ethereum",
  "tokens": ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"],
  "min_liquidity_usd": 15000,
  "exclude_tokens": []
}
```

The returned job contains `id`, `operation`, `state`, timestamps, and eventually
`result_id` or a typed `error`. States are QUEUED, RUNNING, SUCCEEDED, FAILED and
CANCELLED. A successful job may report NO_OPPORTUNITY, INCONCLUSIVE or REJECTED;
those are research outcomes, not infrastructure success claims about trading.

Poll/read through `flashloan_research_job`:

```json
{"operation":"get","job_id":"<job UUID>"}
```

```json
{"operation":"artifact","artifact_id":"<64-character hash>","offset":0,"limit":100000}
```

Small artifacts include `data`; large artifacts include a JSON `chunk`, `offset`,
`next_offset`, and `total_chars`. Concatenate chunks then parse JSON. Content hashes
use recursively sorted keys and decimal-string quantities. Artifact IDs bind owner,
kind, content and producer version. Artifact access is independently owner-scoped.

| Operation | Additional input | Result artifact |
| --- | --- | --- |
| flashloan_discover_arbitrage_pools | network, token seeds, liquidity floor, exclusions | Indexed candidates and explicit rejections; discovery only |
| flashloan_ingest_l2_tickmap_and_reserves | network, pools with adapter/word range, lender/provider/asset | Canonical block, pool states, tick coverage, runtime lender fee/capacity |
| flashloan_solve_dynamic_route_split | snapshot_id, borrow_asset, risk policy | Feasible plan or a report with search termination/rejections |
| flashloan_simulate_atomic_revm | plan_id, caller, executor, existing/fixture mode | Execution report with code/calldata/state hashes and assumptions |
| xrpl_discover_arbitrage_routes | assets, account-backed or hypothetical funding | Validated-ledger AMMs/books and funding evidence |
| xrpl_simulate_arbitrage_route | route_id, optional unsigned transaction | Bounded cycle estimates or supported native dry-run |
| nim_memory_sync_flashloan_lesson | RETRIEVE/PROPOSE/VALIDATE/COMMIT with query/report/proposal reference | Cited context, source proposal or receipt |

## Snapshot and mathematics contract

EVM quantities are integer decimal strings. All reserves, pool state, token metadata,
bitmaps, initialized ticks and lender data use one canonical block hash. Independent
reads are batched through Multicall3 in groups of at most 128. Registry entries bind
network, address, adapter, ABI version and runtime code hash; unknown deployments
fail explicitly. Pool labels from an indexer are never enough to approve an adapter.

Uniswap V2 preserves fractional input fees until the final output division. CLMM
math uses Q64.96, signed floor compression for negative ticks, direction-sensitive
liquidityNet and protocol rounding. Loaded bitmap boundaries are hard quote limits;
quotes never invent missing liquidity. Call ingestion with a wider word range to
create a fresh, wider immutable snapshot. Stable and dynamic-fee math remains an
estimate until native parity. Algebra v1 compressed TickTable indexing was checked
against its official source; other Algebra ABIs are rejected.

Risk policy requires `max_principal` and `network_cost` in funding-asset units.
It defaults to no forced dollar/weight/deployment floors, at most five active routes,
four hops per route, and a bounded evaluation budget. Optional min_weight_bps and
min_deployment_bps allow the original allocation constraints for comparisons.
Principal is capped by lender capacity. Shared-pool routes update common state in
execution order. The optimizer enumerates bounded subsets, principal scales and
route order; it honestly labels its answer BOUNDED_HEURISTIC and does not prove a
global optimum. Search exhaustion and missing tick coverage remain explicit.

## Simulation evidence and limitations

The locally built ResearchExecutor performs the complete borrow/swap/repay frame.
The compiler derives calldata from the owned plan, not a supplied profit assertion.
Fixture mode injects runtime and owner state only at an empty address and records
the assumption. Existing mode requires the exact reviewed executor runtime.
Uniswap flash lender pools are excluded from swap routes to avoid locked callbacks.

Rust pins state reads, limits RPC read/byte budgets, executes with revm 19.7.0, and
returns success, gas, output and logs. Reference eth_call uses the same transaction
and fixture overrides. RETURN_DATA_PARITY is narrower than full chain-native
verification. Cancun revm does not implement every ArbOS/OP Stack or later Ethereum
rule; `chain_native_verified` and `can_execute` remain false. Costs in the funding
asset are explicitly supplied assumptions; no live USD net-profit guarantee is made.
Production token/adapter parity is not inferred from a successful fixture test.

Native XRPL distinguishes XRP drops from exact issued-currency decimals and issuer
identity. Market reads share a validated ledger hash. Funded book depth, AMM fees,
freeze/authorization conditions and available account evidence are retained. XRP
spendable funds are included only when matching-ledger reserve settings are known.
Native cycle analysis is ESTIMATE_ONLY and excludes unverified issuer/network costs.
Native `simulate` accepts supported unsigned Payment/OfferCreate transactions; it
does not accept the market reader's historical ledger selector. The report retains
the node's actual simulation ledger and never claims atomic multi-transaction loans.

## Knowledge and delivery

Owner-scoped file-backed knowledge is separate from jobs and authorization.
Historical verification-cache results cannot authorize live simulation. Explicit
memory operations do not auto-capture an episode that would invalidate a proposal's
snapshot sequence. The MCP memory interface commits only report-source evidence;
it cannot inject or approve procedures. General inferences remain provisional and
owner approval is required before adopting a procedure or rule.

Job success and artifact visibility publish atomically. Expiry and publication share
a database lock so maintenance cannot unlink a just-republished content hash.
Large artifacts expire after 24 hours, reports and job history after seven days.
Hourly maintenance removes expired artifacts. Worker telemetry records actual
per-operation elapsed time; latency claims must be based on measured workloads.

Verification commands are documented in `services/flashloan/README.md`. Local Anvil
E2E exercises Multicall state -> sizing -> real Rust -> executor repayment, 15% tax
rejection, and same-block-lock rejection without broadcasting. Disposable PostgreSQL
E2E covers duplicate admission, atomic claim, ownership, cancellation and expiry.
Read-only live checks cover three EVM networks plus native XRPL. Live adapter/funding
combinations that were not exercised remain unverified. The repository's lint
command currently prompts for initial ESLint setup and is an existing delivery
limitation, not a passing check.

## Gstack review disposition

Fixed: worker error-code loss, queue admission limits, atomic publication versus
cancellation, artifact TTL refresh, bounded artifact pagination, strict native schema
registration, streamed Rust RPC limits, and tiny XRPL decimal preservation.
Suppressed: suspected Algebra raw-tick indexing; official AlgebraV1 TickTable
explicitly compresses ticks by TICK_SPACING.

Primary references:

- https://docs.dexscreener.com/api/reference
- https://github.com/Uniswap/v3-core/blob/main/contracts/libraries/SwapMath.sol
- https://github.com/cryptoalgebra/AlgebraV1/blob/main/src/core/contracts/libraries/TickTable.sol
- https://github.com/Uniswap/sdks/blob/main/sdks/sdk-core/src/addresses.ts
- https://github.com/bgd-labs/aave-address-book/tree/main/src
- https://xrpl.org/docs/references/http-websocket-apis/public-api-methods/transaction-methods/simulate
