# services/tee-extension — HyperMove's Flare Compute Extension (TEE-Proxy)

This directory holds HyperMove's Flare Compute Extension (FCE): a Solidity
`InstructionSender` contract plus a Go `ext-proxy` (TEE Proxy) + `extension-tee` (TEE
Machine) pair. It implements the architecture described in
`biz-team/bd-team/research/hypermove/2026-07-20-tee-proxy-fcc-extension-token-profile/`
(Sub-PRD A). It is a fully isolated Go service — it does not import from, or get imported
by, `hypermove-app`'s Next.js/TypeScript code. The only integration point with the main app
is `flare.instruct.dispatch` (Sub-PRD B), an MCP tool that talks to `ext-proxy`'s public
HTTP API over the network, the same way it talks to any other external provider.

## E2E orchestrator script — one command, itemized status report

`scripts/e2e-coston2-flare-xrpl.ts` (TypeScript, `services/tee-extension/scripts/`) is the
single runnable script that wires this Go triad, `flare.instruct.dispatch`'s encoding
conventions, and a real RLUSD/XRPL-testnet settlement leg together, for the first time, into
one command:

```bash
cd scripts && npm install --legacy-peer-deps && npm run e2e:tee-flare-xrpl
```

It runs three segments — Coston2 registration (real), a local `SIMULATED_TEE=true` full-loop
proof (real, simulated-TEE), and a real RLUSD settlement on XRPL testnet via the `n-payment`
SDK — and prints one itemized, honest report (real / simulated / blocked, never fabricated).
Requires `services/tee-extension/scripts/.env.coston2` (gitignored) for
`DEPLOYMENT_PRIVATE_KEY` and `XRPL_SEED` — **never supply these via chat**, only via that
local file. Full spec + design record:
`biz-team/bd-team/research/hypermove/2026-07-23-tee-proxy-e2e-script-coston2/`.

## Directory layout (matches Flare's own documented sibling-repo layout exactly)

```
services/tee-extension/            (= "tee/" in Flare's own docs)
├── tee-node/                      cloned from github.com/flare-foundation/tee-node
├── tee-proxy/                     cloned from github.com/flare-foundation/tee-proxy
├── extension-examples/
│   └── extension-scaffold/        cloned from github.com/flare-foundation/fce-extension-scaffold,
│                                   customized for HyperMove (see "What was customized" below)
└── scripts/                       e2e-coston2-flare-xrpl.ts orchestrator (see above)
```

This three-way sibling layout is **required**, not a style choice — the scaffold's `go.mod`
has a `replace github.com/flare-foundation/tee-node => ../../tee-node` directive (and the
`tools/` submodule has an equivalent for `tee-proxy`), so `extension-scaffold` must sit two
levels below `services/tee-extension/`, with `tee-node`/`tee-proxy` as its two siblings one
level up.

**`tee-node` and `tee-proxy` are pinned to their latest tagged release** (`v0.0.22` and
`v0.0.19` respectively, as of this writing), not their `main`/`develop` HEAD — HEAD had a
real version mismatch against the scaffold's pinned `go-flare-common` dependency version
(confirmed by a live build failure during this session, not assumed). If you re-clone either
repo, check out its latest tag before building.

## What was customized (vs. the upstream Hello World scaffold)

Followed the scaffold's own `.claude/skills/rename-scaffold/SKILL.md` for the mechanical
rename, then replaced the `GREETING` business logic with HyperMove's two OPTypes:

| | Old (Hello World) | New (HyperMove) |
|---|---|---|
| Contract | `HelloWorldInstructionSender` | `HyperMoveInstructionSender` |
| Go package | `helloworld` | `hypermove` |
| OPType 1 | `GREETING` / `SAY_HELLO`, `SAY_GOODBYE` | `FINANCIAL_ACTION` / `SWAP`, `SETTLE` |
| OPType 2 | (none) | `GENERIC_AGENT_TASK` / `COMPUTE` |

Files touched: `contracts/InstructionSender.sol`, `internal/config/config.go`,
`internal/extension/extension.go` (+ its test file), `pkg/types/types.go`,
`pkg/types/register.go`, `tools/pkg/utils/instructions.go`, `tools/pkg/contracts/hypermove/`
(renamed from `helloworld/`), `tools/cmd/run-test/main.go`, `tools/cmd/test-types-server/main.go`.

## The honest-stub boundary (read this before "fixing" a handler)

`processFinancialAction`/`processGenericAgentTask` in `internal/extension/extension.go`
**always return a structured refusal** (`ActionResult.Status = 0`), never a fabricated
success. This is deliberate, not a bug:

- **Financial actions** would need to invoke Flare's Protocol Managed Wallets (PMW) to
  produce a real signed settlement transaction. PMW's third-party invocation interface was
  not published as of 2026-07-20 (verified against `dev.flare.network/fcc/overview` during
  this PRD's research). Guessing that ABI would risk a wrong on-chain call — this codebase's
  own convention (see `hypermove-app/src/lib/mcp/providers/flare.ts`'s
  `executeFccConfidential()`) treats that as strictly worse than an honest refusal.
- **Generic agent tasks** would need real confidential-compute task logic, explicitly
  deferred per this PRD's own scoping ("do it later").

The routing, decoding, and relay path around both stubs **is real and tested** — see
`internal/extension/extension_test.go` and `tools/cmd/run-test/main.go` (the E2E driver,
which asserts the honest refusal shape against a live deployment, not a mocked one).

**Do not fill in these stubs by guessing an ABI.** When Flare publishes PMW's third-party
interface, or HyperMove decides on a specific generic-compute task implementation, update
`handleFinancialAction`/`handleGenericAgentTask` and this file, citing the real interface
source.

## Local build & test (no live chain needed)

```bash
cd extension-examples/extension-scaffold
go build ./...
go vet ./...
go test ./...              # unit tests, including the honest-stub assertions

cd tools
go mod tidy                # only needed once, if go.sum is stale
go build ./...
go test ./pkg/...
```

Verified working in this session with Go 1.26.5 (Homebrew `go` formula) — the system's
pre-existing `/usr/local/go` install was Go 1.19.4, too old for this module's `go 1.25.1`
requirement. Both Go installs coexist; nothing about the older system Go was removed.

## Deploying to Coston2 (real external blockers — see the PRD's pre-mortem T1)

This session did **not** deploy to live Coston2. Two real, human-required blockers stand
between "builds and unit-tests locally" and "registered on Coston2":

1. **Flare indexer-DB credentials** — `ext-proxy` needs a MySQL-shaped indexer DB. Per the
   scaffold's own docs, request access via Flare support / `@FlareDevs` on X.
2. **A public HTTPS tunnel** to port 6674 (`ngrok http 6674` or `cloudflared tunnel --url
   http://localhost:6674`) — required so Flare's own data providers can reach `ext-proxy`.

Once both are in place, follow `docs/deployment-steps.md` (already in this scaffold) or the
condensed sequence:

```bash
cp .env.example .env
# fill in DEPLOYMENT_PRIVATE_KEY, INITIAL_OWNER, PROXY_PRIVATE_KEY, CHAIN_URL, EXT_PROXY_URL
./scripts/pre-build.sh
./scripts/start-services.sh --chain coston2
./scripts/post-build.sh
./scripts/test.sh
```

`SIMULATED_TEE=true` (already the default posture this PRD targets) means no Confidential VM
hardware is required for this stage — matching Flare's own documented dev path.

## Cross-reference

Full PRD: `biz-team/bd-team/research/hypermove/2026-07-20-tee-proxy-fcc-extension-token-profile/06-prd-sub-tee-extension-service.md`
