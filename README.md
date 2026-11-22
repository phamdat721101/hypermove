# hypermove-app

> **`hypermove.xyz`** — make any web3 dApp agent-callable. Monetize in 5 minutes with x402-USDC.
> Open-source, MIT-licensed, built on [`n-payment`](https://www.npmjs.com/package/n-payment).

Standalone Next.js 14 implementation of the HyperMove consolidation surface. The homepage IS the demo — an AI agent visiting the site reads `.well-known/webmcp.json`, hits a $0.01 `payment.x402` paywall, signs through n-payment, and renders a 200 OK — all in-page.

## Public flashloan research MCP

Connect an MCP agent to **https://mcp.overguild.com** with **no authentication**.
The canonical public path is `/api/mcp/flashloan`. No account, wallet signature,
API key, Authorization header, cookie or MCP session ID is required.

This public API is stateless: tools return data directly. Send the returned inline
snapshot or plan unchanged into the next tool. There are no public background
jobs, stored private artifacts or research-memory writes. A server-generated
integrity proof prevents tampering with snapshots and plans; it is automatic and
is not a client credential.

| Service | Endpoint |
|---|---|
| Public stateless MCP | `https://mcp.overguild.com` or `/api/mcp/flashloan` |
| Authenticated gateway and owned-job API | `https://mcp.overguild.com/api/mcp` |
| Gateway health | `https://mcp.overguild.com/api/mcp/health` |
| LLM API | Stopped on this VPS; `/llm/*` returns HTTP 410 |

The VPS runtime is focused on flashloan research. Dream Cycle tools and its
scheduler are disabled, together with LLM-dependent news, agentic and builder
brief tools. The separate LLM process is stopped, so UI scan and content
generation are unavailable on this deployment. The UI and flashloan gateway
remain online.

The authenticated API retains its original ownership, payment and memory behavior.
Its existing Supabase tenant/user binding needs repair for normal wallet/device
sign-in; public flashloan calls do not consult that identity database. Root
requests carrying Authorization or X-MCP-Admin-Token remain on the authenticated
gateway for compatibility; omit those headers to use public root access.

### Connect and discover

After `pnpm install`, save this as `flashloan-client.mjs` in the repository root
and run `node flashloan-client.mjs`:

```js
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const client = new Client({ name: 'flashloan-research', version: '1.0.0' });
await client.connect(new StreamableHTTPClientTransport(
  new URL('https://mcp.overguild.com'),
));
async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const response = result.structuredContent ?? JSON.parse(
    result.content.find((item) => item.type === 'text').text,
  );
  if (result.isError || !response.ok) throw new Error(JSON.stringify(response.error));
  return response.data;
}
try {
  console.log(await call('flashloan_capabilities'));
  console.log(await call('flashloan_discover_arbitrage_pools', {
    network: 'base',
    tokens: ['0x4200000000000000000000000000000000000006'],
  }));
} finally {
  await client.close();
}
```

### Research tools and inline workflow

| Tool | Input → direct output |
|---|---|
| `flashloan_capabilities` | `{}` → networks, reviewed deployments, effective limits and verification constraints |
| `sui_ingest_pool_state` | Reviewed Move pools/lender → proven checkpoint snapshot |
| `sui_solve_arbitrage_routes` | Proven snapshot and funding policy → bounded native PTB research |
| `sui_simulate_ptb` | Proven plan → native dry-run, residuals, gas and repayment evidence |
| `flashloan_discover_arbitrage_pools` | Network, tokens, filters → all observed pools, eligibility, coverage and diagnostics |
| `flashloan_ingest_l2_tickmap_and_reserves` | Reviewed pools and lender → proven block-pinned snapshot |
| `flashloan_solve_dynamic_route_split` | `snapshot`, borrow asset, risk policy → proven feasible plan or explicit research outcome |
| `flashloan_simulate_atomic_revm` | `plan`, caller, executor mode/address → repayment/revert and reference dry-run report |
| `xrpl_discover_arbitrage_routes` | Native assets and account/hypothetical funding → proven ledger snapshot with estimated routes |
| `xrpl_simulate_arbitrage_route` | `routes` and optional unsigned transaction → estimate or native dry-run report |

Discovery inventory and liquidity eligibility do not establish a valid route. Start with capabilities and
select only reviewed deployments whose runtime hashes pass verification.
Place the following inside the example’s `try` block, before `client.close()`:

```js
const asset = '0x4200000000000000000000000000000000000006';
const snapshot = await call('flashloan_ingest_l2_tickmap_and_reserves', {
  network: 'base',
  pools: [
    { address: '0xd0b53d9277642d899df5c87a3966a349a798f224', adapter: 'UNISWAP_V3', word_range: 0 },
    { address: '0x6c561b446416e1a00e8e93e221854d6ea4171372', adapter: 'UNISWAP_V3', word_range: 0 },
  ],
  lender: { provider: 'AAVE_V3', address: '0xa238dd80c259a72e81d7e4664a9801593f98d1c5', asset },
});
const result = await call('flashloan_solve_dynamic_route_split', {
  snapshot,
  borrow_asset: asset,
  policy: { max_principal: '10000000000000000', network_cost: '100000000000000' },
});
if (result.kind === 'evm_plan') {
  const report = await call('flashloan_simulate_atomic_revm', {
    plan: result,
    caller: '0x1111111111111111111111111111111111111111',
    executor_mode: 'fixture',
    executor: '0x000000000000000000000000000000000000f1a5',
  });
  console.log(report);
} else {
  console.log(result.status); // NO_OPPORTUNITY or INCONCLUSIVE is a valid outcome.
}
```

Amounts use exact decimal **strings in raw token units**, not JSON numbers or USD.
The cost above is an explicit research assumption. Public requests do not accept
`idempotency_key`, owned artifact IDs, job polling or memory operations. Inline
proofs expire after ten minutes, cannot be modified and become invalid when the
reviewed configuration changes; fetch a new snapshot when rejected.

Success envelopes contain `schema_version`, `request_id`, `operation`, `ok`,
`data`, `warnings` and `execution: false`. Errors use `isError: true` and a typed
`error` with `code`, `message`, `retryable` and, when relevant, `retry_after_ms`.
Handle `INVALID_PROOF`, `PROOF_EXPIRED`, `REORG`, `RATE_LIMITED`,
`CAPACITY_EXCEEDED`, incomplete tick coverage and dependency timeouts explicitly.
Do not treat an error or an inconclusive report as an empty profitable result.

### Limits and verification

Defaults: 30 discovery tokens, four EVM pools, at most one bitmap word on either
side, 2,000 initialized ticks, four XRPL assets, three sizing routes and 500
sizing evaluations. Each IP can submit six computations and 60 transport requests
per minute. One public computation can run at once, sharing a two-slot worker
budget with authenticated jobs. Capacity exhaustion returns a retryable error;
there is no public queue. Bodies are capped at 2 MiB, and integrity envelopes at
1 MiB; MCP's repeated text/structured representation also counts toward the wire
budget. Reduce pool/tick coverage if a response exceeds the limit.

Ordinary operations have a 30-second deadline; EVM simulation has 60 seconds.
CPU searches run in isolated worker threads with a five-second search budget.
The public API persists no request bodies, snapshots, plans or research memory.
All public users can replay a valid inline payload; proofs establish provenance,
not private ownership. Avoid placing secrets in requests.

Research never signs or broadcasts. Generic Cancun simulation is not complete
ArbOS/OP Stack/later Ethereum verification. `chain_native_verified` and
`can_execute` remain false. XRPL account-backed and hypothetical funding stay
separate; native dry-runs use the node's simulation ledger, not a historical
snapshot execution guarantee. No profitable opportunity is guaranteed.

### Pool coverage v2 and new chains

Discovery uses token-pairs enumeration and returns all observed pools, including
single/low-liquidity markets and opaque v4 IDs. Coverage is provider-scoped;
`complete` and filtered `candidates/rejected` have been replaced by `pools`,
`token_results`, `coverage` and `diagnostics`. Public schema is v3 and proofs remain
v2; update gateway and worker together. Eleven public tools include Sui snapshot, sizing
and PTB simulation. Robinhood (4663) supports reviewed Uniswap v3/v4 adapters;
Sui uses Cetus/DeepBook through the official SDK on Node 22.12+.

New chain research stays disabled without matching build/registry-bound live
verification evidence. Discovery works independently. See the [coverage feature
contract](docs/features/flashloan-pool-coverage.md) for schemas, limits, setup,
verification levels and rollback. Run `pnpm flashloan:multichain-test`,
`pnpm flashloan:move-test` and opt-in `pnpm flashloan:multichain-live`.

### Self-host the public worker

Requires Node 20.19+ or 22.12+, Rust/Cargo, Foundry and the existing worker's
PostgreSQL queue for authenticated jobs. Public computations bypass its repository.

```bash
pnpm install
cp services/flashloan/.env.example services/flashloan/.env
# Configure server-only worker token, PostgreSQL, HTTPS RPC endpoints and registry.
# Enable FEATURE_MCP_FLASHLOAN_PUBLIC_STATELESS=true in worker and gateway envs.
# Generate a separate random FLASHLOAN_PUBLIC_ARTIFACT_KEY (32+ bytes) for the worker.
pnpm flashloan:build
bash services/flashloan/start.sh
# In another terminal, configure .env.local and run pnpm dev.
```

Gateway configuration:

```dotenv
FEATURE_MCP_FLASHLOAN_PUBLIC_STATELESS=true
FLASHLOAN_WORKER_URL=http://127.0.0.1:3012
FLASHLOAN_WORKER_TOKEN=<same-server-only-worker-token>
FLASHLOAN_TRUST_PROXY=false
NEXT_PUBLIC_MCP_HOST_URL=https://mcp.overguild.com
NEXT_PUBLIC_LLM_API_URL=https://mcp.overguild.com/llm
```

Locally connect to `http://localhost:3003/api/mcp/flashloan`. In production, bind
the app to loopback, overwrite `X-Flashloan-Client-IP` at the trusted reverse proxy,
and then set `FLASHLOAN_TRUST_PROXY=true`. Configure browser origins with
`FLASHLOAN_PUBLIC_ORIGINS`; agents without Origin headers are supported.
Never expose the worker port or put server credentials in `NEXT_PUBLIC_` variables.

`FLASHLOAN_PUBLIC_MAX_TOKENS`, `MAX_POOLS`, `MAX_TICKS`, `MAX_XRPL_ASSETS`,
`MAX_ROUTES`, `MAX_EVALUATIONS`, `COMPUTATIONS_PER_MINUTE`,
`TRANSPORT_PER_MINUTE`, `OPERATION_MS`, `SIMULATION_MS` and `PROOF_TTL_MS`
(each with the `FLASHLOAN_PUBLIC_` prefix) can lower the tested ceilings. Keep
matching limit configuration on the gateway and worker. Invalid values fail
configuration rather than silently increasing resource budgets.

Run `pnpm flashloan:public-e2e` for credential-free SDK, integrity and isolation
checks. `pnpm flashloan:native-e2e` exercises public and private Anvil/Rust
repayment and rejection cases. Existing authenticated verification commands remain
available: `pnpm flashloan:test`, `pnpm flashloan:e2e`,
`pnpm flashloan:postgres-e2e` and `pnpm flashloan:live`.

The deployed `flashloan.public.v3` catalog adds `flashloan_get_token_movers`: up to
ten tokens per Base, Arbitrum, Robinhood or Sui chain with at least ±10% reported
24h movement. Defaults require $15,000 market liquidity and a market age of 24h.
Results rank a bounded free DexScreener scan, with explicit non-exhaustive coverage;
returned token identifiers compose with pool discovery. See the public feature
specification for input/output contracts. Run `pnpm exec vitest run
tests/flashloan-movers.test.ts`; set `FLASHLOAN_MOVERS_LIVE=1` for opt-in live checks.
Release `worktree-movers-5c3499ba3e74` was deployed on 2026-10-28 and verified by
real HTTPS SDK clients against both public paths; the worker guide records the
current runtime and retained rollback release.

Read the [worker/deployment guide](services/flashloan/README.md),
[public feature specification](docs/features/flashloan-public-stateless.md), and
[public schemas](src/lib/mcp/flashloan/public-contracts.ts).

## Earlier milestones

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

`/portal` email-bundle requests use Postgres via a Next.js Server Action (`src/app/portal/actions.ts`). The schema is auto-created idempotently on first write — see `src/lib/db.ts`. Configure a working database via `DATABASE_URL` in `.env.local`; see the current deployment limitation above.

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
| `tls_failed`        | Check the provider CA and hostname. The research worker verifies TLS; configure its trusted CA rather than disabling verification. The legacy registry pool has separate TLS behavior. |

## Deploy

### Current production — VPS with PM2 and Caddy

The MCP gateway and research worker run from
`/home/ubuntu/hypermove-public-release`. Caddy terminates HTTPS at
`mcp.overguild.com`; the worker remains on loopback port 3012 and is not exposed
directly. Provision server-only environment files before deploying:

```bash
VPS_SSH_KEY=/path/to/your-private-key.pem \
  bash scripts/deploy-vps.sh --app-only --with-flashloan
```

The script builds the native worker on the target OS. Set `APP_REMOTE_DIR` or
`PUBLIC_BASE_URL` to override the installed release path or public domain.
The active gateway and worker use Node 22.15.0 from
`/home/ubuntu/.local-node22/node_modules/node/bin`; use that runtime for target
builds and PM2 environment updates. Preserve the explicit Dream/LLM feature
flags and the persisted `/llm/*` HTTP 410 route when deploying this profile.
The [worker guide](services/flashloan/README.md) records the deployed topology,
rollback locations and verification limits. The alternatives below describe
other app deployments; a standalone app deployment does not provision the
research worker automatically.

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

### Which settlement flow do I use? (`payments.settle`'s `proof` field, XRPL)

`payments.settle`'s `proof` parameter accepts **two different shapes** for
XRPL chains (`xrpl-mainnet`/`xrpl-testnet`) — this was previously undocumented
and a real source of confusion (see
`docs/prd/xrpl-rlusd-settlement-gap-2026-08-10.md` for the full incident this
section closes). Pick the one that matches how you actually paid:

**(a) Facilitator-relay envelope** — you have a *signed but not yet
broadcast* XRPL `Payment`, and want T54's facilitator to submit it on your
behalf. `proof` is the base64 PAYMENT-SIGNATURE envelope
(`np.decodePaymentSignatureHeader()`'s expected shape):

```ts
proof: Buffer.from(JSON.stringify({ accepted: { payTo, asset: 'RLUSD', amount }, /* ...signed blob */ })).toString('base64')
```

**(b) Already-submitted transaction hash** — you signed AND submitted the
`Payment` directly yourself (e.g. via `rpc.submitAndWait()`, exactly what
`scripts/demo-t54-rlusd-dream-cycle.ts` does and this README's own published
tx hashes above come from), confirmed `tesSUCCESS`/`validated:true` on your
own. `proof` is a JSON string naming that transaction — HyperMove
independently re-verifies it on-ledger (validated + tesSUCCESS + correct
destination + correct asset + amount) before granting the paid session.
Never trusted from the caller's claim alone:

```ts
proof: JSON.stringify({ txHash: 'C9C74C7B59B02F99556D3E0EF0DB5B4AA4ECE9A1672F899BD66281A918C00B3B' })
```

A given `txHash` can only unlock **one** paid session — a second settlement
attempt with the same hash is rejected (`code: "already_redeemed"`).

Submitting a bare transaction hash where the facilitator-relay envelope is
expected (or vice versa) now returns a specific `wrong_proof_shape` error
naming the mismatch, instead of a generic decode failure.

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
route. These are earlier TEE integration notes; the extension source and its
deployment guide are maintained separately from this app checkout. The current
flashloan deployment and its verified boundaries are documented above.

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
