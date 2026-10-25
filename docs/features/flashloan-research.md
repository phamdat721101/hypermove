# Flashloan research and simulation

## Client outcome

Authenticated agents discover and evaluate arbitrage on Ethereum, Arbitrum, Base,
and native XRPL through Hypermove's existing MCP gateway. Results distinguish
mathematical estimates, native dry-runs, and verified EVM execution. This feature
does not sign or submit transactions.

## Audience

Research agents and developers inspecting reproducible market-state evidence.

## Scope

Existing gateway integration; opt-in authenticated worker; owned durable jobs and
artifacts; official DexScreener discovery; pinned EVM/XRPL snapshots; integer pool
math; bounded risk-based sizing; local EVM and unsigned XRPL simulation; cited memory.

## Non-goals

Signing, broadcasting, production executor deployment, bridge execution, XRPL EVM
Sidechain, or an MCP protocol-revision migration.

## Alternatives considered

A standalone MCP duplicates authentication and metering. Running Rust within
Next.js couples native process failures and long jobs to HTTP requests. SQL-backed
nim knowledge contradicts the installed file-backed knowledge contract.

## Selected approach and why

Reuse ToolDef and gateway.callTool. A separate worker owns network operations,
PostgreSQL jobs, content-addressed artifacts, and a bounded Rust subprocess.
Canonical Zod input contracts are enforced at both transport and dispatch boundaries.
Unknown state and unsupported protocol versions produce typed failures rather than
fabricated liquidity, fees, or passing simulations.

## Risks

RPC archive/capability availability, reorgs, protocol version differences, incomplete
tick coverage, token restrictions, and L2-specific execution semantics. A local EVM
execution is not chain-verified until a matching reference-node parity check passes.
XRPL simulate does not accept the market snapshot's historical ledger selector.

## Acceptance criteria

- Disabled behavior preserves existing tools and performs no worker requests.
- Jobs/artifacts are owner-scoped, idempotent, bounded, cancellable and restart-aware.
- Exact integer quotes and sequential shared-pool evaluation drive allocations.
- Simulations retain code/calldata/state hashes and all injected assumptions.
- Memory facts require immutable citations; inferred procedures remain unapproved.
- Local E2E and live read-only checks cover all four networks; skipped live checks
  cannot count as completed delivery.

## Rollout and rollback

Build/test worker and Rust binary, configure secret placeholders, run live read-only
checks, then enable FEATURE_MCP_FLASHLOAN. Roll back by disabling the flag and
stopping the worker; preserve artifacts and knowledge. No signing key is needed.

## Environment contract

See services/flashloan/environment-contract.json. Internal HTTP binds loopback;
public RPC endpoints require verified HTTPS. Credentials are configuration only,
never tool arguments, result payloads, or knowledge sources.

## Post-delivery evidence

Record test, typecheck, lint, build, Rust, E2E, and live verification outcomes with
commit identity and actual runtime versions. An unavailable endpoint is an incomplete
network gate, not proof that its chain is supported. Record delivery status honestly.
