# hypermove-fce-extension

A Flare Compute Extension (FCE) — the `POST /action` handler a Flare TEE
node (`extension-tee`) forwards confidential-compute instructions to — that
fulfils `GENERIC_AGENT_TASK` instructions by calling out to
[HyperMove](https://hypermove.duckdns.org)'s public MCP gateway, then signs a
commitment digest of the result via the TEE node's own identity key.

This is a **standalone TypeScript/Hono rewrite** of the honest-stub Go
extension already vendored at
`../tee-extension/extension-examples/extension-scaffold` (sibling directory
under `hypermove-app/services/`)
— it implements the exact same real `/action` wire contract, but replaces
the Go stub's `"not yet implemented"` refusal for HyperMove-specific
OPCommands with a real call to HyperMove's MCP tools. It does **not**
modify, replace, or supersede that Go service, `flare-instruct.ts`, or any
other existing HyperMove code — it is new, additive infrastructure.

## Why the wire format looks the way it does

The original design brief for this project assumed a flat, human-readable
JSON schema for `POST /action` (`{ id, opType, opCommand, message: { tool,
arguments } }`). **That schema does not exist in the real Flare pipeline.**
Reading the vendored Go source (`services/tee-extension/tee-node` and
`services/tee-extension/extension-examples/extension-scaffold`) turned up the
real contract instead:

- `Action.Data.Message` is a JSON string containing a `DataFixed` object:
  `{ opType, opCommand, originalMessage, ... }`, where `opType`/`opCommand`
  are **not human-readable strings** — they're `bytes32`-encoded hashes.
- Those hashes are **not keccak256**. They're Solidity's `bytes32(s)`
  literal semantics: the string's raw ASCII bytes, right-padded with zero
  bytes to 32 bytes, truncated at 32 characters
  (`services/tee-extension/tee-node/pkg/utils/utils.go`'s real
  `ToHash()`). This matches `hypermove-app`'s existing
  `src/lib/mcp/flare-instruct.ts`'s `opCommandToBytes32()` convention —
  `src/action-codec.ts`'s `toOpHash()` reuses that exact scheme.
- `originalMessage` is a **Solidity ABI-encoded tuple** (`abi.encode`), not
  JSON — a single named-tuple parameter (`{ action, amount, chain }` for
  `FINANCIAL_ACTION`, `{ taskType, payload }` for `GENERIC_AGENT_TASK`),
  confirmed against `extension-scaffold/pkg/types/types.go`'s real
  `abi.NewType("tuple", ...)` definitions and a real, passing Go test
  (`extension_test.go`'s `buildTestAction()`).
- The response (`ActionResult`) is the same hash/hex-based struct, with
  `data` as a hex-encoded byte string (this codec JSON-encodes-then-hexes
  the payload, matching `FinancialActionResponse`/`GenericAgentTaskResponse`'s
  documented "JSON payload returned in ActionResult.Data" convention).

This discovery happened by writing `scripts/verify-hash-equivalence.ts`
*before* `action-codec.ts` — the script's own first run caught two real
mistakes (an assumed-keccak256 hashing scheme that was actually
bytes32-padding, and a hand-transcribed hex literal with a typo) before
either could reach committed code.

## HyperMove's OPCommands

HyperMove-specific commands (`SEARCH`, `NEWS_SEARCH`, `NEWS_DIGEST`,
`NEWS_INSIGHT`, `CODEMODE_SPEC`, `CODEMODE_VECTOR_SEARCH`, `SKILL_RUN`) are
modeled as new `OPCommand`s nested under the **existing** `GENERIC_AGENT_TASK`
`OPType` (see `src/config.ts`'s doc comment for the full reasoning) — no new
Solidity `OPType` or on-chain redeploy is required. Each reuses the exact
same `{ taskType, payload }` ABI tuple shape as the original `COMPUTE`
placeholder; `payload` carries the JSON-encoded HyperMove tool arguments as
UTF-8 bytes.

`FINANCIAL_ACTION`/`SWAP`/`SETTLE` and `GENERIC_AGENT_TASK`/`COMPUTE` are
unchanged from the original scaffold and remain **honest not-yet-implemented
stubs** — see "Known boundary" below.

## Known tradeoff: admin-token reuse

This extension authenticates to HyperMove's MCP gateway using the
**existing** `HYPERMOVE_MCP_ADMIN_TOKEN` admin-bypass mechanism already
implemented in `hypermove-app/src/lib/mcp/auth.ts` (`authenticate()`'s
"Layer 1 — admin token" branch). This was the fastest path to a working
integration and required zero new backend auth code — but it means:

- **Every call this extension makes runs at admin tier** — it bypasses the
  free-tier rate limit and the x402/MPP paywall entirely.
- A leaked `HYPERMOVE_MCP_ADMIN_TOKEN` value grants full admin access to the
  HyperMove gateway, not just this extension's narrow use case.
- There is currently no separate revocation path for "this extension's
  access" independent of "all admin access."

**If this ships to production**, consider a follow-up: a dedicated
`SessionKind: 'extension'` token type in `auth.ts` with its own tier, so a
compromised extension credential can be revoked without touching human admin
access. This was explicitly scoped out of the current ship as a deliberate,
reviewed tradeoff — not an oversight.

## Known boundary: `TEE_WALLET` payment mode is an honest stub

When a `GENERIC_AGENT_TASK` HyperMove call returns HTTP 402 and
`payment_mode` is `TEE_WALLET`, this extension does **not** attempt to sign
and settle the payment itself. Protocol Managed Wallets (PMW) — the FCC
mechanism that would let a TEE-held key sign a real settlement transaction —
does not have a published third-party invocation interface as of this ship
(same blocker named in `services/tee-extension`'s own `README.md` and
`providers/flare.ts`'s `executeFccConfidential()`). Guessing at that ABI
would risk a wrong on-chain call, which every part of this codebase's
existing conventions treat as strictly worse than an honest refusal.

`payment_mode: 'AGENT_PASSTHROUGH'` (the default) is the only payment mode
this extension actually resolves: it packages the 402 challenge into the
`ActionResult` so an upstream caller/agent can react to it.

## Known boundary: transport (legacy JSON-RPC, not real MCP Streamable-HTTP)

`hypermove-app`'s real default transport for `/api/mcp` (when
`FEATURE_HYPERMOVE_MCP_GATEWAY_V1` is on, the default) is the actual **MCP
Streamable-HTTP protocol** (`mcp-handler`/`@modelcontextprotocol/sdk`), not
the bespoke JSON-RPC surface this client speaks. This client deliberately
targets the **legacy JSON-RPC fallback path** (`src/app/api/mcp/route.ts`'s
`handlePost()`), which is simpler and fully documented, rather than
implementing a full MCP client — reaching it in production requires either
`FEATURE_HYPERMOVE_MCP_GATEWAY_V1=false` on the HyperMove deployment, or a
tracked follow-up to speak real MCP Streamable-HTTP from this extension.
Named explicitly rather than silently assumed to work against the default
transport.

## Architecture

```
Flare TEE node (extension-tee)
  │  POST :8889/action   (real Action wire format, see above)
  ▼
src/index.ts (Hono, this project)
  │  decodeAction()              — src/action-codec.ts
  │  route opCommand → HyperMove tool
  │  callHyperMoveTool()          — src/hypermove.client.ts
  │  buildSearchCommitment(), etc — src/commitments.ts
  │  signWithTee()                — src/tee.client.ts (POST :8888/sign)
  │  encodeActionResult()         — src/action-codec.ts
  ▼
POST :8889/action response → TEE node signs + forwards to ext-proxy
```

The core per-request pipeline (`handleAction()`) is wrapped in
[`nim-skill`](https://github.com/phamdat721101/nim-skill)'s `runHarnessed()`
— the same pattern `hypermove-app`'s `flare-instruct.ts`/`confidential.ts`
already use: a schema enforcer (`required: ['result']`, `maxHeals: 0`,
`mode: 'strict'`) guarantees every response is a well-formed
`WireActionResult` before it leaves the process.

## Setup

```bash
npm install
cp .env.example .env   # fill in HYPERMOVE_MCP_ADMIN_TOKEN
npm run dev            # starts on :8889 (or $TEE_EXTENSION_PORT)
```

```bash
npm run typecheck      # tsc --noEmit
npm test               # vitest run — 54 tests across 5 files
```

## Testing

| File | Covers |
|---|---|
| `test/action-codec.test.ts` | Real wire-format decode/encode, `toOpHash`/`fromOpHash` round-trips, malformed/unknown OPType/OPCommand paths |
| `test/hypermove.client.test.ts` | JSON-RPC request shape, bearer auth, **soft-empty is success** (critical rule), real errors, 402 parsing, network failures |
| `test/tee.client.test.ts` | `/sign` and `/sign/{walletID}/{keyID}` request shapes, client-side walletID validation before any network call |
| `test/commitments.test.ts` | `SEARCH`/`NEWS_DIGEST` commitment digests — golden-value regression, field-order sensitivity |
| `test/index.test.ts` | Full end-to-end: happy path, soft-empty→success, real error→failure, network failure→structured failure (never a crash), unsupported OPType, `FINANCIAL_ACTION` honest stub, both `AGENT_PASSTHROUGH`/`TEE_WALLET` payment paths |

## `nim-workrule` self-check (WR-01..WR-06)

- **WR-01** (clean/SOLID): one file per responsibility (`action-codec` /
  `hypermove.client` / `tee.client` / `commitments` / `config` / `index`),
  no duplicated ABI/hashing logic across files.
- **WR-02** (no repeated mistakes): the ABI-decoding bug (flat multi-param
  args decode positionally, not by name) was caught once in
  `action-codec.ts` and the fix pattern (single named-tuple parameter) was
  applied consistently to both the request codec and the test fixtures that
  hand-build ABI payloads.
- **WR-03** (essential files only): no files were touched outside this new,
  standalone project directory — `hypermove-app` and
  `services/tee-extension` were read for ground truth but never modified.
- **WR-04** (partial reads / no unnecessary new files): HyperMove's new
  OPCommands reuse the existing `GENERIC_AGENT_TASK` ABI tuple shape rather
  than inventing a new one; chain IDs are a small local copy of
  `chain-constants.ts`'s `FLARE_CHAIN_IDS` rather than a cross-repo import
  (this project is intentionally standalone).
- **WR-05** (deployable, no surprise deps): `hono`/`viem`/`nim-skill` are the
  only runtime dependencies; all pinned to specific patched versions
  (`npm audit` clean after bumping `hono`/`tsx` off their originally-pinned
  vulnerable versions).
- **WR-06** (tracked memory): see `.nim/agent-support-log.md` (gitignored) —
  logged via `nim-skill`'s real `createWorkruleHelper()`, not hand-written.
