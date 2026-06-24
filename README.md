# hypermove-app

> **`hypermove.dev`** — make any web3 dApp agent-callable. Monetize in 5 minutes with x402-USDC.
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
| `tenant_not_found`  | Wrong shard (`aws-0` vs `aws-1`) or wrong region in the pooler URL.                     |
| `auth_failed`       | Password rotated, or `postgres.<project-ref>` tenant prefix missing from the username.  |
| `connection_refused`| Pooler port is `6543` (not `5432`) for Transaction mode.                                |
| `tls_failed`        | Provider requires `ssl=true`; `db.ts` enables `rejectUnauthorized:false` automatically when host contains `supabase`. |

## Deploy

### Option A — Vercel

```bash
vercel deploy
```

Set `DATABASE_URL` + `LIVE_AGENT_MODE` in Vercel project env vars.

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
| `/pricing` | 3-tier USDC-only pricing |
| `/portal` | Bundle catalog + email registry form |
| `/registry`, `/dashboard` | Sprint 3 stubs |
| `/.well-known/webmcp.json` | Machine-readable WebMCP manifest |
| `/.well-known/agent.json` | AgentCard |
| `/bundles.json` | Machine-readable bundle catalog (agent-discoverable) |
| `/api/agent` | SSE live-agent gateway |
| `/api/paid-endpoint` | x402 paywall |
| `/api/mcp` | JSON-RPC 2.0 MCP surface |
| `/api/v1/register` | Email-bundle registry submission |

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
