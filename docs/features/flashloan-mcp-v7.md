# Flashloan MCP v7 integration

## Client outcome

Discover targets, resolve opaque v4 IDs to reviewed canonical identities, and obtain unsigned amount-aware research without constructing a caller snapshot. Return complete target dispositions and exact dependencies when resolution, funding, costs, or coverage are missing. Public research never signs or submits transactions.

## Design rationale

Extend the existing stateless transport, reviewed registry, block-pinned reader, solver, isolated compute and integrity envelopes. JSON Schema owns the new contracts; generated Zod request adapters satisfy the MCP SDK and strict Ajv validates responses. No wallet, scheduler, persistent research service or new database is introduced. The pinned Ajv packages already existed transitively and are now direct dependencies.

The authoritative runtime contract is `src/lib/mcp/flashloan/integration.schema.json`, extracted from the v7 remediation specification with twelve strict-type annotations and explicit resolution failure codes. The local-runtime owner must consume these identical revised bytes before full integration release. Historical schema parity is not current acceptance evidence.

## Audience

MCP hosts, research clients and the independently maintained local flashloan adapter.

## Scope

All eight MCP packages and actual SDK/HTTP/native interoperability proofs. The approved scope is MCP plus interoperability.

## Non-goals

Local signer/runtime changes, executor deployment, live trades, risk-policy changes, x402 changes and new operating-procedure approval.

## Alternatives considered

Hand-maintained Zod/JSON Schema copies risk drift. A second ingestion service duplicates existing trust and budget boundaries. Unbounded historical scans exceed public request limits. These alternatives were rejected during review.

## Selected approach and why

Use one shared wire schema, reviewed server lender/manager selection, cached/indexed initialization locators with bounded scan fallback, and existing isolated compute. Positive acceptance by the real local v4 adapter gates full release.

## Risks

Archive gaps, reorgs, missing reviewed mappings, unsupported currency/hooks, small connected-graph budgets and externally incompatible clients remain explicit blockers. Discovery coverage and sampled search never imply global completeness or execution admission.

## Acceptance criteria

M-E01 through M-E12 in the source specification remain the acceptance matrix. Deterministic/HTTP/native fixture evidence and release-blocking external/live evidence are reported separately; no unavailable lane silently passes.

## Rollout and rollback

Keep both flags false until client/schema parity and live/fork checks pass. Deploy paired gateway/worker builds with matching schema digests and integrity registries. Disable the flags to withdraw the new operations; refresh snapshots after registry changes.

## Post-delivery evidence

Local verification logs and structured reports live under `.nim/v7-*` and are not production attestations. The System Map stays Implementing while positive external client and live/fork evidence are pending.

## Implementation

| Package | Behavior |
| --- | --- |
| MCP-01 | Add resolver v1 and candidate v2; preserve old inventory/proof/tool contracts |
| MCP-02 | Server-reviewed managers, canonical Initialize logs, code/StateView pins, currency metadata, cached/indexed locators, bounded historical scans, final canonicality recheck |
| MCP-03 | Explicit/mover target union, funding-anchor connectors before extra pools, reviewed lender selection, automatic block-pinned ingestion |
| MCP-04 | Strict versioned schema and generated SDK request adapters; unchanged snapshot/plan envelopes |
| MCP-05 | Unique complete candidate ledger, exact terminal counts, target-route evidence, explicit budget dispositions |
| MCP-06 | Shared request counters/deadline, coarse search plus conserved allocation refinement, strict net threshold, independent plan replay |
| MCP-07 | Separate read/quote/research capabilities, opt-in flags, code/schema fingerprint binding, existing proof expiry and registry migration |
| MCP-08 | Bounded provider reads/retries, cancellation and lease cleanup, duplicate-key/Unicode rejection, full MCP wire-size accounting, secret-free metrics |

## Input and output

`flashloan_resolve_pool_inventory_v1`: `pool-resolution-request/1` → `pool-resolution-report/1`. Obtain the server mapping reference from `flashloan_capabilities.integration.manager_mappings`; never provide arbitrary manager addresses or RPC URLs. Supply at most 64 references; only the advertised effective pool/RPC/time budget can be resolved. Unresolved references remain in the report.

`flashloan_research_candidates_v2`: `flash-candidate-request/2` → `flash-candidate-research/2`. All fields are required; `snapshot`, `costEvidence`, `profileResearchPolicy`, and `managerMappingRef` may be null. A funding anchor remains explicit. A cost's state digest is the existing snapshot content hash with `sha256:` prefix; block, parent, chain and repayment asset must also match.

With a null snapshot and costs, the service discovers/resolves/ingests what it can and returns the snapshot plus a cost/policy dependency. Submit a second bounded research request with costs bound to that exact state, or supply the returned snapshot unchanged. Caller costs are modeling assumptions, not approved execution policy.

Ranking describes total plan economics for a plan containing the target. `planHash` references a returned `evm_plan` envelope. No ranking is produced without matching fresh costs. Plan expiry cannot exceed snapshot, cost, valuation, fee-reference, or server validity. Partial coverage retains valid modeled rankings under `INCONCLUSIVE`. Completing only part of a grid never proves a negative result.

## Environment contract

Reuse `services/flashloan/environment-contract.json`. Added optional variables:

- `FLASHLOAN_POOL_RESOLUTION_V1=false`
- `FLASHLOAN_CANDIDATE_RESEARCH_V2=false`
- `FLASHLOAN_INITIALIZATION_LOCATORS=[]`: at most 128 server-owned `{network,manager,poolId,blockHash}` locators; canonical logs are reread before use.

Reviewed v4 deployment entries may include decimal-string `initialization_block`. Without an indexed/cached locator or scan start, resolution returns `ARCHIVE_UNAVAILABLE`. A scan reads at most five pages of 2,000 blocks from that start and charges every attempt to the same round; there is no unbounded fallback.

Ceilings remain 30 discovery tokens, four pools, three routes, 500 total evaluations including exported-plan replay, five seconds of compute, and 30 seconds per operation. The new composition additionally caps upstream attempts at 100; caller limits can lower these ceilings. Legacy operations retain their established contracts. Deployment code/schema changes rotate integrity registries: clients must re-ingest rather than edit old proofs.

## Verification

Run `pnpm flashloan:v7-test`, `pnpm typecheck`, `pnpm test`, `pnpm lint`, and `pnpm build`. The v7 suite includes actual SDK → HTTP gateway → authenticated worker → automatic ingestion → isolated compute with deterministic upstream fixtures. No public network or signing is required.

Run the native lane with `FLASHLOAN_NATIVE=1 FLASHLOAN_ENGINE=services/flashloan/target/release/flashloan-engine pnpm exec vitest run tests/flashloan-native-e2e.test.ts`. This exercises v2 plans through the existing Anvil/Rust unsigned simulation and proves repayment without broadcasting. Fixture success does not establish production admission.

Set `FLASHLOAN_LOCAL_SKILL_ROOT` to the separately built local repository when running the v7 suite to invoke its actual parser with exact report bytes. The current check proves legacy acceptance and explicit v7 rejection; it is a compatibility blocker, not positive acceptance. Positive SK-01/SK-02 adapter acceptance, revised schema parity, pinned live/fork v4 resolution, and the local policy/simulation report remain required for full release. No live success is inferred from deterministic fixtures.

## Delivery status

Implementation is opt-in and full integration delivery remains **Implementing** until the external client and live/fork evidence gates pass. Keep both flags off in deployment. No deployment, contract change, risk expansion, or new procedure approval is included.

```json nim-deliver
{
  "featureId": "flashloan-mcp-v7-integration",
  "taskType": "feature",
  "status": "Implementing",
  "input": {"entrypoint": "Public resolver v1 and candidate research v2", "payload": "flashloan-integration/1 version-negotiated unsigned research"},
  "processing": {"apiHops": ["SDK -> gateway -> protected worker -> resolver/ingestion -> isolated compute"], "datastores": ["Bounded immutable event-locator cache; no caller persistence"], "services": ["Existing Next gateway, research worker and native engine"]},
  "output": {"state": "Opt-in MCP implementation; external positive v4 client acceptance and live/fork verification pending", "transitions": ["discovered -> resolved -> snapshot -> evaluated", "missing dependency -> explicit blocked/incomplete ledger", "local client incompatible -> release blocked"]},
  "seams": [
    {"id": "identity", "description": "Canonical manager, PoolKey, provenance and reorg handling"},
    {"id": "budget", "description": "Shared counters, deadlines, cancellation and lease recovery"},
    {"id": "economics", "description": "Strict thresholds, cost/state binding and integer replay"},
    {"id": "trust", "description": "Schema, proof, feature flags and hostile-input handling"},
    {"id": "client", "description": "Actual MCP SDK/worker/native seams; external positive client acceptance pending"}
  ],
  "edgeProofs": [
    {"edgeId": "EDGE-01", "seamId": "identity", "command": "pnpm exec vitest run tests/flashloan-v7.test.ts -t 'v7 identity seam'", "logMarker": "EDGE-01", "sourceFiles": ["tests/flashloan-v7.test.ts"]},
    {"edgeId": "EDGE-02", "seamId": "budget", "command": "pnpm exec vitest run tests/flashloan-v7.test.ts -t 'v7 economic and budget seams'", "logMarker": "EDGE-02", "sourceFiles": ["tests/flashloan-v7.test.ts"]},
    {"edgeId": "EDGE-03", "seamId": "economics", "command": "pnpm exec vitest run tests/flashloan-v7.test.ts -t 'v7 economic and budget seams'", "logMarker": "EDGE-03", "sourceFiles": ["tests/flashloan-v7.test.ts"]},
    {"edgeId": "EDGE-04", "seamId": "trust", "command": "pnpm exec vitest run tests/flashloan-v7.test.ts -t 'rejects unknown fields'", "logMarker": "EDGE-04", "sourceFiles": ["tests/flashloan-v7.test.ts"]},
    {"edgeId": "EDGE-05", "seamId": "client", "command": "pnpm exec vitest run tests/flashloan-v7.test.ts -t 'actual MCP SDK generated request adapter'", "logMarker": "EDGE-05", "sourceFiles": ["tests/flashloan-v7.test.ts"]}
  ]
}
```
