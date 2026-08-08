# hypermove-app

> **`hypermove.xyz`** — make any web3 dApp agent-callable. Monetize in 5 minutes with x402-USDC.
> Open-source, MIT-licensed, built on [`n-payment`](https://www.npmjs.com/package/n-payment).

Standalone Next.js 14 implementation of the HyperMove consolidation surface. The homepage IS the demo — an AI agent visiting the site reads `.well-known/webmcp.json`, hits a $0.01 `payment.x402` paywall, signs through n-payment, and renders a 200 OK — all in-page.

## Status

| Sprint | Scope | Status |
|---|---|---|
| **S1** | Landing + Docs (n-payment) + Pricing + stubs + Vercel/Docker config | ✅ shipped |
| **S2** | Live Agent Demo + Bundle catalog `/portal` + email registry + paid-endpoint + MCP JSON-RPC | ✅ shipped |
| **S2.1** | De-brand, Calendly/GitHub links, Supabase Postgres registry | ✅ shipped |
| **S3** | Mode B hosted + Public Registry + Dashboard | ⏳ deferred |
| **S4** | Substack #17 + Vietnamese tutorials | ⏳ deferred |

See [`tracking/PERFORMANCE.md`](./tracking/PERFORMANCE.md) for est-vs-actual hours.

## Quickstart

```bash
# 1. Install
pnpm install   # or: npm install

# 2. Copy env (zero-config: mock mode runs without keys)
cp .env.example .env.local

# 3. Dev
pnpm dev       # → http://localhost:3003

# 4. Lifecycle (single entry point)
./run.sh ship  # setup → test → build → smoke → report
```

## Live-agent modes

| `LIVE_AGENT_MODE` | Behavior | Required env |
|---|---|---|
| `mock` (default) | Deterministic 9-frame SSE state machine. Zero-config. | — |
| `real` | Anthropic Claude Haiku via `@anthropic-ai/sdk` (lazy-imported). Falls back to mock on failure. | `ANTHROPIC_API_KEY` |

The `/api/paid-endpoint` paywall always emits the real `HTTP 402 + WWW-Authenticate: x402-USDC` contract regardless of mode.

## Registry storage

`/portal` email-bundle requests are persisted to Postgres (Supabase project `boopiufnqyrwzvyrjens`) via a Next.js Server Action (`src/app/portal/actions.ts`). The schema is auto-created idempotently on first write — see `src/lib/db.ts`. Configure via `DATABASE_URL` in `.env.local`.

### Use the Supavisor pooler URL, not the direct host

Supabase's **direct** Postgres host (`db.<project>.supabase.co:5432`) is IPv6-only on free tier — and Vercel's serverless runtime + most ISPs don't route IPv6 reliably. Always use the **Supavisor Transaction Pooler** URL.

Format:
```
postgresql://postgres.<project-ref>:<password>@<shard>-<region>.pooler.supabase.com:6543/postgres
```

Concrete example for project `boopiufnqyrwzvyrjens` (shard `aws-1`, region `ap-southeast-1`):
```
postgresql://postgres.boopiufnqyrwzvyrjens:<password>@aws-1-ap-southeast-1.pooler.supabase.com:6543/postgres
```

To get the right URL for your project: Supabase Dashboard → **Project Settings → Database → Connection pooling → Transaction**.

### Diagnosing `persist_failed` errors

When the Server Action returns `persist_failed`, the UI shows a hint code mapped via `BundleRequestForm`'s `HINT_MESSAGES` table. Server-side, `db.ts` logs the underlying pg error (visible in Vercel/Hetzner logs):

| Hint code           | Likely fix                                                                              |
|---------------------|----------------------------------------------------------------------------------------- |
| `dns_unreachable`   | Wrong host in `DATABASE_URL`, or you're using the IPv6-only direct host on IPv4 network. Switch to pooler URL. |
| `tenant_not_found`  | Usually **not** a shard mismatch — the pooler's own DNS (`aws-0`/`aws-1-<region>.pooler.supabase.com`) resolves regardless of project state, so it never tells you the shard is wrong. Run `./run.sh doctor` — it pings `https://<project-ref>.supabase.co` directly: no DNS record there means the project was deleted; DNS resolves but HTTP doesn't respond means it's paused (free-tier auto-pause after ~7 days idle — restore it from the Dashboard). |
| `auth_failed`       | Password rotated, or `postgres.<project-ref>` tenant prefix missing from the username.  |
| `connection_refused`| Pooler port is `6543` (not `5432`) for Transaction mode.                                |
| `tls_failed`        | Provider requires `ssl=true`; `db.ts` enables `rejectUnauthorized:false` automatically when host contains `supabase`. |

## Deploy

### Option A — Vercel

```bash
vercel deploy
```

**⚠ The fastest path to a `persist_failed` bug is forgetting to set `DATABASE_URL` (and friends) in Vercel.** `.env.local` is git-ignored and never reaches Vercel.

Run `./run.sh env-show` to print the exact values you need to paste into **Vercel → Project Settings → Environment Variables (Production)**.

Or, if you have the Vercel CLI logged in + linked:

```bash
./run.sh env-push-vercel    # sync .env.local → Vercel + redeploy
```

The required production variables (mirrored from `.env.example`):

| Var | Source | Why |
|---|---|---|
| `DATABASE_URL`            | Supavisor pooler URL (see Registry section) | Server Action writes registry rows |
| `LIVE_AGENT_MODE`         | `mock` or `real` | Toggles the homepage demo source |
| `PAY_TO_ADDRESS`          | your 0x address | `/api/paid-endpoint` payee |
| `PAYMENT_CHAIN`           | `base-sepolia` or `goat-mainnet` etc. | Settlement chain |
| `PAYMENT_PRICE_MICRO_USDC`| `10000` ($0.01)  | Per-call price |
| `AGENT_DAILY_BUDGET_USD`  | `5` | Caps the Anthropic gateway in real mode |

### Option B — Docker (any VPS)

```bash
./run.sh docker          # build
./run.sh docker-run      # run on :3003 with .env.local
```

The Dockerfile uses Next.js `output: 'standalone'` mode (~150 MB final image).

## Routes

| Path | Purpose |
|---|---|
| `/` | Homepage + live agent cinematic |
| `/docs/quickstart` | 5-minute n-payment recipe |
| `/docs/n-payment` | n-payment integration guide (27 chains, 14 protocols) |
| `/portal` | Bundle catalog + email registry form |
| `/registry`, `/dashboard` | Sprint 3 stubs |
| `/.well-known/webmcp.json` | Machine-readable WebMCP manifest |
| `/.well-known/agent.json` | AgentCard |
| `/bundles.json` | Machine-readable bundle catalog (agent-discoverable) |
| `/api/agent` | SSE live-agent gateway |
| `/api/paid-endpoint` | x402 paywall |
| `/api/mcp` | JSON-RPC 2.0 MCP surface |
| `/api/v1/register` | Email-bundle registry submission |

## HyperMove v2.0 Platform Layer

Ship agent-callable endpoints with structured tracing + policy enforcement +
agentjacking defense in **one line of code**. All modules land behind a
single master flag `FEATURE_HM_PLATFORM` — rollback is a single env-var flip.

```ts
// Any Next.js Route Handler becomes fully instrumented:
import { wrapAgentEndpoint } from '@/lib/observability';
import { defaultSentinel } from '@/lib/sentinel';

export const GET = wrapAgentEndpoint({
  name: 'my.endpoint',
  sentinel: defaultSentinel(),
  handler: async (req) => { /* your handler unchanged */ },
});
```

Enable the platform layer:

```bash
export FEATURE_HM_PLATFORM=true
pnpm dev
```

Full API reference: [`docs/observability.md`](./docs/observability.md).

Optional Sentry-forward for enterprise buyers with existing Sentry setups:

```bash
export SENTRY_DSN=https://<key>@<org>.ingest.sentry.io/<project>
# HyperMove lazy-imports @sentry/nextjs — install it only if you enable this.
```

## MCP v4.0 — XRPL Ecosystem Native

The v3.0 XRPL/Flare/GOAT gateway (deep XRPL reads, Flare FTSO, builder briefs,
resources/prompts) now ships **on by default** — the old opt-in sub-flags
(`FEATURE_MCP_XRPL_V3`, `FEATURE_MCP_FLARE_V1`, `FEATURE_MCP_BUILDER_BRIEF`,
`FEATURE_MCP_RESOURCES`, etc.) are opt-**out** (`=false` to disable), matching
the v2.0 gateway's rollback discipline.

v4.0 adds four tools answering what the real XRPL ecosystem hubs (xrpl-ai.org,
aigent.run) show builders actually ask for:

| Tool | Answers | Flag |
|---|---|---|
| `xrpl.yield.compare` | "What's the best XRP/RLUSD yield right now?" — Soil vs Flare-Monarq vs Doppler, source-labeled | `FEATURE_MCP_XRPL_V3` |
| `xrpl.toolkit.list` | "How do I accept x402 on XRPL?" — 12-entry canonical SDK/CLI/facilitator directory | always on |
| `xrpl.hub.trending` | "What's trending on XRPL agentic payments?" — live hub index + amendment-vote status | `FEATURE_MCP_XRPL_V3` |
| `flare.fassets.bridgeStatus` | "How does XRP→FXRP bridging work?" — lifecycle + adoption stats | `FEATURE_MCP_FLARE_V1` |
| `xrpl.vault.info` / `xrpl.lending.status` | XLS-65/66 vault + lending state, gated by a live amendment-activation check (returns `amendment_not_active` instead of a raw RPC error while the amendment is still mid-vote) | `FEATURE_MCP_XRPL_V3` |

## T54 + XRPL — the settlement rail behind every RLUSD-priced tool call

Any tool call this gateway prices in RLUSD (currently: Dream Cycle's metered
extraction step, see [`docs/dream-cycle`](https://hypermove.xyz/docs/dream-cycle))
settles through **T54's XRPL x402 Facilitator** (`xrpl-x402.t54.ai`) — not a
credit card, not an API key, not a custodial wallet. The merchant-side rail
lives in `src/lib/mcp/npayment-rails.ts`'s `settleXrplRlusd()`; the buyer
signs everything client-side.

**Why RLUSD on XRPL, specifically:**

- **3-5 second finality, sub-cent fees.** XRPL closes ledgers every few
  seconds and fees are fractions of a cent — a payment step never becomes
  the slow part of an agent's tool call.
- **No API key, no custody.** The buyer signs a presigned XRPL `Payment`
  transaction with its own seed. T54 verifies and settles; it never holds
  buyer funds.
- **A real, growing rail.** XRPL recorded 1.43M+ autonomous agent x402
  transactions as of 2026-07-22 — up 127% since x402 was embedded directly
  into the ledger on 2026-06-09. Ripple joined the x402 Foundation as a
  Premier Member alongside 40 institutions. RLUSD itself carries a ~$1.26B
  market cap with NYDFS-regulated reserves — not a throwaway testnet token.

**The handshake, step by step (`settleXrplRlusd()`):**

1. The paywalled endpoint returns a 402 challenge: `payTo`, `network`
   (`xrpl:1` = testnet, `xrpl:0` = mainnet), `asset: RLUSD`, `amount`,
   `facilitator` URL, `invoiceId`.
2. The buyer signs an XRPL `Payment` itself — `SourceTag: 804681468`, an
   invoice-bound `Memo` (hex of `invoiceId`), RLUSD as its canonical 40-hex
   currency code. T54 never touches the buyer's keys.
3. HyperMove's merchant rail re-checks the buyer's echoed terms against the
   actual treasury/asset/price **before** ever calling the facilitator —
   underpayment or a swapped destination is rejected server-side, not
   trusted from the client.
4. T54's `/settle` endpoint verifies the signed blob against the ledger and
   broadcasts it. No API key exchanged anywhere in this chain.
5. **The ledger is the real proof of payment, not the facilitator's
   response.** In live testnet testing against this exact codebase, T54's
   hosted facilitator returned `verify_failed: unsupported_payment_features`
   on a genuinely successful payment — confirmed independently via a raw
   `tx` RPC query against `wss://s.altnet.rippletest.net:51233`
   (`TransactionResult: tesSUCCESS`, `validated: true`) and a matching
   before/after RLUSD trustline balance delta. Treat the facilitator as a
   convenience layer for the x402 handshake; the ledger's own validation is
   what actually proves the money moved.

Two independently-verified real testnet transactions from this exact
integration, checkable on [testnet.xrpl.org](https://testnet.xrpl.org):

- [`D7DFA2D617B306D305CBE490041FAA7961182F3DC150E231D9C23E1AB2DEE780`](https://testnet.xrpl.org/transactions/D7DFA2D617B306D305CBE490041FAA7961182F3DC150E231D9C23E1AB2DEE780) — 0.05 RLUSD
- [`FF216AE38CF44D1F12B48C5A5345D4CDCF1E4D40528CC44EB8256BBC4CA24418`](https://testnet.xrpl.org/transactions/FF216AE38CF44D1F12B48C5A5345D4CDCF1E4D40528CC44EB8256BBC4CA24418) — 0.05 RLUSD

Full writeup with the Dream Cycle context: [`docs/posts/dream-cycle-rlusd-t54-xrpl-agent-payments.md`](./docs/posts/dream-cycle-rlusd-t54-xrpl-agent-payments.md).

Try the settlement path yourself (real XRPL testnet transaction, zero mock):

```bash
RLUSD_DEMO_MODE=live RLUSD_DEMO_SEED=sEd... npx tsx scripts/demo-t54-rlusd-dream-cycle.ts
# or: copy scripts/.env.rlusd-demo.example -> scripts/.env.rlusd-demo (git-ignored)
# and fill in RLUSD_DEMO_SEED once — then just `npx tsx scripts/demo-t54-rlusd-dream-cycle.ts`
```

Required env vars, config knobs, and troubleshooting: `scripts/demo-t54-rlusd-dream-cycle.ts`'s header comment.

## Dream Cycle on Flare FCC — confidential extraction via HyperMove's own TEE extension

Dream Cycle's extraction step can optionally route through **HyperMove's own Flare
Compute Extension (FCE)** — a real, deployed `InstructionSender` contract + Go
`tee-proxy`/`extension-tee` pair on Coston2 — instead of calling `services/llm` directly.
Opt in with `start_dream({..., config: {confidential: true}})`, gated by
`FEATURE_MCP_DREAM_CONFIDENTIAL=true` (default OFF). Full usage: [`/docs/dream-cycle`](https://hypermove.xyz/docs/dream-cycle#confidential-extraction-on-flare-fcc-opt-in-real-coston2-deployment).

**What "confidential" honestly means:** this ships TEE-attested dispatch + result
signing, not "the LLM call itself runs inside a TEE" — the token generation still
happens in the same non-TEE `services/llm` process, reached over the network. Genuinely
different from a system that ran the LLM inference itself inside a Confidential VM; don't
read more into "confidential" than that.

**Real, independently verifiable, live on Coston2:**

| What | Where to check |
|---|---|
| `HyperMoveInstructionSender` contract | `0xB4864BB622F3020a5d424ff2CC20738b3327f7E2` — `eth_getCode` against `https://coston2-api.flare.network/ext/C/rpc` returns real bytecode |
| Extension registration | `EXTENSION_ID = 0x101e4` (decimal 66020), `setExtensionId()` confirmed on-chain |
| Public TEE-proxy endpoint | `https://hypermove.duckdns.org/tee-proxy/info` — a real, signed `TeeInfoResponse` |
| MCP tool reaching the contract | `flare.instruct.dispatch` — real on-chain calls, real revert reasons surfaced verbatim, never a fabricated success |

**The honest current limit:** completing on-chain TEE-machine registration
(`register-tee`) requires a real Google Confidential Space attestation JWT. This
deployment runs under `SIMULATED_TEE=true` (no GCP Confidential VM requested) — its
attestation value is `magic_pass`, a real, documented Google-Cloud-SDK "testing outside
the cloud" sentinel, not a cryptographic quote. `confidential.ts`'s real Phala Cloud
verification call correctly, honestly rejects it — this is the expected, documented
boundary of a `SIMULATED_TEE` dev deployment, not a bug. `start_dream({confidential:
true})` reports the honest `fcc_dispatch_failed` outcome (zero cost charged) until real
TEE hardware is available; `flare.instruct.dispatch` still reaches the real deployed
contract and surfaces the real on-chain state at every step.

Deployed as native Go binaries under PM2 on the same VPS as `hypermove-app`/`llm-service`
— no Docker, no ngrok. Self-hosted MySQL + Redis + Flare's own `flare-system-c-chain-indexer`
back the TEE-proxy's on-chain sync requirement; a third Caddy route
(`/tee-proxy/* → localhost:6664`) exposes it publicly, mirroring the existing `/llm/*`
route. Full deployment story — every real bug found and fixed, the exact dependency
chain, and the precise resume point at the attestation-hardware boundary — is documented
in [`services/tee-extension/README.md`](./services/tee-extension/README.md).

## Architecture

- **Framework:** Next.js 14 App Router · TypeScript strict · Tailwind · MDX
- **Design tokens:** see `tailwind.config.mjs` — sourced from `hypermove-UI/hypermove/DESIGN.md`
- **SDKs (npm):** [`n-payment@0.29.1`](https://www.npmjs.com/package/n-payment) (dynamic import, optional)
- **Database:** Postgres (Supabase) via `pg` driver, lazy pool
- **Tests:** Vitest + Testing Library
- **Tracking:** `tracking/task-log.json` + `pnpm report`

## Links

- [npm · n-payment](https://www.npmjs.com/package/n-payment)
- [GitHub · phamdat721101](https://github.com/phamdat721101)
- [Book a demo · Calendly](https://calendly.com/phamdat721101/30min)
