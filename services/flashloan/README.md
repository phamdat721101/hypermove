# Flashloan research worker

Research only: no private key, wallet signer, broadcasting endpoint, or execution tool.

## Authenticated XRPL LoanPay tools

Set `FEATURE_MCP_FINANCE_V1=true` and `FINANCE_XRPL_LOAN_PAY_V1=true` on the
gateway and worker. Optionally set the worker's `FINANCE_XRPL_RPC_URL` to a
devnet RPC for Finance positions and LoanPay calls. The public XRPL RPC retains
its existing configuration. Check the `xrplLoanPay:<environment>:<state>`
warning from `finance_get_capabilities_v1` before requesting a preview.

1. Call `finance_get_positions_v1` on XRPL. Pass the selected loan's
   `positionId`, `observation.point.index` converted to a JSON integer, and
   `observation.point.hash` as the preview's `position`.
2. Call `finance_preview_xrpl_loan_pay_v1` with
   `schemaVersion: "finance.xrpl-loan-pay.request/1"`, a `requestId`,
   `environment`, `borrower`, `loanId`, one `mode` and `maxAmount` in native
   XRPL format. XRP uses drops, issued currency includes its issuer, and MPT
   amounts use the issuance ID and integer units.
3. A successful preview returns an unsigned template. The wallet must obtain
   current transaction parameters and user authorization. After settlement,
   call `finance_verify_xrpl_loan_pay_v1` with the same repayment terms and
   `txHash` in place of `position`. Loan field changes come from transaction
   metadata. A null final value means the metadata omitted that field. The
   transaction amount is a cap and the network fee is expressed in XRP drops.

## Current VPS runtime — 2026-10-29

Gateway and worker release `worktree-candidate-670385d78efb` is deployed from
`/home/ubuntu/hypermove-public-release`. `FLASHLOAN_CANDIDATE_RESEARCH_V1=true`
is configured on both services. Both public HTTPS MCP paths expose twelve tools,
including `flashloan_research_candidates_v1`; existing public v3 operations remain.
Credentials stay server-side; private `/api/mcp` still requires authentication.

The isolated Linux candidate passed 65 focused tests (one skipped), one enabled
unsigned Anvil/Rust E2E, worker compilation, Linux engine/contract builds and
production Next build. All 380 transferred source fingerprints matched before
cutover. SDK probes from the VPS and development host verified the root and
canonical endpoint, normal TLS, malformed-input rejection and a live Base
snapshot/candidate request. Missing policy/cost evidence produced INPUT_BLOCKED
with one accounted candidate and no qualified plan; this is not profitable-trade
or execution evidence. PM2 state was saved. The rollback release is
`/home/ubuntu/hypermove-public-backup-20261029-candidates`.

Caddy already had the correct routing and was left unchanged. The existing
stopped LLM service and disabled Dream Cycle configuration were preserved.
The supplied-snapshot research scope and remaining broader upgrade items are
described in `docs/flashloan-prompt-engine-mcp-upgrade-spec-2026-10-29.md` §15.
Secret-free acceptance artifacts are local `.nim/vps-candidate-*` files.

## Prior VPS runtime — 2026-10-28

The gateway and worker run from `/home/ubuntu/hypermove-public-release` on
Node 22.15.0. Release `worktree-movers-5c3499ba3e74` was verified through real
HTTPS MCP clients from both the VPS and the development host. The public catalog
has eleven tools and the `flashloan.public.v3` contract, including
`flashloan_get_token_movers` for Base, Arbitrum, Robinhood and Sui. Dream Cycle and LLM-dependent MCP tools are
disabled; `llm-service` is stopped and `/llm/*` returns HTTP 410. UI scan and
content generation are unavailable on this VPS. The UI MCP URL remains
`NEXT_PUBLIC_MCP_HOST_URL=https://mcp.overguild.com`.

The immediate rollback release is `/home/ubuntu/hypermove-public-backup-20261028-movers`.
The older `/home/ubuntu/hypermove-public-backup-20261026` is also retained.
The active release contains `.env.before-flashloan-focus-20261026`, and the
previous Caddy configuration is `/home/ubuntu/Caddyfile.before-flashloan-focus-20261026`.
These are server-only rollback files; preserve their credentials and permissions.
The candidate passed 64 focused Linux tests (one opt-in live case skipped), plus
the Anvil/Rust native E2E. Live production API checks were run separately.
All 37 runtime source fingerprints matched before and after cutover. A public
SDK mover scan returned four Robinhood movers and explicit EMPTY results for
the other chains; one returned token composed with discovery into three pools.
These are time-scoped observations, not guaranteed token counts or exhaustive
chain rankings. Server-side credentials and the external worker data directory
were preserved, and PM2 state was saved.
Use `--app-only --with-flashloan` with the deploy script to keep LLM stopped.

## Public stateless profile

`https://mcp.overguild.com/api/mcp/flashloan` (also the root without credential
headers) exposes the registered public research tools. Agents provide no
credentials or session IDs. Public inputs use inline snapshots/plans/routes, not
owned artifact IDs or idempotency keys. No public repositories or research-memory
writes occur. The authenticated `/api/mcp` catalog retains its job/memory API.

Enable `FEATURE_MCP_FLASHLOAN_PUBLIC_STATELESS=true` in both gateway and worker
environment files. Add a separate server-only random `FLASHLOAN_PUBLIC_ARTIFACT_KEY`
of at least 32 bytes to the worker environment. The public key name refers to the
public profile: its value is a secret signing key, never shared with agents.
Rotating it invalidates outstanding envelopes. Keep worker transport credentials
separate. The feature remains disabled by default.

Use `bash scripts/start-standalone.sh` for the production gateway. It binds port
3003 to loopback. Caddy must overwrite `X-Flashloan-Client-IP` with its remote
client address before enabling `FLASHLOAN_TRUST_PROXY=true`. Configure allowed
Host/Origin values explicitly for other domains. Missing trusted address metadata
fails closed. Agents without Origin headers are supported.

`Caddyfile.example` records the verified public root/private credential routing
and the client-IP overwrite. Review hostnames and preserve other site blocks
before installing it. Validate with `caddy validate --adapter caddyfile --config
<path>`; temporary filenames do not necessarily select the Caddyfile adapter.

CPU searches use the compiled `compute-thread.js`, included in `flashloan:build`.
Each public computation shares the worker's admission controller with private
jobs; only one public/two total computations may run concurrently. Quota, byte,
coverage and deadline limits are advertised by capabilities. No public queue or
pagination is offered; reduce input coverage if a result exceeds the wire budget.
Cancellation stops threads/native children and releases capacity. Search remains
bounded and reports incomplete coverage/outcomes explicitly.

Public envelopes have a ten-minute maximum life, bound to canonical content and
the reviewed registry, public version and effective limits. Pass the entire
envelope unchanged into follow-up calls; it is data provenance, not identity or
private ownership. EVM follow-up calls verify canonical block identity. No public
request may supply a transport token, RPC URL, executable path or storage owner.

Run `pnpm flashloan:public-e2e` and `pnpm flashloan:native-e2e`. The latter verifies
both public inline and private job workflows against Anvil and the actual Rust
engine, including repayment/tax/cooldown cases. See the root README and
`docs/features/flashloan-public-stateless.md` for exact contracts.

### RLUSD developer checks

The public MCP catalog includes `flashloan_rlusd_devtools_v1`. It uses the
existing gateway, worker and public request limits. Start with a catalog check:

```json
{
  "name": "flashloan_rlusd_devtools_v1",
  "arguments": { "request": { "action": "check_providers" } }
}
```

| Action | Request fields | Evidence returned |
| --- | --- | --- |
| `check_providers` | `action` | Relay’s issuer/contract coverage and Squid integrator-ID requirement, with `route_ready: false`. |
| `quote_spot` | `network` (`base` or `ethereum`), `amount_in_raw` (18-decimal RLUSD units as a string) | Same-chain official RLUSD-to-USDC quote at a checked block, before gas. |
| `verify_xrpl_payment` | `tx_hash`, `payer`, `recipient`, exact decimal `amount`, and `destination_tag` when present | Validated XRP Ledger payment metadata, including actual delivered amount and the official issuer. |
| `verify_evm_transfer` | `network`, `asset` (`rlusd` or `usdc`), `tx_hash`, `sender`, `recipient`, `amount_raw`, `log_index` | Exact official ERC-20 transfer with canonical block evidence and `verified` or `pending_finality`. |

The worker uses its configured `FLASHLOAN_XRPL_RPC_URL`,
`FLASHLOAN_BASE_RPC_URL`, and `FLASHLOAN_ETHEREUM_RPC_URL` for those chains.
The quote and receipt responses attest only to their stated scope. The tool
returns no signed transfer, order binding or executable cross-chain quote.

Run the focused tests from the HyperMove repository:

```sh
pnpm exec vitest run tests/flashloan-rlusd-devtools.test.ts tests/flashloan-public.test.ts
FLASHLOAN_RLUSD_LIVE=1 pnpm exec vitest run tests/flashloan-rlusd-devtools.test.ts
```

The second command replays existing public transactions and makes read-only
same-chain quotes through public RPCs.

## Authenticated job profile
The worker requires Node 20.19+ (or 22.12+) for CommonJS-to-ESM dependency loading,
Rust/Cargo, and Foundry. The main gateway retains its existing Node requirement.

Build from the repository root:

```sh
pnpm flashloan:build
```

Configure `services/flashloan/.env` from its example. Supply PostgreSQL, a random
worker token of at least 32 characters, HTTPS RPC endpoints, and a reviewed
deployment registry. Registry entries look like:

```json
{"network":"ethereum","address":"0x...","adapter":"UNISWAP_V3","code_hash":"0x...","version":"uniswap-v3"}
```

Discover runtime hashes from a trusted deployment source and verify them before
configuration. There is deliberately no inferred fee or unreviewed pool fallback.
Algebra supports its reviewed v1 ABI only. Aerodrome stable math remains an estimate
until native execution parity succeeds. A bounded tick map is not the entire pool.

Run `bash services/flashloan/start.sh`. Configure the gateway with:

```sh
FEATURE_MCP_FLASHLOAN=true
FLASHLOAN_WORKER_URL=http://127.0.0.1:3012
FLASHLOAN_WORKER_TOKEN=<same worker token>
```

Deploy one worker instance against its PostgreSQL queue. Startup explicitly fails
interrupted RUNNING jobs; horizontal worker startup recovery requires a dedicated
lease coordinator and is not supported. QUEUED jobs survive restarts. Poll the
`flashloan_research_job` tool for completion; its `artifact` operation reads results.
Jobs expire from reads after seven days; large artifacts after 24 hours, reports
after seven days. Startup and hourly maintenance remove expired rows and files.
Queue limits are 16 outstanding jobs per owner and 256 globally; queued jobs expire
after 15 minutes. Artifact retrieval supports bounded JSON chunks through `offset`
and `limit` (maximum 100,000 characters).

Build native binaries on the deployment platform (Linux amd64/arm64 or macOS x64/arm64).
Do not copy a macOS executable onto the VPS. The worker uses a bounded subprocess,
not a native addon. The existing Next.js build does not require Rust when disabled.

Simulation reports retain injected fixture state, calldata/code hashes, engine
version, reference-node return-data parity and explicit cost assumptions. Generic
Cancun revm execution is not complete ArbOS/OP Stack or later Ethereum hardfork
verification. `chain_native_verified` remains false; no tool presents these reports
as authority to send a transaction. Native XRPL dry-runs use the node's simulation
ledger, which is distinct from the validated market snapshot.

Verification:

```sh
pnpm flashloan:test
pnpm flashloan:e2e
pnpm flashloan:native-e2e
pnpm flashloan:postgres-e2e
pnpm flashloan:live
```

The live command must report all four networks. Missing endpoints/capabilities are
incomplete delivery gates, never silently substituted with mocked results.

Historical deployment verified on 2026-10-25 (superseded by the runtime above):

- Public MCP: `https://mcp.overguild.com` (also `/api/mcp`).
- Gateway health: `https://mcp.overguild.com/api/mcp/health`.
- LLM API: `https://mcp.overguild.com/llm`; the existing identical service was retained.
- Original gateway/worker release: `/home/ubuntu/hypermove-flashloan-release`, managed
  by PM2 as `hypermove-app` and `flashloan-worker`. Worker port 3012 binds loopback.
- Dedicated local PostgreSQL stores research jobs/artifacts. The existing app's
  Supabase connection rejects its tenant/user; its configuration was preserved.
  Normal wallet/device token persistence still requires repairing that existing
  database connection. Public verification used the server-held admin credential.
- Nine runtime-attested Uniswap V3/Aave entries cover Ethereum, Arbitrum and Base.
  Native XRPL is separately configured. Other deployments remain unsupported
  until explicitly reviewed and registered.
- Public discovery, pinned Base snapshots, sizing and artifact retrieval passed.
  The sampled market returned `INCONCLUSIVE`; no feasible live trade or profit
  was asserted. Signing and broadcasting remain unavailable.
- The actual Linux release binary passed local Anvil repayment, transfer-tax
  rejection and same-block cooldown rejection E2E checks on the VPS.

The old app directory and Caddy configuration backup remain available for rollback.
Server-only deployment evidence is in `services/flashloan/deployment-evidence.json`
and `services/flashloan/deployment-verification.json` within the active release.
UI `.env.local` uses `NEXT_PUBLIC_MCP_HOST_URL=https://mcp.overguild.com` and
`NEXT_PUBLIC_LLM_API_URL=https://mcp.overguild.com/llm`. Never put worker/admin
credentials in public UI variables. For remote PostgreSQL with a private CA,
configure `NODE_EXTRA_CA_CERTS` from the database provider's verified certificate;
keep certificate and hostname verification enabled.

## Pool coverage v2 / Robinhood / Sui

See [the coverage contract](../../docs/features/flashloan-pool-coverage.md).
Discovery now lists inventory independently of eligibility. Public proof/schema
version is v3 and the catalog contains eleven tools, including public-only
`flashloan_get_token_movers` for bounded Base/Arbitrum/Robinhood/Sui ranking.
See the public feature specification for inputs, coverage and live tests.
Sui SDK support is isolated in
the worker and requires Node 22.12+. Optional chain endpoints and registry/evidence
bindings are documented in `.env.example`. Native Sui uses current-state PTB
simulation with checkpoint provenance, explicit mocked-gas reporting, and no
signing. Research is unavailable until the exact release's registry and build
fingerprints have current required verification evidence. Do not auto-promote
`live-observed-not-approved` fixtures into production registry entries.

`pnpm flashloan:multichain-test` runs deterministic adapter/coverage tests;
`pnpm flashloan:move-test` runs the pinned test-only Move fixture;
`pnpm flashloan:multichain-live` runs read-only native node checks. The Move fixture
is never deployed or imported by production code. Retain existing native Rust,
Foundry, public/private and PostgreSQL verification commands.

## Optional discovery v8

Inventory v3, movers v2, registry and watchlist tools are default-off additions to the stateless catalog. See [the feature contract](../../docs/features/flashloan-mcp-v8.md) for flags, registry configuration, inputs/outputs, coverage semantics and native E2E commands. Public requests never write knowledge, size execution, sign or send.
