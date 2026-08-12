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

### New real caller (Dream Cycle Confidential Extraction on Flare FCC, 2026-08-07)

`hypermove-app/src/lib/mcp/dream/extract.ts`'s `extractOneClusterConfidential()` is a second
real caller of `flare.instruct.dispatch` (`GENERIC_AGENT_TASK` opType), alongside the
existing `flare.instruct.dispatch` MCP tool itself. It routes Dream Cycle's extraction stage
through this same TEE-extension when an agent opts into `start_dream({confidential: true})`
(gated by `isMcpDreamConfidentialEnabled()`, default OFF).

**Update (2026-08-08): `processGenericAgentTask` is no longer a blanket stub.** For
`taskType == "dream.extract"` specifically, `handleGenericAgentTask`
(`internal/extension/extension.go`) now calls out to HyperMove's already-deployed
`llm-service` `/dream/extract` route and returns REAL extraction output, matching the
forward-looking contract this section used to only describe. Every OTHER `taskType`
(including the still-stubbed `FINANCIAL_ACTION` path) is unchanged — still an honest
not-yet-implemented refusal.

**Read this before assuming "confidential" means "the LLM call is confidential" — it does
not, by explicit design decision (2026-08-08):** this ships "TEE-attested dispatch + result
signing," not "the LLM call itself runs inside the TEE." The actual token generation still
happens in the existing non-TEE `llm-service` process, reached over the network exactly like
any other external HTTP call this extension makes — re-implementing Bedrock/DeepSeek calls
natively in Go inside the TEE was explicitly evaluated and rejected in favor of reusing the
already-built, already-tested prompt/parsing logic in one place, at the cost of the LLM call
itself not being confidential. If a future ship needs the LLM call to genuinely run inside
the TEE, that requires re-implementing the extraction call natively in Go — this is
explicitly NOT what shipped here.

**The data contract this now actually satisfies:** `ActionResult.data` carries `{
attestationQuote: string, insights: { rules, preferences, error_patterns, facts: string[] }
}` exactly as the TS caller side (`extract.ts`'s `extractOneClusterConfidential()`,
`confidential.ts`'s `verifyAttestation()`) already expects — see
`hypermove-app/tests/mcp-dream-extract-confidential.test.ts`'s "Task 5" suite for the exact
contract, and this repo's own `internal/extension/extension_test.go` for the Go-side tests
covering the real success path, a non-genuine (`extraction_failure_reason` present) failure,
an unreachable-service failure, and a non-2xx-status failure — all verified passing via a
real `go test` run, not self-declared.

**The attestation quote is honestly NOT a real cryptographic quote under this deployment's
`SIMULATED_TEE=true`/`MODE=1` posture** — see the "Deploying to Coston2" section below for
why, and why `confidential.ts`'s real Phala Cloud verification call correctly, honestly
rejects it. This is the expected, documented current boundary — not a bug to "fix" by
fabricating a plausible-looking fake quote.

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

Verified working with Go 1.25.1 (both via Homebrew locally and a fresh `go.dev/dl` download
on the deployment VPS) — coexisting with an older system Go install in both cases; nothing
about the system Go was removed in either environment.

## Deploying to Coston2 — LIVE as of 2026-08-08 (native VPS deployment, no Docker)

**Update (2026-08-08):** deployed for real to Coston2, self-hosted end-to-end on the existing
`hypermove-app`/`llm-service` VPS (`13.212.193.69`) — no ngrok/cloudflared, no shared Flare
indexer-DB credential request. Both of the two blockers this section used to describe were
resolved by self-hosting instead of waiting on them:

1. **Indexer-DB credentials** — instead of requesting Flare's shared indexer-DB access,
   `services/tee-extension/flare-system-c-chain-indexer` (already vendored in this repo) runs
   natively against a **self-hosted MySQL 8.0** instance on the same VPS
   (`hypermove_fcc_indexer` database, localhost-only). No external credential request was
   needed — self-hosting a real Flare C-chain indexer against your own MySQL is a fully
   supported, documented path (see that binary's own README).
2. **Public HTTPS reachability for `ext-proxy`** — instead of ngrok/cloudflared, the VPS's
   existing Caddy instance (already TLS-terminating `hypermove.duckdns.org` for
   `hypermove-app`/`llm-service`) got a third `handle_path /tee-proxy/* { reverse_proxy
   localhost:6664 }` route, matching the existing `/llm/*` pattern exactly.

**No Docker anywhere in this deployment** (per explicit scope decision) — `tee-proxy`,
`extension-tee` (built from `extension-scaffold`'s `cmd/docker` package, which is Docker-named
but is a plain Go binary with no Docker dependency), and the indexer all run as native Go
binaries supervised by PM2, alongside `hypermove-app`/`llm-service`. Redis (`apt install
redis-server`, localhost-only) replaces the docker-compose `redis` service `tee-proxy`
requires.

**Real, on-chain, independently-verified results:**
- `HyperMoveInstructionSender` deployed at `0xB4864BB622F3020a5d424ff2CC20738b3327f7E2` on
  Coston2 — verified via a fresh `eth_getCode` RPC call returning real bytecode (10,475
  bytes), not just trusting the deploy script's own stdout.
- Extension registered on-chain: `EXTENSION_ID = 0x101e4`.
- Full `tee-proxy` ↔ `extension-tee` round trip verified working: a real TEE_INFO action was
  enqueued, picked up, processed, and answered with `status 1` — the extension genuinely
  executes and responds, this is not a mocked/simulated result.

**A real upstream bug found and fixed during this deployment** (not present in any of this
repo's own prior code): `tee-proxy`'s `buildAttestationConfig()` (`internal/proxy/proxy.go`)
never returned `nil` when attestation was disabled — it returned a non-nil
`&attestation.Config{Enabled:false}` instead. `info.go`'s own doc comment says its
`attestationCfg` parameter "may be nil or disabled," and gates its ENTIRE response-signature-
verification block (not just the deeper `attestation.Verify()` call) on `attestationCfg !=
nil` — so a disabled attestation config still forced signature verification to run
unconditionally, and a real, correct TEE_INFO response panicked with "verifying response
signature: invalid signature length" even though attestation was configured off. Fixed by
returning `nil` (matching the documented intent) plus a nil-guard in `logAttestationPosture`.
See that function's own code comment for the full trace.

**Two additional dev-only, clearly-labeled shortcuts** (both loudly logged, neither is a
config default — see each one's own code comment for the exact tradeoff and why it's safe
ONLY for this kind of dev deployment):
- `flare-system-c-chain-indexer`'s `internal/fsp/startup.go`: `SKIP_FSP_BACKFILL=true` env
  var forces `backfillEvents=false`, trading full FSP reward-epoch historical correctness for
  faster startup. **Not used in the final working deployment** — the real backfill (14 log
  filters × ~27k blocks) was re-run to completion once `tee-proxy`'s actual dependency on
  real signing-policy log data was discovered (see below); this flag is kept as a documented
  option for future dev iterations where full backfill isn't needed.
- `tee-proxy`'s `internal/proxy/proxy.go`: `TEE_PROXY_OUT_OF_SYNC_TOLERANCE_SECONDS` env var
  overrides the hardcoded 1-minute `outOfSyncTolerance` — this constrained VPS's self-hosted
  indexer cannot always index Coston2 blocks faster than the chain produces them, so the
  upstream 1-minute default is too tight for this specific host's throughput.

**Real dependency chain discovered (useful for the next person deploying this):**
`tee-proxy` startup requires, in this order: (1) DB sync within `outOfSyncTolerance`, (2) a
successful TEE_INFO round trip with the extension (needs the CORRECT binary —
`extension-scaffold`'s `./cmd` package is a bare standalone handler with no sign/config
server; the real Docker-parity binary is `./cmd/docker`, which wraps `tee-node`'s sign+config
servers together with the scaffold's action handler in one process — building the wrong one
produces a "connection refused" on `localhost:6663` from the extension side), (3) real
on-chain signing-policy log data in the indexer DB (from the FSP backfill) to initialize its
signing-policy service — skipping step 3 via `SKIP_FSP_BACKFILL` un-blocks steps 1-2 but then
fails at "initializing signing policy: ... no signing policy logs found in db."

Condensed real sequence used (native, not the docker-compose-oriented steps below):

```bash
# 1. Contract deploy + extension registration (real, on Coston2)
cd extension-examples/extension-scaffold
./scripts/pre-build.sh   # needs .env: DEPLOYMENT_PRIVATE_KEY, INITIAL_OWNER, CHAIN=coston2

# 2. Native binaries (NOT docker compose)
go build -o bin-indexer ./cmd/indexer          # flare-system-c-chain-indexer
go build -o bin-tee-proxy ./cmd/proxy           # tee-proxy
go build -o bin-extension-tee ./cmd/docker      # extension-scaffold — MUST be ./cmd/docker

# 3. pm2 start each with the right env (see this file's "What was customized" table +
#    the real dependency chain above for exact env vars each needs)

# 4. Register TEE version + governance (needs step 2's tee-proxy /info endpoint reachable)
EXT_PROXY_URL=http://localhost:6664 LOCAL_MODE=false CHAIN=coston2 ./scripts/post-build.sh
```

`SIMULATED_TEE=true`/`MODE=1` (this deployment's posture) means the extension's own
attestation quote is `tee-node/pkg/attestation.MagicPass` — a real, public, documented
"testing outside of the google cloud" sentinel, NOT a cryptographic quote. This is expected
and correctly, honestly rejected by `confidential.ts`'s real Phala Cloud verification call —
see `internal/extension/extension.go`'s `handleGenericAgentTask` doc comment for the full
scope boundary this implies.

### Historical context (pre-2026-08-08, kept for reference)

Before this session, deployment was blocked on two assumed-external blockers:

1. **Flare indexer-DB credentials** — request access via Flare support / `@FlareDevs` on X.
2. **A public HTTPS tunnel** to port 6674 (`ngrok http 6674` or `cloudflared tunnel --url
   http://localhost:6674`).

Both turned out to be avoidable by self-hosting (see above) rather than genuinely required —
worth remembering the next time a deployment blocker looks like it needs an external party:
check whether self-hosting the dependency is actually viable first.

### Current real status (verified 2026-08-08) and the actual hard boundary hit

**Genuinely live and independently verified:**
- `HyperMoveInstructionSender` deployed on Coston2 at
  `0xB4864BB622F3020a5d424ff2CC20738b3327f7E2` — bytecode independently confirmed via a fresh
  `eth_getCode` call (10,475 bytes).
- Extension registered on-chain (`EXTENSION_ID = 0x101e4` / decimal `66020`), then
  `setExtensionId()` called for real (tx `0xe9445d9fcf6faac61973228b927b70ba1a2ed188a805d115cde943c56a447b58`,
  block `33765848`, `status: 1`).
- TEE governance set on-chain for the extension (1 signer, threshold 1) via `set-governance`
  — real tx, confirmed.
- `tee-proxy`'s public `/info` endpoint is LIVE at
  `https://hypermove.duckdns.org/tee-proxy/info` (HTTP 200), serving a real, complete
  `TeeInfoResponse` — real `dataSignature`/`proxySignature`, real extension/machine identity,
  honestly-labeled `"attestation":"magic_pass"` (see the SIMULATED_TEE note above).
- `hypermove-app`'s `flare.instruct.dispatch` MCP tool successfully reaches the deployed
  contract over a real `tools/call` request — confirmed via a live curl against the running
  gateway, producing real, informative on-chain revert reasons at each step as blockers were
  fixed one at a time ("Extension ID is not set" → fixed → real custom-error revert from
  `TeeExtensionRegistry.sendInstructions()` because no TEE machine was registered yet).
- **A second real bug found and fixed in `flare-instruct.ts`** during this live testing: the
  poll URL was `/action-result/{id}` (hyphenated) — the real `tee-proxy` route (per
  `internal/server/external.go`) is `/action/result/{id}` (path-segmented). Also fixed:
  `ActionResult.Data` is `hexutil.Bytes` (0x-hex-encoded raw bytes containing a JSON string,
  per `tee-node/pkg/types/actions.go`), not a plain JSON value — the poll result now
  hex-decodes before `JSON.parse`. Both fixes verified via 2 new tests in
  `tests/mcp-flare-instruct-dispatch.test.ts` plus a live call against the real deployment.

**The actual hard boundary — real Google Confidential Space hardware, not fixable from
here:** completing on-chain TEE-machine registration (`register-tee`) requires parsing a
Google Confidential Space attestation JWT (`fccutils.CodeHashAndPlatform()` →
`googlecloud.ParsePKITokenUnverifiedClaims()`) to extract a real code-hash/platform claim.
Under `SIMULATED_TEE=true` (this deployment's only possible posture — no GCP Confidential VM
requested or available), the extension's attestation value is the plain string `"magic_pass"`
— not a JWT, so parsing fails with "token contains an invalid number of segments." Read the
tool's source directly to confirm: there is no `LOCAL_MODE`/simulated-mode bypass for this
specific parse step anywhere in `fccutils`. This means:
- `sendGenericAgentTask`/`sendFinancialAction` will keep reverting with a
  `TeeExtensionRegistry`-side custom error (unregistered TEE machine — `getRandomTeeIds()`
  has no machine to return) until a machine is registered, which requires real hardware.
- Everything UP TO this exact point — deployment, extension registration, governance,
  `tee-proxy`↔`extension-tee` communication, the public `/info` endpoint, and the full MCP
  dispatch path reaching the contract — is real, live, and independently verified.
- This is the genuine, correctly-identified boundary between "SIMULATED_TEE dev deployment"
  and "real hardware-backed FCC" — not a config gap or a bug to patch around. Real GCP
  Confidential Space hardware (or Flare shipping a documented simulated-registration path)
  is required to go further.

## Cross-reference

Full PRD: `biz-team/bd-team/research/hypermove/2026-07-20-tee-proxy-fcc-extension-token-profile/06-prd-sub-tee-extension-service.md`

## 2026-08-11 redeploy investigation — `FlareTeeManager` diamond redeploy wiped registration; blocked on a NEW, different issue

A community troubleshooting message (independently corroborated against Flare's own official
`dev.flare.network/fcc/troubleshooting` doc, fetched and read in full during this
investigation) reported that Coston2's `FlareTeeManager` diamond proxy had been redeployed,
stranding existing extension registrations. Verified this affected us for real:

**Diagnosis (read-only, via the scaffold's own `tools/cmd/query-tee`):**
```
go run ./cmd/query-tee -ext 66020   # our EXTENSION_ID (0x101e4) at the time
=== Active TEEs for extensionId=66020 ===
  (none)
```
Sanity-checked against `-ext 0` (Flare's own FTDC/system extension), which correctly returned
3 real active machines with real `flare.rocks` URLs — proving the query tool and its registry
address were genuinely working, so our own empty result was a real finding, not a client-side
tool/config bug. `FlareTeeManager`'s address
(`0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE`) was already correct in both the local repo's
and the VPS's `config/coston2/deployed-addresses.json`, dated 2026-07-20 — predating the
community message — so the address itself was never the problem; the redeploy genuinely wiped
our on-chain registration against a contract we already had the right address for.

**Fix applied so far (real, on-chain):**
1. `./scripts/pre-build.sh` re-run on the VPS (needed `forge`'s actual install path,
   `~/.foundry/bin`, added to `PATH` explicitly — not on `PATH` in a non-interactive SSH
   shell by default). Result: a genuinely new `InstructionSender` contract deployed at
   `0xc6069073DA915917eb34f85a4e6CcD01987ABa37`, and a fresh `EXTENSION_ID =
   0x10260` (decimal `66144`) registered on-chain, replacing the old, wiped `0x101e4`.
2. Updated the VPS's live `extension-tee` PM2 process with the new `EXTENSION_ID`/
   `INSTRUCTION_SENDER` — required explicitly sourcing the updated `run/extension.env` into
   the shell BEFORE calling `pm2 restart extension-tee --update-env`, because PM2 caches its
   own env snapshot from whenever a process was originally started and does **not** re-read
   an on-disk `.env` file on a plain restart, even with `--update-env` (that flag only
   refreshes from the *calling shell's* current env, not from the file). Confirmed via
   `pm2 env <id>` before/after — this is the same class of gap this repo's own
   `docs/dream-cycle-fcc-rlusd-status-review` corpus already documented for `llm-service`.

**New blocker hit — NOT the same one this file documented on 2026-08-08, and NOT fixed:**
Confirming the new `EXTENSION_ID` actually took effect end-to-end requires `tee-proxy`'s
public `/info` (it relays `extension-tee`'s live `TEE_INFO` response). While diagnosing why
`/info` still showed the OLD extension ID immediately after the `extension-tee` restart, a
`tee-proxy` restart was tried (to rule out a caching theory) — this triggered `tee-proxy`'s
own startup health check, which found the indexer database genuinely **~51 hours out of
sync** and entered a designed 10-minute-interval backoff loop (`Sleeping for 10m0s`, cycling
through up to 31 retries). `fcc-indexer` itself is confirmed still running and making real
forward progress (`Continuous progress: block=...` increasing across log checks), just slower
than the chain's real pace — this was very likely already true before the `tee-proxy`
restart; the restart exposed a pre-existing gap rather than caused a new one, but restarting
a service that was otherwise working was the wrong troubleshooting step and cost real
recovery time.

**Where this leaves things, honestly:**
- `extension-tee`'s PM2 env now genuinely holds the new `EXTENSION_ID`
  (`0x10260`) — confirmed via `pm2 env`, not just inferred from the restart succeeding.
- Whether that new ID has actually propagated into `extension-tee`'s live, in-process
  `TEE_INFO` response is **unconfirmed** — `/info` was unreachable through `tee-proxy` for
  the remainder of this session due to the indexer-sync backoff above.
- `register-tee` (the next required step — actually registering a TEE *machine* against the
  new extension ID) was **not run**: its very first real step
  (`fccutils.TeeInfo(proxyURL)`) hard-depends on a live `tee-proxy` `/info` response, so it
  could not proceed. `post-build.sh` and `test.sh` are blocked transitively for the same
  reason.
- This is a genuinely different, earlier-stage blocker than the "real GCP Confidential Space
  hardware" boundary this file already documented above (2026-08-08) — that boundary is about
  `register-tee`'s attestation-JWT parsing step specifically, several steps past where this
  session got stuck. Both are real; they are not the same issue, and fixing today's indexer-
  sync gap will NOT bypass the hardware boundary documented above — the hardware boundary is
  still real and still applies once (if) registration itself becomes reachable again.

**What would unblock this**: either the indexer genuinely catches up (fixed 10-minute retry
cadence, up to 31 attempts observed — at the lag rate seen this session, this could take
hours, and the lag appeared to be growing rather than shrinking between checks, which is worth
someone with deeper indexer-throughput visibility investigating separately) or someone
restarts/fixes `fcc-indexer` with the actual ability to diagnose *why* it's lagging (not
attempted here — this session's own visibility into that binary's expected throughput was not
sufficient to safely intervene further without risking making it worse).

