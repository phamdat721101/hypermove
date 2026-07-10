# PRD — HyperMove MCP Gateway v2.0 ("Real MCP + Stellar/XRPL + Agentic")

**Status:** implemented (ships ON by default; disable per-flag) · **Owner:** Pham · **Date:** 2026-07-10

## 1. Problem & objective
v1.0 exposed a hand-rolled JSON-RPC endpoint at `/api/mcp` that *mimicked*
`tools/list` / `tools/call` but implemented no MCP handshake, capabilities,
sessions, or Streamable-HTTP transport — so native MCP clients (Claude Desktop,
Cursor, MCP Inspector, agent SDKs) could not connect. It also had no live
Stellar/XRPL data (the `AdapterRouter` was wired to nothing), no payment
settlement over MCP, and no agentic tools.

**Objective:** make `/api/mcp` a *real* MCP server; give agents live Stellar +
XRPL data, real-time news + insight, and agentic "analyze → ideate → skillify"
tools; and settle per-query payment over MCP via the **n-payment** SDK — all
clean, SOLID, mock-first, and ON by default with single-flag rollback.

## 2. Product context (for agents)
HyperMove is the one MCP endpoint that aggregates cross-chain web3 read data
(EVM via Moralis/Alchemy/QuickNode, **Stellar** via Horizon+Soroban, **XRPL**
via public JSON-RPC), layers daily news + AI insight, exposes agentic
meta-tools, and meters usage with x402/MPP payment settled by n-payment. Agents
discover it via `/.well-known/webmcp.json`, connect over Streamable HTTP, get 10
free queries/24h, then pay per tier.

## 3. Architecture (as built)
Every v1 SOLID seam is preserved. The tool registry (`tools.ts`) is the single
source of truth; the transport iterates it. `gateway.callTool` stays the single
metering/ledger/dispatch seam.

```
MCP client → mcp-handler (Streamable HTTP) → withMcpAuth (→ McpSession)
  → gateway.callTool (free-tier meter · paid-session · ledger)
    → tool: search | news | data.call → buildRouter.dispatch → {EVM|Stellar|XRPL}
                                      | payments.settle → n-payment rail
                                      | insight.roadmap | ideas.generate | skillify
```

**New/changed files (essential only):**
- `src/lib/mcp/server.ts` (NEW) — builds the MCP server from the registry via
  `mcp-handler` (official `@modelcontextprotocol/sdk`), bridges auth → session,
  dispatches through `callTool`. Route delegates to it; flag-off = legacy.
- `src/lib/mcp/npayment-rails.ts` (NEW) — real settlement rail (EIP-3009
  `transferWithAuthorization` via viem + n-payment); isolates the optional SDK.
- `src/lib/mcp/agentic.ts` (NEW) — `insight.roadmap` / `ideas.generate` /
  `skillify`, grounded in catalog + news, LLM-optional.
- `providers/real.ts` — keyless `HttpProvider` mode + `createStellar` /
  `createXrpl` (one shared base, no duplication).
- `providers/router.ts` — route `stellar`→stellar, `xrpl`→xrpl.
- `providers/index.ts` — register Stellar/XRPL under `FEATURE_MCP_DATA_ADAPTERS_V1`.
- `tools.ts` — `data.call`, `payments.settle`, `payments.status`, agentic tools;
  `ToolContext` (session injection) + `unmetered` (payments can't deadlock).
- `paywall.ts` — `settleSelection` core (MCP path) + credential-driven guard.
- `payment-router.ts` — `selectRail` returns real n-payment rail when configured.
- `catalog.ts` — Stellar/XRPL operations in the manifest.
- `platform-flag.ts` — MCP flags default **ON** (explicit `=false` to disable);
  new `FEATURE_MCP_AGENTIC_V1`.

## 4. Payment settlement over MCP (n-payment)
1. A metered call over the free-tier limit returns an MCP error whose `data`
   carries the x402 challenge (chains × rails × assets × tier prices).
2. The agent calls **`payments.settle`** `{ tier, chain, rail, asset, proof }` —
   an *unmetered* tool. `proof` is the base64 EIP-3009 authorization the agent
   signed to `PAY_TO_ADDRESS`.
3. `settleSelection` → `selectRail`. When `MCP_FACILITATOR_PRIVATE_KEY` +
   `PAY_TO_ADDRESS` are set, the **real n-payment rail** broadcasts
   `transferWithAuthorization` from the facilitator wallet (agent pays gaslessly);
   otherwise a deterministic mock rail (dev). A paid session bundling 100 queries
   opens; subsequent calls consume it via `findActiveSession`/`consumeSession`.
4. **Safety:** the mock rail NEVER grants a paid session in production — real
   settlement is the only unlock in prod. Missing config / failed verify →
   honest `fail`, never a fabricated receipt.

Real x402 settlement supports base / base-sepolia / arbitrum / optimism /
polygon (native USDC). Stellar MPP + XRPL RLUSD rails are the next adapters.

## 5. Ship-on-by-default & rollback
All MCP flags default ON (`FEATURE_HYPERMOVE_MCP_GATEWAY_V1`, `_AUTH_WORKOS`,
`_RATE_LIMIT`, `_PAYWALL`, `_DATA_ADAPTERS_V1`, `_VECTOR_SEARCH`, `_NEWS_V1`,
`_AGENTIC_V1`). Rollback: set the relevant `FEATURE_...=false` and redeploy;
the master flag off restores the byte-identical legacy 2-tool endpoint.
Live news uses `NEWS_LIVE=true` (curated Stellar/XRPL feeds) or `RSS_FEEDS`;
default is deterministic mock.

## 6. Acceptance criteria → verification
| # | Criterion | Verified by |
|---|-----------|-------------|
| B1 | `/api/mcp` speaks real MCP (initialize handshake, Streamable HTTP) | live curl: `initialize` → `protocolVersion`+`serverInfo`; `tools/list` → 15 tools |
| B2 | Registry drives the server; auth bridged to session | `tests/mcp-v2.test.ts › real MCP transport` |
| B3 | Stellar + XRPL adapters + routing + catalog | `› Stellar + XRPL adapters` |
| B4 | `data.call` wired to the router | tool registered + dispatch (mock-first) |
| B5 | Payment settles over MCP via n-payment; opens paid session | `› payment settlement over MCP` + mock-rail session |
| B6 | Prod-mock refusal; credential-driven real rail | `settleSelection` guard |
| B7 | Agentic tools grounded + deterministic | `› agentic meta-tools` |
| B8 | Flags default on; `=false` disables | `platform-flag` semantics + legacy path |

Run: `pnpm mcp:smoke` (30) · `pnpm vitest run tests/mcp-v2.test.ts` (11) ·
`pnpm typecheck` · `pnpm build`.

## 7. Config (env)
| Var | Purpose | Default |
|-----|---------|---------|
| `FEATURE_HYPERMOVE_MCP_GATEWAY_V1` | master flag | on (`=false` to roll back) |
| `PAY_TO_ADDRESS` | merchant payee (enables real settlement) | — |
| `MCP_FACILITATOR_PRIVATE_KEY` | facilitator wallet broadcasting settlement | — |
| `RPC_URL_<CHAIN>` | override RPC per chain (e.g. `RPC_URL_BASE_MAINNET`) | public |
| `STELLAR_HORIZON_URL` / `SOROBAN_RPC_URL` | Stellar endpoints | SDF public |
| `XRPL_RPC_URL` | XRPL JSON-RPC | xrplcluster.com |
| `NEWS_LIVE` / `RSS_FEEDS` | live news feeds | mock |
| `LLM_API_URL` | LLM insight service (agentic prose) | mock synth |

## 8. Rollback
`FEATURE_HYPERMOVE_MCP_GATEWAY_V1=false` → redeploy (legacy endpoint). No schema
drops. Sub-flags allow partial rollback. n-payment is a server-external package
(`next.config.mjs`) — absent creds → mock rail, no behavior change.
