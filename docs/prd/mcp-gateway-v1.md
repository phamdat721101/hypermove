# PRD — HyperMove MCP Gateway v1.0 ("Agent Connectivity iOS")

**Status:** implemented (mock-first, behind `FEATURE_HYPERMOVE_MCP_GATEWAY_V1`) · **Owner:** Pham · **Date:** 2026-07-10

## 1. Problem & objective
Agents cannot discover + use cross-chain web3 data, news, and payment through one
surface. Alchemy MCP is Alchemy-only, QuickNode MCP is QuickNode-only, Moralis has
no MCP, Raven is Stellar-only. **Objective:** ship one hosted MCP endpoint that
aggregates all of them, adds daily news + AI insight, and meters per-query payment
on the agent's chosen network — copying Raven's auth + envelope + search pattern.

## 2. Scope
**In (v1.0):** WorkOS auth (3-layer gate), 10-free/24h tier, tiered x402/MPP paywall
with multi-chain selection, 3 data adapters (mock-first) + router, hybrid lexical+vector
search, daily news + LLM insight, discovery tools, call ledger, deterministic refresh.
**Deferred (v1.1):** `execute` sandbox + Cloudflare Worker, real-time `stream.subscribe`,
Chroma, artifact R2, skills.

## 3. Architecture (as built)
`src/lib/mcp/` — one module tree. Shared `envelope.ts` (ServiceResult + guard prelude)
reused by every provider/tool/rail (no duplication). Interfaces: `DataProvider`,
`NewsProvider`, `Embedder`, `VectorStore`, `PaymentRail`, `InsightSynthesizer` — each
with a deterministic mock default (mock-first). Pipeline in `gateway.ts`:
`auth → (paid-session | rate-limit | pay) → tool → mcp_calls ledger`. Route branches on
the master flag; flag-off = byte-identical legacy behavior.

**Deviations from research (approved-by-constraint):** vector store is in-process cosine
over JSONB embeddings (no `CREATE EXTENSION vector` → simpler deploy); pgvector is an
Open/Closed swap behind `VectorStore`. Payment rails are `MockPaymentRail`; n-payment
adapters swap behind `PaymentRail`.

## 4. Acceptance criteria → verification
| # | Criterion | Verified by |
|---|---|---|
| A1 | Flags default off; sub-flags gated by master | `platform-flag` + gateway tests (flag-off legacy) |
| A2 | Envelope guard throws on wrong-level access | `mcp-gateway.test.ts › envelope contract` |
| A3 | Router routes by chain/method + falls back to mock | `› provider router` |
| A4 | Real adapters delegate to mock when key absent | `providers/real.ts` (call → mock when no env key) |
| A5 | Catalog deterministic + sorted | `› catalog` |
| A6 | Lexical search ranks; unknown filter → valid-options hint | `› lexical search` |
| A7 | Embeddings deterministic; vector store cosine-ordered | `› embeddings + vector store` |
| A8 | Hybrid search + vector.search return hits | `› hybrid search tool` |
| A9 | News search + AI insight (mock) work | `› news layer` |
| A10 | 3-layer auth gate (anon/admin/loopback/401) | `mcp-route.test.ts › auth gate` |
| A11 | Free-tier metering + admin bypass | `› gateway pipeline` |
| A12 | Multi-chain selection settles; bad network → hint | `› multi-chain settlement` |
| A13 | Discovery: spec/describe/payments.networks | `mcp-gateway.test.ts › discovery tools` |

Run: `pnpm mcp:smoke` (30 tests) · `pnpm mcp:refresh` (determinism) · `pnpm build`.

## 5. Ship-gate (doc-05, 5-of-9 to flip)
1. Master flag flips both ways in <60s, no data loss — **flag-off legacy path tested (A1)**.
2. End-to-end: auth → search → free tier → paid tier → settle — **A10–A12**.
3. 3 providers wired with fallback — **A3/A4**.
4. Vector search relevant for canonical queries — **A7/A8**.
5. Envelope contract on all responses — **A2**.
6. Rate-limit survives load, no bypass — **rate-limit.ts rolling-window (load test pending real DB)**.
7. Launch post + partnership DM — **ops (out of code scope)**.
8. News: ranked daily items + insight for canonical projects — **A9**.
9. Network discovery + settle on ≥2 networks; bad network errors — **A12/A13**.

Code-verifiable gates (1–5, 8, 9) pass in CI. Gates 6 (load) + 7 (comms) are ops steps.

## 6. Rollback
`FEATURE_HYPERMOVE_MCP_GATEWAY_V1=false` → redeploy. Sub-flags allow partial rollback.
No schema drops. See `docs/mcp-gateway.md` runbook.
