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
