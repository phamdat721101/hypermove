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

`/portal` email-bundle requests are persisted to Postgres (Supabase project on `db.boopiufnqyrwzvyrjens.supabase.co`). The schema is auto-created idempotently on first write — see `src/lib/db.ts`. Configure via `DATABASE_URL` in `.env.local`.

### Networking note

Supabase's **direct** Postgres host (`db.<project>.supabase.co`) is IPv6-only on free tier. `src/lib/db.ts` calls `dns.setDefaultResultOrder('ipv6first')` so this works on Vercel and most cloud VPS providers (they have IPv6 routing).

On an IPv4-only network (e.g. some local ISPs), switch to the **transaction pooler** URL from your Supabase dashboard. Format:

```
postgresql://postgres.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
```

Drop that into `DATABASE_URL` and the writer works over IPv4.

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
