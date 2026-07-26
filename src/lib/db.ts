/**
 * src/lib/db.ts
 * -------------
 * Lazy Postgres client for Supabase-hosted registry storage.
 *
 * SOLID:
 *  - Single Responsibility: this module only owns the connection pool + the
 *    `hypermove_registry_requests` table. /api/v1/register imports the two
 *    exported functions; nothing else touches pg.
 *  - Open/Closed: schema migrations live in TABLE_DDL; add columns by appending
 *    ALTER TABLE … IF NOT EXISTS statements, no consumer changes needed.
 *
 * Idempotent: every request runs `ensureSchema()` once per process; the CREATE
 * TABLE IF NOT EXISTS makes that safe on every cold start.
 *
 * Without DATABASE_URL the writer no-ops gracefully — useful for `pnpm dev`
 * without a database.
 */

import { Pool, type PoolClient } from 'pg';
import dns from 'node:dns';

// Supabase free-tier direct Postgres is IPv6-only (AAAA record, no A).
// Node defaults to IPv4-first → ENOTFOUND in IPv6-routed environments.
// This is a no-op on networks without IPv6; harmless to call once.
dns.setDefaultResultOrder('ipv6first');

const TABLE_DDL = `
CREATE TABLE IF NOT EXISTS hypermove_registry_requests (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL,
  bundle_id     TEXT NOT NULL,
  requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip            TEXT,
  user_agent    TEXT,
  status        TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_hmrr_email        ON hypermove_registry_requests(email);
CREATE INDEX IF NOT EXISTS idx_hmrr_requested_at ON hypermove_registry_requests(requested_at DESC);

-- ─── flare.token.save / flare.token.profile (2026-07-20) ──────────────────
CREATE TABLE IF NOT EXISTS hypermove_token_profiles (
  token_symbol  TEXT NOT NULL,
  flare_network TEXT NOT NULL,
  profile       JSONB NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (token_symbol, flare_network)
);

CREATE TABLE IF NOT EXISTS hypermove_generated_mcps (
  id            BIGSERIAL PRIMARY KEY,
  source_url    TEXT NOT NULL,
  mcp_name      TEXT NOT NULL,
  manifest      JSONB NOT NULL,
  server_code   TEXT NOT NULL,
  host          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hgm_created_at ON hypermove_generated_mcps(created_at DESC);

CREATE TABLE IF NOT EXISTS hypermove_user_quotas (
  wallet_address TEXT PRIMARY KEY,
  free_remaining INT NOT NULL DEFAULT 5,
  tier           TEXT NOT NULL DEFAULT 'free',
  tier_expires_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_scan_at   TIMESTAMPTZ
);

-- ─── HyperMove v2.0 Platform Layer (HM1 + HM2) ────────────────────────────
CREATE TABLE IF NOT EXISTS hm_events (
  id           BIGSERIAL PRIMARY KEY,
  kind         TEXT        NOT NULL,
  endpoint     TEXT        NOT NULL,
  version      TEXT,
  chain        TEXT,
  agent_id     TEXT        NOT NULL,
  trace_id     TEXT        NOT NULL,
  duration_ms  INT,
  error        TEXT,
  stack        TEXT,
  payload_hash TEXT,
  context      JSONB,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hm_events_created_at ON hm_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hm_events_endpoint   ON hm_events(endpoint);
CREATE INDEX IF NOT EXISTS idx_hm_events_kind       ON hm_events(kind);

CREATE TABLE IF NOT EXISTS hm_policy_hits (
  id             BIGSERIAL PRIMARY KEY,
  policy         TEXT        NOT NULL,
  endpoint       TEXT        NOT NULL,
  agent_id       TEXT        NOT NULL,
  reason         TEXT        NOT NULL,
  cost_micro_usd BIGINT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_hm_policy_hits_created_at ON hm_policy_hits(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_hm_policy_hits_policy     ON hm_policy_hits(policy);

-- ─── HyperMove MCP Gateway v1.0 (all additive) ────────────────────────────
CREATE TABLE IF NOT EXISTS mcp_users (
  user_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workos_user_id TEXT UNIQUE,
  email          TEXT,
  tier           TEXT NOT NULL DEFAULT 'free',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at   TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS mcp_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  email       TEXT,
  expires_at  TIMESTAMPTZ NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_user ON mcp_tokens(user_id);
-- mcp_tokens.user_id was originally UUID, but every caller (storeToken /
-- validateToken) always stores/queries the external identity string
-- (WorkOS user id or "wallet:0x…"), never the mcp_users.user_id UUID PK.
-- Widen the column on any DB created before this fix.
ALTER TABLE mcp_tokens ALTER COLUMN user_id TYPE TEXT;

CREATE TABLE IF NOT EXISTS mcp_rate_counters (
  bucket_key  TEXT PRIMARY KEY,   -- sha256(userId + hourBucket)
  user_id     TEXT NOT NULL,
  hour_bucket BIGINT NOT NULL,
  count       INT NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_rate_user ON mcp_rate_counters(user_id, hour_bucket);

CREATE TABLE IF NOT EXISTS mcp_paid_sessions (
  session_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT NOT NULL,
  tier        TEXT NOT NULL,
  chain       TEXT NOT NULL,
  rail        TEXT NOT NULL,
  amount      TEXT NOT NULL,
  quota_limit INT NOT NULL DEFAULT 100,
  quota_used  INT NOT NULL DEFAULT 0,
  tx_hash     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_sessions_user ON mcp_paid_sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS mcp_calls (
  call_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT NOT NULL,
  session_id    UUID,
  tool_name     TEXT NOT NULL,
  tier          TEXT,
  params_hash   TEXT NOT NULL,
  response_bytes INT NOT NULL DEFAULT 0,
  latency_ms    INT NOT NULL DEFAULT 0,
  outcome       TEXT NOT NULL DEFAULT 'ok',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mcp_calls_user ON mcp_calls(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS mcp_catalog (
  entry_id     TEXT PRIMARY KEY,
  service      TEXT NOT NULL,
  chain        TEXT,
  kind         TEXT NOT NULL,
  description  TEXT NOT NULL,
  keywords     TEXT[],
  signature    TEXT,
  price_tier   TEXT NOT NULL,
  embedding    JSONB,     -- vector stored as JSON array; pgvector optional (see vector-store.ts)
  generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mcp_catalog_service ON mcp_catalog(service);
CREATE INDEX IF NOT EXISTS idx_mcp_catalog_chain   ON mcp_catalog(chain, kind);

CREATE TABLE IF NOT EXISTS mcp_news (
  news_id      TEXT PRIMARY KEY,   -- sha256(url + title)
  project      TEXT NOT NULL,
  chain        TEXT,
  title        TEXT NOT NULL,
  summary      TEXT,
  url          TEXT,
  source       TEXT,
  published_at TIMESTAMPTZ NOT NULL,
  embedding    JSONB,
  ingested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mcp_news_project ON mcp_news(project, published_at DESC);
CREATE INDEX IF NOT EXISTS idx_mcp_news_published ON mcp_news(published_at DESC);

-- ─── XRPL Pro: 30-day time-boxed entitlement (RLUSD/x402) ─────────────────
-- One $5 RLUSD payment → one 30-day Pro window. payment_tx is UNIQUE so a
-- replayed settlement proof can never mint a second entitlement (idempotent).
CREATE TABLE IF NOT EXISTS mcp_pro_entitlements (
  id                BIGSERIAL PRIMARY KEY,
  user_id           TEXT NOT NULL,
  wallet            TEXT,
  tier              TEXT NOT NULL DEFAULT 'xrpl-pro',
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at        TIMESTAMPTZ NOT NULL,
  payment_tx        TEXT UNIQUE,
  monthly_query_cap INT NOT NULL DEFAULT 200,
  queries_used      INT NOT NULL DEFAULT 0,
  cap_reset_at      TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mcp_pro_ent_user ON mcp_pro_entitlements(user_id, expires_at DESC);

-- ─── Terminal device-code auth (FEATURE_MCP_DEVICE_AUTH, 2026-07-25) ──────
-- RFC-8628-shaped device flow for headless agents: POST /device/start mints
-- a device_code + short human-typable user_code; a human approves/denies via
-- POST /device/approve (y/n, right in the terminal — no browser, no wallet,
-- no WorkOS); the agent polls POST /device/poll until resolved. Deliberately
-- ANONYMOUS (no wallet/email tied to the row) — see auth.ts's device-session
-- kind, which is hard-capped at tier='free' and can never reach a paid tier.
-- One-shot by construction: approve/deny only succeeds from 'pending'; a
-- second call on an already-resolved user_code is rejected by the app layer
-- (see device/approve/route.ts), not by a DB constraint, so the error message
-- stays descriptive ("already resolved" vs a generic constraint violation).
CREATE TABLE IF NOT EXISTS mcp_device_codes (
  device_code  TEXT PRIMARY KEY,
  user_code    TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending', -- pending | approved | denied | expired
  token_hash   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mcp_device_codes_user_code ON mcp_device_codes(user_code);
CREATE INDEX IF NOT EXISTS idx_mcp_device_codes_expires ON mcp_device_codes(expires_at);

-- ─── Dream Cycle (FEATURE_MCP_DREAM_CYCLE, 2026-07-26) ────────────────────
-- Offline memory-consolidation pipeline. All 5 tables are per-agent-scoped;
-- every query in dream/*.ts filters by agent_id. See docs/prd/dream-cycle-v1.md
-- and platform-flag.ts's isMcpDreamCycleEnabled() for the feature gate.

-- First-write-claims-it ownership binding: closes the cross-agent write
-- injection gap (this MCP server authenticates a session, not the agent_id
-- in a tool's payload). See dream/ownership.ts.
CREATE TABLE IF NOT EXISTS mcp_agent_ownership (
  agent_id    TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  claimed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_mcp_agent_ownership_owner ON mcp_agent_ownership(owner_user_id);

-- Zero-token cold storage for raw episode logs (submit_episode_log). No
-- LLM/embedding call happens at insert time — see dream/ingest.ts.
CREATE TABLE IF NOT EXISTS dream_episode_logs (
  episode_id      TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,
  task_type       TEXT,
  steps           JSONB NOT NULL,
  outcome         TEXT NOT NULL, -- success | failure | timeout
  tags            TEXT[],
  raw_tokens_estimate INT,
  consumed_by_run TEXT, -- dream_cycle_runs.run_id once processed; NULL = unconsumed
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, episode_id)
);
CREATE INDEX IF NOT EXISTS idx_dream_episode_logs_agent_time ON dream_episode_logs(agent_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_dream_episode_logs_unconsumed ON dream_episode_logs(agent_id) WHERE consumed_by_run IS NULL;

-- Per-agent consolidated memory store (the pipeline's durable output).
CREATE TABLE IF NOT EXISTS dream_consolidated_memories (
  memory_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        TEXT NOT NULL,
  type            TEXT NOT NULL, -- rule | error_pattern | preference | fact
  content         TEXT NOT NULL, -- <=200 chars, enforced at write time
  confidence      REAL NOT NULL DEFAULT 0.5,
  importance      REAL NOT NULL DEFAULT 0.5,
  source_count    INT NOT NULL DEFAULT 1,
  embedding       JSONB, -- vector as JSON array; rebuilt into MemoryVectorStore on read
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_accessed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  access_count    INT NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_dream_memories_agent ON dream_consolidated_memories(agent_id);
CREATE INDEX IF NOT EXISTS idx_dream_memories_agent_confidence ON dream_consolidated_memories(agent_id, confidence DESC);

-- One row per start_dream invocation (run lifecycle + cost/observability).
CREATE TABLE IF NOT EXISTS dream_cycle_runs (
  run_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id          TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'started', -- started | completed | partial | failed | error
  config_snapshot   JSONB NOT NULL,
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at          TIMESTAMPTZ,
  duration_ms       INT,
  budget_used_usd   NUMERIC(10,6) NOT NULL DEFAULT 0,
  stages_completed  TEXT[] NOT NULL DEFAULT '{}',
  memories_added    INT NOT NULL DEFAULT 0,
  memories_removed  INT NOT NULL DEFAULT 0,
  per_stage_tokens  JSONB, -- {preprocessing, clustering, extraction, consolidation}
  errors            JSONB NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_dream_cycle_runs_agent ON dream_cycle_runs(agent_id, started_at DESC);

-- Last-stored config per agent (start_dream / get_dream_config). Phase 1:
-- trigger_criteria is persisted but NOT enforced server-side (no scheduler
-- exists in this repo yet) — see dream/pipeline.ts and docs/prd/dream-cycle-v1.md
-- "Backlog — Phase 2-4" for the documented gap.
CREATE TABLE IF NOT EXISTS dream_configs (
  agent_id          TEXT PRIMARY KEY,
  budget_usd        NUMERIC(10,6) NOT NULL,
  preset            TEXT NOT NULL DEFAULT 'balanced',
  trigger_criteria  JSONB,
  last_run_id       TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

let pool: Pool | null = null;
let schemaReady = false;

function getPool(): Pool | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: 5,
      ssl: url.includes('supabase') ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
  }
  return pool;
}

async function ensureSchema(client: PoolClient): Promise<void> {
  if (schemaReady) return;
  await client.query(TABLE_DDL);
  schemaReady = true;
}

/**
 * Run `fn` with a pooled client after the schema is ensured. Returns null when
 * DATABASE_URL is unset (dev / mock-first). Every MCP feature module uses this
 * instead of re-implementing connect/ensureSchema/release — SRP + no dup.
 */
export async function withClient<T>(fn: (client: PoolClient) => Promise<T>): Promise<T | null> {
  const p = getPool();
  if (!p) return null;
  let client: PoolClient | null = null;
  try {
    client = await p.connect();
    await ensureSchema(client);
    return await fn(client);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[mcp:withClient] query failed', err);
    return null;
  } finally {
    client?.release();
  }
}

export interface RegistryRequest {
  email: string;
  bundleId: string;
  ip?: string;
  userAgent?: string;
}

export interface RegistryResult {
  ok: boolean;
  id?: number;
  /** Set when DATABASE_URL is missing — request is accepted but not persisted. */
  noopReason?: string;
  /** Raw error message (server-only — never sent to the client verbatim). */
  error?: string;
  /** Stable, sanitized hint surfaced to the UI. */
  hint?: ErrorHint;
}

export type ErrorHint =
  | 'dns_unreachable'        // ENOTFOUND / EAI_AGAIN — wrong host or no IPv6 route
  | 'connection_refused'     // ECONNREFUSED — host wrong port or firewalled
  | 'connection_timeout'     // ETIMEDOUT
  | 'auth_failed'            // password/role wrong
  | 'tenant_not_found'       // Supavisor: project ref/shard/region mismatch
  | 'tls_failed'
  | 'schema_error'
  | 'unknown';

function classifyError(err: unknown): ErrorHint {
  const msg = String((err as { message?: string })?.message ?? err);
  const code = (err as { code?: string })?.code ?? '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'dns_unreachable';
  if (code === 'ECONNREFUSED')                       return 'connection_refused';
  if (code === 'ETIMEDOUT' || /timeout/i.test(msg))  return 'connection_timeout';
  if (/tenant.*not found/i.test(msg))                return 'tenant_not_found';
  if (/password|auth/i.test(msg))                    return 'auth_failed';
  if (/tls|ssl|certificate/i.test(msg))              return 'tls_failed';
  if (/syntax|relation|column/i.test(msg))           return 'schema_error';
  return 'unknown';
}

export async function insertRegistryRequest(req: RegistryRequest): Promise<RegistryResult> {
  const p = getPool();
  if (!p) return { ok: true, noopReason: 'no_database_url' };

  let client: PoolClient | null = null;
  try {
    client = await p.connect();
    await ensureSchema(client);
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO hypermove_registry_requests (email, bundle_id, ip, user_agent)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [req.email, req.bundleId, req.ip ?? null, req.userAgent ?? null],
    );
    return { ok: true, id: rows[0]?.id };
  } catch (err) {
    const hint = classifyError(err);
    // Log to server console for Vercel/Hetzner logs. Safe — no password leak.
    // eslint-disable-next-line no-console
    console.error(`[registry] insert failed hint=${hint}`, err);
    return { ok: false, error: String(err), hint };
  } finally {
    client?.release();
  }
}

// ─── Generated MCP persistence ──────────────────────────────────────────────

export interface GeneratedMCP {
  sourceUrl: string;
  mcpName: string;
  manifest: object;
  serverCode: string;
  host?: string;
}

export interface GeneratedMCPResult {
  ok: boolean;
  id?: number;
  slug?: string;
  noopReason?: string;
  error?: string;
  hint?: ErrorHint;
}

/** Check if URL already scanned — return existing record if so. */
export async function findMCPByUrl(sourceUrl: string): Promise<{ id: number; slug: string; manifest: object; serverCode: string } | null> {
  const p = getPool();
  if (!p) return null;
  let client: PoolClient | null = null;
  try {
    client = await p.connect();
    await ensureSchema(client);
    const { rows } = await client.query<{ id: number; mcp_name: string; manifest: object; server_code: string }>(
      `SELECT id, mcp_name, manifest, server_code FROM hypermove_generated_mcps WHERE source_url = $1 LIMIT 1`,
      [sourceUrl],
    );
    if (rows.length === 0) return null;
    return { id: rows[0].id, slug: rows[0].mcp_name, manifest: rows[0].manifest, serverCode: rows[0].server_code };
  } catch {
    return null;
  } finally {
    client?.release();
  }
}

/** Find MCP by slug — used by the hosted MCP route. */
export async function findMCPBySlug(slug: string): Promise<{ id: number; manifest: object; serverCode: string; sourceUrl: string } | null> {
  const p = getPool();
  if (!p) return null;
  let client: PoolClient | null = null;
  try {
    client = await p.connect();
    await ensureSchema(client);
    const { rows } = await client.query<{ id: number; manifest: object; server_code: string; source_url: string }>(
      `SELECT id, manifest, server_code, source_url FROM hypermove_generated_mcps WHERE mcp_name = $1 LIMIT 1`,
      [slug],
    );
    if (rows.length === 0) return null;
    return { id: rows[0].id, manifest: rows[0].manifest, serverCode: rows[0].server_code, sourceUrl: rows[0].source_url };
  } catch {
    return null;
  } finally {
    client?.release();
  }
}

export async function insertGeneratedMCP(req: GeneratedMCP): Promise<GeneratedMCPResult> {
  const p = getPool();
  if (!p) return { ok: true, slug: req.mcpName, noopReason: 'no_database_url' };

  let client: PoolClient | null = null;
  try {
    client = await p.connect();
    await ensureSchema(client);
    const { rows } = await client.query<{ id: number }>(
      `INSERT INTO hypermove_generated_mcps (source_url, mcp_name, manifest, server_code, host)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [req.sourceUrl, req.mcpName, JSON.stringify(req.manifest), req.serverCode, req.host ?? null],
    );
    return { ok: true, id: rows[0]?.id, slug: req.mcpName };
  } catch (err) {
    const hint = classifyError(err);
    console.error(`[generated-mcp] insert failed hint=${hint}`, err);
    return { ok: false, error: String(err), hint };
  } finally {
    client?.release();
  }
}

// ─── Quota tracking ─────────────────────────────────────────────────────────

export interface UserQuota {
  wallet_address: string;
  free_remaining: number;
  tier: 'free' | 'pro';
  tier_expires_at: string | null;
}

/** Get quota for a wallet. Creates entry with 5 free if not exists. */
export async function getQuota(wallet: string): Promise<UserQuota | null> {
  const p = getPool();
  if (!p) return { wallet_address: wallet, free_remaining: 5, tier: 'free', tier_expires_at: null };
  let client: PoolClient | null = null;
  try {
    client = await p.connect();
    await ensureSchema(client);
    // Upsert
    await client.query(
      `INSERT INTO hypermove_user_quotas (wallet_address) VALUES ($1) ON CONFLICT (wallet_address) DO NOTHING`,
      [wallet.toLowerCase()],
    );
    // Select
    const { rows } = await client.query<UserQuota>(
      `SELECT wallet_address, free_remaining, tier, tier_expires_at::text FROM hypermove_user_quotas WHERE wallet_address = $1`,
      [wallet.toLowerCase()],
    );
    if (!rows.length) return { wallet_address: wallet, free_remaining: 5, tier: 'free', tier_expires_at: null };
    const q = rows[0];
    // Check if pro expired
    if (q.tier === 'pro' && q.tier_expires_at && new Date(q.tier_expires_at) < new Date()) {
      await client.query(`UPDATE hypermove_user_quotas SET tier = 'free' WHERE wallet_address = $1`, [wallet.toLowerCase()]);
      q.tier = 'free';
    }
    return q;
  } catch {
    return null;
  } finally {
    client?.release();
  }
}

/** Consume 1 free scan. Returns false if no quota left. */
export async function consumeQuota(wallet: string): Promise<boolean> {
  const p = getPool();
  if (!p) return true; // no DB = unlimited (dev mode)
  let client: PoolClient | null = null;
  try {
    client = await p.connect();
    await ensureSchema(client);
    const { rows } = await client.query<{ tier: string; free_remaining: number; tier_expires_at: string | null }>(
      `SELECT tier, free_remaining, tier_expires_at::text FROM hypermove_user_quotas WHERE wallet_address = $1`,
      [wallet.toLowerCase()],
    );
    if (!rows.length) return false;
    const q = rows[0];
    // Pro tier (not expired) = unlimited
    if (q.tier === 'pro' && q.tier_expires_at && new Date(q.tier_expires_at) > new Date()) return true;
    // Free tier: check remaining
    if (q.free_remaining <= 0) return false;
    // Decrement
    await client.query(
      `UPDATE hypermove_user_quotas SET free_remaining = free_remaining - 1, last_scan_at = NOW() WHERE wallet_address = $1`,
      [wallet.toLowerCase()],
    );
    return true;
  } catch {
    return false;
  } finally {
    client?.release();
  }
}

/** Upgrade wallet to pro for 30 days. */
export async function upgradeToProTier(wallet: string): Promise<boolean> {
  const p = getPool();
  if (!p) return true;
  let client: PoolClient | null = null;
  try {
    client = await p.connect();
    await ensureSchema(client);
    await client.query(
      `INSERT INTO hypermove_user_quotas (wallet_address, tier, tier_expires_at) VALUES ($1, 'pro', NOW() + INTERVAL '30 days')
       ON CONFLICT (wallet_address) DO UPDATE SET tier = 'pro', tier_expires_at = NOW() + INTERVAL '30 days'`,
      [wallet.toLowerCase()],
    );
    return true;
  } catch {
    return false;
  } finally {
    client?.release();
  }
}

// ─── HyperMove v2.0 Platform Layer helpers (HM1 + HM2) ─────────────────────
//
// SOLID: Single Responsibility — every persistence op for hm_events + hm_policy_hits
// lives here. Callers pass plain data shapes; this module owns SQL + retries.
// Graceful no-op semantics preserved from existing helpers: missing DATABASE_URL
// returns { ok: true, noopReason: 'no_database_url' } so dev mode never breaks.

export interface HMEventRow {
  kind: string;
  endpoint: string;
  version?: string;
  chain?: string;
  agent_id: string;
  trace_id: string;
  duration_ms?: number;
  error?: string;
  stack?: string;
  payload_hash?: string;
  context?: Record<string, unknown>;
}

export interface HMPolicyHitRow {
  policy: string;
  endpoint: string;
  agent_id: string;
  reason: string;
  cost_micro_usd?: number;
}

export interface HMWriteResult {
  ok: boolean;
  noopReason?: 'no_database_url';
  error?: string;
}

export async function insertHMEvent(ev: HMEventRow): Promise<HMWriteResult> {
  const p = getPool();
  if (!p) return { ok: true, noopReason: 'no_database_url' };
  let client: PoolClient | null = null;
  try {
    client = await p.connect();
    await ensureSchema(client);
    await client.query(
      `INSERT INTO hm_events
         (kind, endpoint, version, chain, agent_id, trace_id, duration_ms, error, stack, payload_hash, context)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        ev.kind, ev.endpoint, ev.version ?? null, ev.chain ?? null,
        ev.agent_id, ev.trace_id, ev.duration_ms ?? null,
        ev.error ?? null, ev.stack ?? null, ev.payload_hash ?? null,
        ev.context ? JSON.stringify(ev.context) : null,
      ],
    );
    return { ok: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[hm_events] insert failed', err);
    return { ok: false, error: String(err) };
  } finally {
    client?.release();
  }
}

export async function insertHMPolicyHit(hit: HMPolicyHitRow): Promise<HMWriteResult> {
  const p = getPool();
  if (!p) return { ok: true, noopReason: 'no_database_url' };
  let client: PoolClient | null = null;
  try {
    client = await p.connect();
    await ensureSchema(client);
    await client.query(
      `INSERT INTO hm_policy_hits (policy, endpoint, agent_id, reason, cost_micro_usd)
       VALUES ($1,$2,$3,$4,$5)`,
      [hit.policy, hit.endpoint, hit.agent_id, hit.reason, hit.cost_micro_usd ?? null],
    );
    return { ok: true };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[hm_policy_hits] insert failed', err);
    return { ok: false, error: String(err) };
  } finally {
    client?.release();
  }
}

export interface HMEventQuery {
  since?: string;   // ISO timestamp
  kinds?: readonly string[];
  endpoint?: string;
  limit?: number;
}

export async function queryHMEvents(q: HMEventQuery = {}): Promise<HMEventRow[]> {
  const p = getPool();
  if (!p) return [];
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 500);
  let client: PoolClient | null = null;
  try {
    client = await p.connect();
    await ensureSchema(client);
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.since) { params.push(q.since); where.push(`created_at > $${params.length}`); }
    if (q.kinds?.length) { params.push(q.kinds); where.push(`kind = ANY($${params.length}::text[])`); }
    if (q.endpoint) { params.push(q.endpoint); where.push(`endpoint = $${params.length}`); }
    params.push(limit);
    const sql = `SELECT kind, endpoint, version, chain, agent_id, trace_id, duration_ms, error, stack, payload_hash, context
                 FROM hm_events
                 ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                 ORDER BY created_at DESC
                 LIMIT $${params.length}`;
    const { rows } = await client.query<HMEventRow>(sql, params);
    return rows;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[hm_events] query failed', err);
    return [];
  } finally {
    client?.release();
  }
}

export async function queryHMPolicyHits(sinceIso?: string, limit = 100): Promise<HMPolicyHitRow[]> {
  const p = getPool();
  if (!p) return [];
  const capped = Math.min(Math.max(limit, 1), 500);
  let client: PoolClient | null = null;
  try {
    client = await p.connect();
    await ensureSchema(client);
    const params: unknown[] = [];
    let where = '';
    if (sinceIso) { params.push(sinceIso); where = 'WHERE created_at > $1'; }
    params.push(capped);
    const { rows } = await client.query<HMPolicyHitRow>(
      `SELECT policy, endpoint, agent_id, reason, cost_micro_usd
       FROM hm_policy_hits ${where}
       ORDER BY created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return rows;
  } catch {
    return [];
  } finally {
    client?.release();
  }
}
