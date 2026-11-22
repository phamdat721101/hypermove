# PRD: Paid Market-Implied Probability Feed on the Flashloan MCP (x402: Base, Arbitrum, XRPL)

| | |
|---|---|
| Version | 1.0.0 (PRD only, no code) · 2026-11-10 |
| Status | **Ready for implementation planning.** Owner gates G-1 to G-4 (§15) must clear before a paid launch. |
| Owner | Pham (product owner) |
| Target repo | `hypermove/hypermove-app` (this file is exported to the repo root) |
| Source of truth | `bd-team/research/hypermove/2026-11-10-probability-feed-x402-prd/` |
| Serves | HyperMove (iOS layer): a paid agent-callable endpoint. Feeds the OpenX listing and the future hedge agent. |

**How an agent should use this file:** read §0–§3 for intent and boundaries, implement in the task order of §14, check every task against the acceptance criteria and the §12 test IDs, and stop at any owner gate in §15.

---

## 0. Owner decisions (locked 2026-11-10)

| ID | Decision |
|---|---|
| D-1 | Build on the **flashloan MCP module** (`src/lib/mcp/flashloan/`), reusing its network reads (`evm.ts` for Base/Arbitrum/Robinhood, `sui.ts`, `xrpl.ts`), `transport.ts`, `admission.ts` and the result envelope. **Do not use n-payment** for this feature. |
| D-2 | Add a **new paid endpoint `/api/mcp/flashloan/paid`**. The public `/api/mcp/flashloan` catalog stays free, stateless and unmetered, and its invariant ("never authenticates, meters, reads owned artifacts or writes knowledge") is unchanged and test-enforced (T-INV-1). |
| D-3 | **Settlement uses each ecosystem's own SDK, on Base, Arbitrum and XRPL only.** Base and Arbitrum use the Coinbase x402 v2 SDK (`@x402/*`). XRPL uses the XRPL AI / t54.ai x402 facilitator over HTTP (no npm package exists). |
| D-4 | **Robinhood (eip155:4663) and Sui** are `planned`. Probability reads may be listed in capabilities, but paid calls on those networks are refused with `NETWORK_PAYMENT_UNSUPPORTED`. Never mock a payment. |
| D-5 | Prediction trading is stopped (owner, 2026-11-10). This feature **reads** venue data only and never places, cancels or redeems orders. |

## 1. Product brief (nim-deliver)

### 1.1 Client outcome
An AI agent (risk bot, DeFi keeper, content agent, OpenX concierge) makes **one MCP tool call** and receives a **clean, quality-flagged, market-implied probability** for a short-horizon crypto event, for example "P(ETH ≥ 2085.94 at 16:15 UTC) = 0.71, quality OK". It pays per call in USDC on Base or Arbitrum, or in RLUSD on XRPL, through x402.

### 1.2 Users and jobs
| User | Job | Tool |
|---|---|---|
| Leveraged-borrower risk agent (openx-rollover) | Decide whether to warn, deleverage or hedge | `prediction_get_probability` |
| DeFi keeper | Trigger a rebalance on a probability threshold | `prediction_get_probability` |
| Content and news agent | Quote market odds with a timestamp and provenance | `prediction_get_probability` |
| Quant and auditor agent | Check how trustworthy a price bucket has been | `prediction_get_calibration` |
| Any agent | Discover markets, prices and payable networks | `prediction_capabilities`, `prediction_list_markets` (free) |

### 1.3 Why people pay instead of calling the venue directly
Raw venue data has traps found in 21 live rounds. Normalizing them is the product (§6): the placeholder opening book, one-sided quotes, the orderbook returning 404 after FUNDED, raw-unit quantities, `minSize` being an LP threshold, group slugs, NegRisk vs binary, and oracle-vs-spot basis.

### 1.4 Success metrics
- **M-1 correctness:** 100% of fixture traps (§6) yield the right `quality` flag (T-UNIT-*).
- **M-2 payment integrity:** 0 paid responses without a verified settlement; 0 replays accepted (T-SEC-*).
- **M-3 latency:** p95 under 2.5 s for a paid call excluding chain settlement, and under 15 s including settlement on Base, Arbitrum and XRPL testnets.
- **M-4 adoption (post-launch):** at least 1 external paying agent within 30 days of launch (G-4 review).

### 1.5 Design rationale and rejected alternatives
| Choice | Why | Rejected alternative |
|---|---|---|
| Flashloan module base (D-1) | Already has reviewed, bounded, provenance-carrying reads for all 5 target networks | n-payment rails: no Robinhood or Sui coverage, and owner declined |
| Separate paid endpoint (D-2) | Payment needs state (quotes, used proofs); keeps a reviewed free invariant intact | Metering the public catalog: breaks the invariant |
| One tool, two calls (402 then retry with payment) | Mirrors HTTP x402 semantics inside MCP; arguments bound to the quote | A separate `payments.settle` tool: two tools to keep consistent |
| Ecosystem SDKs (D-3) | Standard payloads that x402 v2 clients already produce | Hand-rolled EIP-3009 verification |
| No order or trade tools (D-5) | Trading is stopped; a read-only feed cannot lose funds | Bundling execution |

### 1.6 Non-goals
Trading, order placement or redemption; forecasting or "alpha" claims; multi-strike distributions (v2); Polymarket or Kalshi ingestion (v2, behind G-1); paid access on Robinhood or Sui (planned); changes to the public flashloan catalog.

## 2. System Map

```
Agent (MCP client, x402 v2 wallet)
   │ 1. tools/call prediction_get_probability {market}              (no payment)
   ▼
/api/mcp/flashloan/paid  ── host/origin allowlist · admission RateWindow · bounded body (reuse public-mcp.ts hardening)
   │  PaidToolRouter ──► QuoteService ──► paid_quotes (Postgres)            → result: PAYMENT_REQUIRED {quote_id, accepts[]}
   │ 2. tools/call prediction_get_probability {market, payment:{quote_id, payload}}
   │  PaymentVerifier (by network)
   │     ├─ eip155:8453 / 84532 / 42161 / 421614 → @x402/evm (exact scheme) via facilitator (X402_FACILITATOR_URL_*)
   │     ├─ xrpl:0 / xrpl:1 → T54 facilitator /settle (XRPL_FACILITATOR_URL) OR ledger check of an already-submitted tx (xrpl.ts)
   │     └─ eip155:4663, sui:mainnet → NETWORK_PAYMENT_UNSUPPORTED (planned)
   │  → paid_settlements (unique tx_ref, unique quote_id)
   │  ProbabilityService
   │     ├─ VenueReader (Limitless REST: /markets/active, /markets/{slug}, /markets/{slug}/orderbook)  8 s timeout, 2 retries
   │     ├─ Normalizer (§6 rules → quality flag)
   │     ├─ CalibrationStore (prob_settlements + prob_snapshots)
   │     └─ prob_snapshots (append)
   ▼
result: ProbabilityQuote + receipt                (envelope {schema_version, request_id, operation, ok, ...})

SettlementCollector (cron, read-only): resolved markets → prob_settlements (feeds calibration)
```

```json nim-deliver
{
  "feature": "flashloan-paid-probability-feed",
  "type": "feature",
  "entrypoints": ["src/app/api/mcp/flashloan/paid/route.ts"],
  "modules": ["src/lib/mcp/flashloan/paid/"],
  "stores": ["paid_quotes", "paid_settlements", "prob_snapshots", "prob_settlements"],
  "externals": ["api.limitless.exchange", "x402 facilitator (Base/Arbitrum)", "T54 XRPL facilitator", "Base/Arbitrum/XRPL RPC"],
  "edges": ["EDGE-01", "EDGE-02", "EDGE-03", "EDGE-04", "EDGE-05"]
}
```

## 3. Environment contract (secret-free, placeholders only)

| Variable | Example placeholder | Required | Notes |
|---|---|---|---|
| `FEATURE_MCP_FLASHLOAN_PAID` | `false` | yes | Master flag. When off, the endpoint returns 404 `PAID_DISABLED`. Must be byte-identical behavior for the rest of the app when off. |
| `FEATURE_PAID_NETWORK_BASE` / `_BASE_SEPOLIA` / `_ARBITRUM` / `_ARBITRUM_SEPOLIA` / `_XRPL` / `_XRPL_TESTNET` | `false` | per network | A network is advertised only if its flag is on **and** its config is complete |
| `PAID_PAY_TO_EVM` | `<evm-address>` | for EVM | One merchant address for Base and Arbitrum; checksum-validated at boot |
| `PAID_PAY_TO_XRPL` | `<r-address>` | for XRPL | Merchant XRPL account |
| `X402_FACILITATOR_URL_BASE` / `_ARBITRUM` | `<https-url>` | for EVM | Per-network facilitator. Support for eip155:42161 must be verified (G-2). |
| `X402_FACILITATOR_API_KEY` | `<secret>` | if facilitator needs it | Never logged |
| `XRPL_FACILITATOR_URL` | `<https-url>` | for XRPL | T54 facilitator (already used by the gateway) |
| `XRPL_RLUSD_ISSUER` | `<r-address>` | for XRPL | Read from env; never hard-coded |
| `LIMITLESS_API_URL` | `https://api.limitless.exchange` | yes | Public reads only; no venue credentials |
| `PAID_PRICE_PROBABILITY_USD` / `PAID_PRICE_CALIBRATION_USD` | `0.002` / `0.01` | yes | Decimal USD; converted per asset in §7 |
| `PAID_QUOTE_TTL_SECONDS` | `120` | yes | Quote expiry |
| `FLASHLOAN_PAID_HOSTS` / `FLASHLOAN_PAID_ORIGINS` | `<hosts>` | yes | Same pattern as the public catalog |

- **TLS:** verify certificates for every external call; no hostname-verification bypass.
- **Side effects:** reads venue and chain data; writes only the 4 tables in §4.2; broadcasts on chain **only via the facilitator** (EVM) or not at all (XRPL already-submitted path).
- **Dependencies:** `@x402/core`, `@x402/evm` and `@x402/mcp` pinned **exactly at 2.28.0** (published 2026-09-29; 2.30.0 from 2026-11-04 is under the two-week age minimum). `xrpl@5.0.0` is already present with 4 recorded ESM/CJS workarounds. Importing it into a route requires T-LIVE-XRPL (§12).

## 4. Data schema

### 4.1 Domain types (normative shapes)

```ts
type Network = 'eip155:8453' | 'eip155:84532' | 'eip155:42161' | 'eip155:421614' | 'xrpl:0' | 'xrpl:1' | 'eip155:4663' | 'sui:mainnet';
type PaymentStatus = 'live' | 'testnet' | 'planned';            // planned => NETWORK_PAYMENT_UNSUPPORTED
type Quality = 'OK' | 'ONE_SIDED' | 'PLACEHOLDER' | 'BOOK_MISSING' | 'STALE' | 'WIDE_SPREAD' | 'RESOLVED' | 'UNSUPPORTED_MARKET';
type Horizon = '5m' | '15m' | '1h' | '1d';

interface MarketRef {            // input: either slug OR (asset, horizon[, at])
  venue: 'limitless';
  slug?: string;                 // e.g. "eth-up-or-down-15-min-1794324600"; group slugs rejected
  asset?: 'ETH' | 'BTC' | 'SOL' | 'XRP' | 'BNB' | 'DOGE';
  horizon?: Horizon;
  at?: string;                   // ISO-8601; default = the currently open window
}

interface ProbabilityQuote {     // output of prediction_get_probability
  schema_version: 'prediction-prob/1';
  market: { venue: 'limitless'; slug: string; type: 'binary'; event: string; strike: string; resolves_at: string };
  p_up: number | null;           // null when quality !== 'OK' and no honest estimate exists
  method: 'mid' | 'microprice';  // microprice when both top sizes > 0
  best_bid: number | null; best_ask: number | null; spread: number | null;
  depth_top3: { bid: string; ask: string };   // shares, decimal string, already de-scaled from raw 6-decimal
  seconds_to_resolution: number;
  resolution_source: string;     // e.g. "Chainlink ETH/USD (metadata.openPrice)"
  open_price: string | null;     // venue metadata.openPrice
  spot_basis: { source: 'binance'; spot: string; basis: string } | null;  // informational only
  quality: Quality; quality_reasons: string[];
  calibration: { bucket: string; hit_rate: number | null; n: number };     // n may be 0 at launch
  as_of: string;                 // ISO time of the book read
  provenance: { venue_endpoint: string; fetched_at: string; latency_ms: number };
}

interface PaymentRequirement {   // one entry of accepts[], x402 v2 PaymentRequirements shape
  scheme: 'exact';
  network: Network;
  asset: string;                 // EVM: USDC contract; XRPL: "RLUSD:<issuer>" or "XRP"
  amount: string;                // atomic units (USDC 6 dp) or XRPL decimal string
  pay_to: string;
  max_timeout_seconds: number;
  extra: { quote_id: string; nonce: string; name?: string; version?: string };  // EIP-712 domain name/version for USDC
}

interface PaymentRequiredResult { // returned by a paid tool called without a valid payment
  ok: false; error: { code: 'PAYMENT_REQUIRED'; message: string };
  payment_required: { x402_version: 2; quote_id: string; expires_at: string; args_hash: string; accepts: PaymentRequirement[] };
}

interface PaymentInput {         // second call
  quote_id: string;
  network: Network;
  payload:                       // per network
    | { kind: 'x402-evm'; payment_payload: unknown }              // x402 v2 PaymentPayload produced by @x402 client SDKs
    | { kind: 'xrpl-facilitator'; envelope: string }               // T54 relay envelope (buyer-signed)
    | { kind: 'xrpl-submitted'; tx_hash: string };                 // already-validated XRPL tx, memo/tag bound to quote
}

interface Receipt { network: Network; tx_ref: string; amount: string; asset: string; payer: string | null; settled_at: string }
```

### 4.2 Storage (Postgres via `pg`, normative)

Follow the existing pattern in `src/lib/mcp/flashloan/storage.ts`: export the DDL as a constant (like `RESEARCH_DDL`) and put it behind a `Repository` interface with a `MemoryRepository` (tests) and a `PostgresRepository` (prod). There is no migrations directory in this repo.

```sql
create table paid_quotes (
  quote_id      text primary key,                 -- 'q_' + 26-char ULID
  tool          text not null check (tool in ('prediction_get_probability','prediction_get_calibration')),
  args_hash     text not null,                    -- sha256 of canonical JSON args (market + options)
  network       text not null,
  asset         text not null,
  amount_atomic text not null,
  pay_to        text not null,
  nonce         text not null,                    -- 32-byte hex; EVM EIP-3009 nonce / XRPL memo
  client_key    text not null,                    -- sha256(admission key); no raw IP
  status        text not null default 'open' check (status in ('open','settled','expired','failed')),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz not null,
  unique (network, nonce)
);
create table paid_settlements (
  quote_id      text primary key references paid_quotes(quote_id),
  network       text not null,
  tx_ref        text not null,                    -- EVM tx hash / XRPL tx hash
  payer         text,
  amount_atomic text not null,
  facilitator   text,                             -- url host or 'ledger'
  receipt_hash  text not null,                    -- sha256 of the verifier response
  settled_at    timestamptz not null default now(),
  unique (network, tx_ref)                         -- replay guard
);
create table prob_snapshots (
  id bigserial primary key,
  venue text not null, slug text not null, captured_at timestamptz not null,
  p_up numeric(6,5), best_bid numeric(6,5), best_ask numeric(6,5), spread numeric(6,5),
  depth_bid3 numeric, depth_ask3 numeric, seconds_to_resolution int not null,
  quality text not null, paid boolean not null default false
);
create index prob_snapshots_slug_time on prob_snapshots (slug, captured_at);
create table prob_settlements (
  venue text not null, slug text not null, horizon text not null, asset text not null,
  resolved_at timestamptz not null, winning_outcome text not null check (winning_outcome in ('UP','DOWN')),
  open_price numeric, resolve_price numeric,
  primary key (venue, slug)
);
-- Calibration = per (horizon, bucket of last OK snapshot p_up at a fixed lead time) hit rate from prob_settlements.
```

Retention: `prob_snapshots` 30 days (aggregate into calibration first); quotes and settlements indefinitely (audit).

## 5. MCP tool contracts (`/api/mcp/flashloan/paid`)

Every result uses the existing envelope `{schema_version, request_id, operation, ok, error?}` plus the fields below. Inputs are strict zod (`additionalProperties: false`).

| Tool | Paid | Input | Output (ok) |
|---|---|---|---|
| `prediction_capabilities` | free | `{}` | `{networks: [{network, status: PaymentStatus, assets[], price: {probability, calibration}}], horizons[], assets[], limits}` |
| `prediction_list_markets` | free | `{asset?, horizon?, status?: 'open', limit?: 1..50}` | `{markets: [{slug, asset, horizon, event, resolves_at, type}]}` (no prices) |
| `prediction_get_probability` | **paid** | `{market: MarketRef, payment?: PaymentInput}` | `{probability: ProbabilityQuote, receipt: Receipt}` |
| `prediction_get_calibration` | **paid** | `{asset?, horizon: Horizon, lead_seconds?: 30..3600, payment?: PaymentInput}` | `{buckets: [{bucket:'0.60-0.70', n, hit_rate, mean_p}], window: {from, to}, receipt}` |

Paid-call protocol (both paid tools):
1. Call without `payment` → `PaymentRequiredResult`. A quote is stored with `args_hash` and expires in `PAID_QUOTE_TTL_SECONDS`. `accepts[]` lists **only** networks whose `status` is `live` or `testnet` and whose config is complete.
2. Call again with **identical arguments** plus `payment` → verify (§8) → store the settlement → compute → return. On mismatch: `ARGS_MISMATCH`.
3. A quote is single-use. A second call with the same `quote_id` returns `QUOTE_ALREADY_SETTLED` together with the **original receipt and the cached result** (idempotent; not charged again).
4. Optional: if `@x402/mcp@2.28.0`'s wire convention (payment carried in MCP `_meta`) can be adopted without breaking steps 1–3, accept it as an alternative transport. This is spike task P-0.

## 6. Normalization and quality rules (deterministic; the product core)

Evaluate in order; the first match sets `quality`. All reads use an 8 s timeout and 2 retries with 2 s backoff.

| # | Condition | quality | p_up |
|---|---|---|---|
| N-1 | Slug is a group slug, not binary/CLOB, or a NegRisk child without a resolvable parent | `UNSUPPORTED_MARKET` | null |
| N-2 | Market status resolved/closed | `RESOLVED` | null (return `winning_outcome` in `quality_reasons`) |
| N-3 | Orderbook 404 (it can lag FUNDED by 20 s or more) after 6 × 3 s retries | `BOOK_MISSING` | null |
| N-4 | Opening placeholder: within 10 s of open **and** bid ≤ 0.12 **and** ask ≥ 0.88 | `PLACEHOLDER` | null |
| N-5 | One side empty, or best bid < 0.05, or best ask > 0.95 with the other side empty | `ONE_SIDED` | null |
| N-6 | Spread > 0.20 | `WIDE_SPREAD` | mid (flagged) |
| N-7 | Book fetched more than 10 s before response | `STALE` | mid (flagged) |
| N-8 | Otherwise | `OK` | microprice if both top sizes > 0, else mid |

Units: REST `size` is **already raw 6-decimal**, so divide by 1e6 once and never multiply. `minSize` is an LP-reward threshold and is never a filter. A NO-side quote maps to YES as `yesAsk = 1 − noBid` and `yesBid = 1 − noAsk`. `spot_basis` is informational and is never used to change `p_up`.

## 7. Pricing

| Tool | USD | Base/Arbitrum USDC (atomic, 6 dp) | XRPL RLUSD |
|---|---|---|---|
| `prediction_get_probability` | 0.002 | `2000` | `"0.002"` |
| `prediction_get_calibration` | 0.01 | `10000` | `"0.01"` |

Prices come from env (§3) and are fixed per quote. Testnets use the same amounts in test assets.

## 8. Network and settlement matrix

| Network | Status | Asset | Settlement path | Binding to quote |
|---|---|---|---|---|
| `eip155:8453` Base | live (flag) | USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `@x402/evm` exact scheme: facilitator `/verify` then `/settle` (EIP-3009 `transferWithAuthorization`) | EIP-3009 `nonce` = quote `nonce`; `to` = `PAID_PAY_TO_EVM`; `value` = amount; `validBefore` ≤ `expires_at` |
| `eip155:84532` Base Sepolia | testnet | USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | same | same |
| `eip155:42161` Arbitrum | live (flag, **G-2**) | USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | same; facilitator must list eip155:42161 | same |
| `eip155:421614` Arbitrum Sepolia | testnet (**add**) | Circle test USDC; verify address and EIP-712 domain on chain at task P-3 | same | same |
| `xrpl:0` / `xrpl:1` XRPL | live / testnet (flag) | RLUSD (`XRPL_RLUSD_ISSUER`); XRP optional later | (a) T54 facilitator `/settle` with the buyer-signed envelope, or (b) an already-submitted tx checked on a **validated ledger** via `xrpl.ts` | Memo `quote_id` (hex) **and** `DestinationTag` derived from the nonce; Destination = `PAID_PAY_TO_XRPL`; delivered_amount ≥ amount |
| `eip155:4663` Robinhood | planned | — | refuse `NETWORK_PAYMENT_UNSUPPORTED` | — |
| `sui:mainnet` Sui | planned | — | refuse `NETWORK_PAYMENT_UNSUPPORTED` | — |

Verification invariants (all networks): the amount matches exactly (EVM) or is ≥ the quote (XRPL `delivered_amount`, never `Amount`, to defeat partial payments); the recipient is pinned; the quote is open and unexpired; `unique(network, tx_ref)` holds; settlement is final (EVM receipt status success; XRPL `validated: true`, `TransactionResult` `tesSUCCESS`). CAIP-2 ids for XRPL (`xrpl:0`/`xrpl:1`) must be confirmed against the facilitator's advertised ids at P-3.

## 9. Security and abuse controls

- **Replay:** `unique(network, tx_ref)` plus a single-use quote plus quote-bound nonce/memo.
- **Argument swap:** `args_hash` is bound to the quote, so `ARGS_MISMATCH` is returned when they differ.
- **Underpayment and partial payment:** exact or `delivered_amount` checks (§8).
- **Quote flooding:** admission `RateWindow` per hashed client; at most 20 open quotes per client key; expired quotes are swept every 5 min.
- **Free catalog regression:** T-INV-1 snapshot of the public tool list and response headers.
- **Secrets:** facilitator keys come only from env, are never logged or returned, and errors are scrubbed. Logs carry the quote_id and tx_ref only.
- **Data licensing:** paid launch is blocked on **G-1** (Limitless terms on redistributing quotes).
- **Bounded I/O:** reuse `boundedJson`/`boundedBody` and the public limits; 70 s max duration.

## 10. Error codes

| Code | Retryable | Meaning |
|---|---|---|
| `PAYMENT_REQUIRED` | — | No or invalid payment; carries `payment_required` |
| `QUOTE_EXPIRED` | yes (new quote) | Quote past `expires_at` |
| `QUOTE_ALREADY_SETTLED` | — | Idempotent replay; returns the original receipt and result |
| `ARGS_MISMATCH` | no | Arguments differ from the quoted `args_hash` |
| `PAYMENT_INVALID` | no | Signature, amount, recipient or nonce check failed |
| `PAYMENT_REPLAY` | no | tx_ref already used |
| `SETTLEMENT_PENDING` | yes | Facilitator accepted; finality not reached in 15 s; retry the same call |
| `FACILITATOR_UNAVAILABLE` | yes | Facilitator 5xx or timeout (never charge without settlement) |
| `NETWORK_PAYMENT_UNSUPPORTED` | no | Robinhood, Sui, or a network whose flag is off |
| `MARKET_NOT_FOUND` / `UNSUPPORTED_MARKET` | no | Bad slug or group slug |
| `VENUE_UNAVAILABLE` | yes | Venue reads failed after retries. **No charge**: the quote stays open until its TTL |
| `PAID_DISABLED` | no | Master flag off |

**Charging rule:** settle **after** the venue read succeeds when possible. If settlement succeeds and computation fails, return `VENUE_UNAVAILABLE` with `credit_quote_id`; the next call with that id is free once within the TTL plus 10 min.

## 11. Edge cases (nim-deliver EDGE-01…05 plus extras)

| ID | Case | Expected | Log marker |
|---|---|---|---|
| EDGE-01 | Same EVM authorization submitted twice (different quote_ids) | second → `PAYMENT_REPLAY`; one charge | `paid.replay_blocked` |
| EDGE-02 | Facilitator times out after broadcast | `SETTLEMENT_PENDING`; the retry with the same quote_id reconciles by tx hash, never re-broadcasts | `paid.settle_pending` |
| EDGE-03 | Paid call when the book is placeholder or one-sided | settled; returns `quality` ≠ OK, `p_up: null`; no silent fake probability | `prob.quality_flagged` |
| EDGE-04 | XRPL partial payment (`Amount` ≥ quote, `delivered_amount` < quote) | `PAYMENT_INVALID` | `paid.partial_payment_rejected` |
| EDGE-05 | Paid call on Robinhood or Sui | `NETWORK_PAYMENT_UNSUPPORTED`; not in `accepts[]` | `paid.network_unsupported` |
| EDGE-06 | Quote expired between calls | `QUOTE_EXPIRED` | `paid.quote_expired` |
| EDGE-07 | Venue down after settlement | `VENUE_UNAVAILABLE` + `credit_quote_id` | `paid.credit_issued` |
| EDGE-08 | Public catalog called with a payment payload | ignored; public behavior byte-identical | `public.invariant_ok` |

## 12. End-to-end verification plan

| Tier | ID | What | How | Gate |
|---|---|---|---|---|
| Unit | T-UNIT-1..8 | N-1…N-8 normalization | Fixtures from real books: placeholder 0.11/0.89, 0.031 bid one-sided, 404-after-FUNDED, raw `size`, NO→YES mapping | CI |
| Unit | T-UNIT-9 | args_hash canonicalization | key order and whitespace invariance | CI |
| Contract | T-CON-1..4 | zod schemas of the 4 tools, envelope, error codes | snapshot tests | CI |
| Security | T-SEC-1..5 | EDGE-01, 04, 06, args swap, quote flooding | facilitator and ledger test doubles | CI |
| Invariant | T-INV-1 | Public `/api/mcp/flashloan` tool list, headers and no-metering unchanged with `FEATURE_MCP_FLASHLOAN_PAID` on and off | existing `tests/flashloan-public.test.ts` extended | CI |
| Integration | T-INT-1 | Full two-call flow with test doubles for all 3 settlement kinds | vitest | CI |
| Live | T-LIVE-BASE | Real x402 payment on **Base Sepolia** through the facilitator; receipt plus DB rows | `RUN_LIVE_BASE_SEPOLIA=true` | manual, before flag-on |
| Live | T-LIVE-ARB | Same on **Arbitrum Sepolia** (after P-3 adds the network) | `RUN_LIVE_ARB_SEPOLIA=true` | manual |
| Live | T-LIVE-XRPL | RLUSD on **XRPL testnet**, both paths (facilitator, already-submitted); also proves the `xrpl@5.0.0` import inside a route | `RUN_LIVE_XRPL_TESTS=true` (existing Tier 2 pattern) | manual |
| Live | T-LIVE-VENUE | Real Limitless reads for ETH/BTC 5m and 15m; quality distribution logged | read-only, about 10 min | manual |
| Post-delivery | T-POST-1 | Mainnet canary: one $0.002 paid call on Base and on Arbitrum, XRPL mainnet optional | **owner approval (G-3)** | after deploy |

Every edge (EDGE-01…05) has one executable proof plus a log marker (§11), as `nim-skill deliver verify` requires.

## 13. Gstack review (15 frames + pre-mortem)

| Frame | Score | Reason |
|---|---|---|
| F1 Cash flow | 1 | Named segment (risk agents, openx-rollover), but per-query pennies and no revenue evidence |
| F2 Convergence | 2 | x402 v2 SDK and `@x402/mcp` actively released (Sep–Nov 2026); agent payments; short-horizon prediction markets; fewer than 4 verified external signals |
| F3 Only-X | 1 | The venue could publish a clean feed; the edge is the trap catalog plus calibration plus 3 rails |
| F4 Leader | 0 | No external adopters yet |
| F5 Authenticity | 1 | Built from 21 honest public rounds, including losses |
| F6 Reflexive loop | 1 | Settlement history improves calibration over time, not per user |
| F7 Burden inverted | 1 | Quality flags are falsifiable against settlements |
| F8 Tail optionality | 3 | Hedge agent, settlement-integrity monitor, OpenX listing, multi-venue/multi-strike |
| F9 Structural forcing | 0 | None |
| F10 Convenience | 2 | One call replaces 8 trap-handling rules plus payment plumbing |
| F11 Composability | 3 | MCP, `@x402` SDK, T54 XRPL, Limitless, 5-network reads |
| F12 Contrarian | 2 | "Sell the calibrated price you can't beat" is non-obvious |
| F13 Low-float | N/A | Not a token |
| F14 Rebalancing | 1 | MCP only at launch (WebMCP and OpenX listing next) |
| F15 OSS | 1 | App licensing undecided; harness and skills are MIT |
| **Total** | **19 / 42** | Below a strong-ship bar. **Proceed as a bounded MVP behind flags**, justified by F8 and F11 (data layer for the hedge agent), not standalone revenue |

**5 Tigers** (probability × impact):

| ID | Risk | p | Impact | Weighted | Mitigation |
|---|---|---|---|---|---|
| T1 | Limitless terms forbid quote resale | 0.4 | 3 | 1.2 | G-1 before paid launch; fallback: sell only derived calibration |
| T2 | No facilitator supports Arbitrum, or it requires keys or KYC | 0.5 | 2 | 1.0 | G-2; ship Base and XRPL first; Arbitrum stays testnet |
| T3 | `xrpl@5.0.0` ESM/CJS crash in the route | 0.5 | 2 | 1.0 | T-LIVE-XRPL before flag-on; lazy import; isolate in the XRPL verifier |
| T4 | Thin calibration (n≈0) makes the feed look like a raw mid, with low willingness to pay | 0.7 | 2 | 1.4 | Run SettlementCollector from day 0; show `n`; price calibration separately |
| T5 | Replay or charge-without-delivery bug | 0.15 | 3 | 0.45 | T-SEC suite, the credit rule, idempotent quote |
| | **Aggregate** | | | **5.05 / 15** | **3–6 zone: ship with the named mitigations; G-1 and G-2 are explicit go/no-go gates** |

**5 Paper Tigers:**
- Book latency: the book absorbs price moves within 5 s, so it's fresh enough.
- Gas on Base: cents.
- Robinhood and Sui unpaid: explicitly planned.
- RLUSD buyer liquidity: XRP can be added later.
- MCP spec churn: versions are pinned.

**5 Elephants:**
- We sell what we couldn't profit from. It's positioned as a reference price, never alpha.
- Single-venue concentration: Limitless mirrors Polymarket.
- No customer interviews yet.
- Jurisdictional rules on selling prediction-market data.
- Ops burden of 3 settlement rails.

## 14. Implementation plan (ordered; each task ≤ 1 day; no task starts before its predecessor's acceptance passes)

| Task | Scope | Files (new unless noted) | Acceptance |
|---|---|---|---|
| P-0 | Spike: read `@x402/core`, `@x402/evm` and `@x402/mcp` @2.28.0 APIs. Confirm the PaymentPayload/verify/settle calls and the MCP `_meta` convention; confirm the facilitator's supported networks (G-2 input) | `docs/prd/notes/x402-2.28.0-spike.md` | Written API map; decide §5 step 4 |
| P-1 | Schemas, DDL and repository | `src/lib/mcp/flashloan/paid/contracts.ts`, `paid/storage.ts` (`PAID_DDL` + `PaidRepository` with Memory and Postgres implementations, mirroring `../storage.ts`) | T-CON-1..4 green |
| P-2 | VenueReader + Normalizer (§6) | `paid/venue.ts`, `paid/normalize.ts` | T-UNIT-1..8 green |
| P-3 | Network registry: statuses, assets and pay-to from env; add Arbitrum Sepolia; verify test USDC and XRPL CAIP ids | `paid/networks.ts` (reads `../networks.ts`, does not modify it) | `prediction_capabilities` lists exactly the live/testnet networks; Robinhood and Sui `planned` |
| P-4 | QuoteService + args_hash + sweep | `paid/quotes.ts` | T-UNIT-9, T-SEC-5 |
| P-5 | EVM verifier via `@x402/evm` + facilitator | `paid/verify-evm.ts` | T-SEC-1, T-INT-1 (EVM), T-LIVE-BASE |
| P-6 | XRPL verifier (facilitator and ledger paths) | `paid/verify-xrpl.ts` (uses `../xrpl.ts`) | T-SEC-4, T-INT-1 (XRPL), T-LIVE-XRPL |
| P-7 | Paid route + router + charging rule | `src/app/api/mcp/flashloan/paid/route.ts`, `paid/router.ts` | T-INT-1, EDGE-02/07 |
| P-8 | SettlementCollector + calibration | `paid/calibration.ts`, cron entry | Settlements accrue; `prediction_get_calibration` returns `n` |
| P-9 | Invariant + observability | extend `tests/flashloan-public.test.ts`; log markers | T-INV-1; every §11 marker emitted |
| P-10 | Docs + WebMCP entry (flag-gated) | `docs/`, `public/.well-known/webmcp.json` entry | Reviewed |

**Workrule (WR-01..05):** one responsibility per file; no edits to the public catalog files except tests; no new required dependency beyond the three pinned `@x402` packages; all of it behind `FEATURE_MCP_FLASHLOAN_PAID`, with byte-identical behavior when off.

## 15. Owner gates

| Gate | Blocks | Decision needed |
|---|---|---|
| G-1 | Any paid mainnet call | Limitless (and any future venue) terms allow redistribution of quotes or derived probabilities |
| G-2 | Arbitrum mainnet flag-on | Chosen facilitator supports eip155:42161 (or the owner approves self-hosting with a funded gas key) |
| G-3 | T-POST-1 mainnet canary | Owner approves the tiny-amount mainnet calls |
| G-4 | Continuation after 30 days | M-4 adoption review: continue, re-price, or retire |

## 16. Provenance

- Source scan: `bd-team/research/hypermove/2026-11-10-probability-feed-x402-prd/01-source-scan.md`. Public MCP invariant: `src/lib/mcp/flashloan/public-mcp.ts`. The mock `src/app/api/paid-endpoint/route.ts`. Real rails `src/lib/mcp/npayment-rails.ts` (reference only; not used, D-1). Networks `src/lib/mcp/flashloan/networks.ts`.
- Normalization traps: bd-team lessons store (`limitless-orderbook-404-lags-funded-20261107`, `limitless-naive-maker-050-adverse-selection-20261107`, `replay-mean-of-ratios-placeholder-quote-artifact-20261110`, among others) and 21 live-round handoffs.
- Calibration evidence and limits: `bd-team/research/prediction-markets/2026-11-10-entry-options-replay-and-upgrades/`.
- SDK versions: npm registry, checked 2026-11-10 (`@x402/*` 2.30.0 latest; 2.28.0 is the newest that is at least two weeks old).
