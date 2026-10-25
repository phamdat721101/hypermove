# Flashloan research worker

Research only: no private key, wallet signer, broadcasting endpoint, or execution tool.
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

Deployment verified on 2026-10-25:

- Public MCP: `https://mcp.overguild.com` (also `/api/mcp`).
- Gateway health: `https://mcp.overguild.com/api/mcp/health`.
- LLM API: `https://mcp.overguild.com/llm`; the existing identical service was retained.
- Active gateway/worker release: `/home/ubuntu/hypermove-flashloan-release`, managed
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
