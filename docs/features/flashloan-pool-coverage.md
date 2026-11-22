# Pool inventory correctness and Robinhood/Sui research

## Client outcome

List discovered pools independently of liquidity, quote support or arbitrage eligibility.
A captured AIXBT/Base observation returned 19 token-pairs records (3 above $15,000),
while the batch-token endpoint returned one. The v2 inventory preserves all 19,
including two bytes32 v4 IDs. Counts are observations, not permanent market facts.

## Audience

Public MCP research agents and authenticated private research clients.

## Scope

Three gated milestones: inventory v2; Robinhood mainnet Uniswap v3/v4 research;
Sui mainnet Cetus CLMM/DeepBook v3 native research. Existing XRPL flows remain.
Owner authorized implementation of this plan in the conversation on 2026-10-26.

## Non-goals

Signing, broadcasting, deployment, cross-chain atomic execution, exhaustive chain
indexing, arbitrary v4 hooks, and automatic approval of deployment registries or
memory procedures. Native probes never establish a profitable live opportunity.

## Alternatives considered

Lowering liquidity alone cannot repair incomplete enumeration. Batch-token lookup
returns selected markets. Rejecting unsupported venues hides useful inventory.
Applying EVM addresses/math to Sui conflates Move objects, coin types and Q64.64.
A persistent index would expand this public stateless service's operations scope.

## Selected approach and why

Keep the current tool names and replace discovery output with flashloan.inventory.v2.
Public schema is flashloan.public.v2; proof version/key/domain is v2. Old envelopes
fail explicitly. Gateway/worker version headers detect mixed releases. Native Sui
uses the official SDK through an isolated Node 22.12+ host adapter. Native PTBs
perform Cetus Q64.64 and DeepBook depth/lot/fee arithmetic directly in reviewed Move
packages rather than duplicating those models in TypeScript.

```text
MCP -> strict chain-aware schema -> shared admission/engine
  -> token-pairs + configured paginated native protocol sources
  -> typed pool inventory + per-token eligibility + coverage
  -> reviewed canonical EVM block / checkpoint-scoped Move objects
  -> connected routes + available borrow/repay path
  -> bounded integer EVM sizing / bounded native PTB search
  -> unsigned native/reference simulation -> verified report
```

Discovery is independent of research enablement. Robinhood/Sui research requires
current evidence bound to deployment configuration, runtime, implementation,
executor artifacts and Rust engine fingerprint. Observed code hashes in tests are
not automatically approved production registry records.

### Inputs and output

Public discovery (private input additionally requires idempotency_key):

```json
{"network":"base","tokens":["0x4F9Fd6Be4a90f2620860d680c0d4d5Fb53d1A825"],"min_liquidity_usd":15000,"exclude_tokens":[]}
```

Output data is `{schema_version,network,observed_at,outcome,pools,token_results,
coverage,diagnostics,warnings}`. Outcome is SUCCESS, EMPTY or PARTIAL. Each token
has pool_ids, discovered_count, liquidity_eligible_count, disposition and
route_status=NOT_EVALUATED. Excluded tokens have zero counts. Two markets do not
establish a closed route, especially when quote assets differ.

Pool references distinguish evm_contract, evm_v4 (verified manager plus PoolKey),
sui_object and provider_opaque. A provider bytes32 ID alone does not establish its
manager/key. Asset IDs are EVM addresses or normalized case-preserving Move tags;
symbols are never identities. Amounts/versions are integer strings. USD metadata
is nullable and approximate; missing liquidity is not zero. Provenance names actual
source/token/pool and observation time. Capabilities remain unverified until native
state and deployment checks run. See canonical schemas for full field contracts.

Coverage separates request completion from exhaustiveness. DexScreener has no
assumed pagination or all-chain guarantee. Sui native inventory accepts optional
native_cursors keyed by CETUS_CLMM/DEEPBOOK_V3, native_page_size (1..100, default 50)
and native_max_pages (1..5, default 2). Resume using each coverage.next_cursor.
Short/empty pages with hasNextPage continue; budget exhaustion is PARTIAL.
Provider failures are diagnostics; total source failure is DISCOVERY_UNAVAILABLE.

Robinhood is chain ID 4663. v4 input uses address=bytes32 pool ID, manager and
pool_key={currency0,currency1,fee,tickSpacing,hooks}. Hash/key, manager/StateView
runtime, ticks and fees are verified at one block. Robinhood v3 pool/lender registry
entries require factory and factory_code_hash, and membership is checked through
factory(), runtime attestation and getPool(token0,token1,fee). Only fixed-fee no-hook v4 pools
are supported. Native-currency cycles require a reviewed WRAPPED_NATIVE entry;
the snapshot adds separate directed wrap/unwrap edges. V3 lenders cannot also be
swapped during their callback. RPC network-cost estimates remain distinct from
policy.network_cost, which is denominated in funding-asset units.

Sui adds sui_ingest_pool_state, sui_solve_arbitrage_routes and sui_simulate_ptb.
Public data travels in sui_snapshot/sui_plan proofs. Private artifacts remain
owner-scoped. Checkpoint objects contain BCS bytes, type, version, digest, shared
initial version and reviewed package identity. funding_fee is explicitly a
current-native view or protocol-version observation, not checkpoint-derived data.
Current configuration is re-attested around simulation and actual native config
inputs are checked. Unknown configuration inputs cannot produce a feasible result.

Sui simulation reports historical_execution_verified=false, native input versions,
configuration evidence, state alignment, mocked gas, residual assets and repayment.
Funding-asset book leftovers merge before repayment/profit; other residuals are
reported without invented valuations. Native search probes capacity per candidate;
capacity=null is not a fabricated zero or unlimited lending balance. Rejected
borrows/depth failures make bounded search INCONCLUSIVE rather than proving that
no opportunity exists. Public native search permits at most eight evaluations
(default four) and uses the existing 60-second simulation deadline.

## Risks

Provider inventories can omit markets. GraphQL cursors expire. State can change
between historical discovery and native dry-run. Public gas may be mocked. Generic
Cancun execution is not full Robinhood chain-native verification. Reviewed packages
can become obsolete. Byte/deadline/quota limits can interrupt enumeration/search.
All such limitations stay explicit; no report enables execution.

## Acceptance criteria

Captured AIXBT 1-versus-19 regression, all pool identities/eligibility retained;
SDK/raw schema parity and ten public tools; public statelessness/private ownership;
v4 key/hash/hook checks, directional wrapping and callback/settlement/repayment;
Sui SDK PTB construction, native residual conservation, configuration attestation,
checkpoint/current-state separation, fees/depth/lot handling and receipt consumption.
Run full Vitest, typecheck, production/worker build, Foundry, Move fixture tests,
Anvil/Rust native E2E and explicitly enabled live multichain checks. Live native
quote parity, unsigned funding and a genuine losing route rejection are separate
proofs from deterministic profitable fixtures. Do not issue release evidence for
an adapter combination whose required native checks did not run.

## Rollout and rollback

Build gateway/worker together and regenerate verification evidence on the actual
release after builds finish. New chain research defaults disabled; discovery is
available independently. Configure reviewed deployments and native endpoints,
then enable only registry/build-bound capabilities whose acceptance checks pass.
Do not rewrite current production configuration in this task. Roll back both
binaries/schema together; v1/v2 proofs are intentionally incompatible.

## Environment contract

services/flashloan/environment-contract.json and services/flashloan/.env.example
remain secret-free. Add FLASHLOAN_ROBINHOOD_RPC_URL, FLASHLOAN_SUI_GRAPHQL_URL,
FLASHLOAN_SUI_GRPC_URL, FLASHLOAN_SUI_CHAIN_IDENTIFIER, FLASHLOAN_SUI_DEPLOYMENTS and
FLASHLOAN_RESEARCH_EVIDENCE. No private keys are needed. TLS verifies hostnames;
redirects and oversized responses fail. Public requests never write repository or
knowledge data. The optional native SDK requires Node 22.12+; Move CLI is test-only.

## Post-delivery evidence

Local .nim evidence records exact commands, exit statuses, native observation
identities and implementation fingerprints. Record local acceptance separately from
production rollout. No signing/broadcasting or registry/procedure approval occurs.
Use flashloan-pool-coverage-map.md for five executable boundary proofs. Keep memory
inferences provisional; owner approval is required before procedural reuse.

## GSTACK REVIEW REPORT

Specialist review found and fixed funding-residual loss, 20+1 snapshot overflow,
excluded quote-token counts, unsupported runtime advertising, implementation/Rust
fingerprint gaps, and current-versus-historical configuration attestation. Native
v3/v4 quote parity and Sui funding/composed-route rejection were independently checked
against live nodes. This report does not claim production deployment or profitable
live arbitrage. Existing lint setup remains outside this feature.
