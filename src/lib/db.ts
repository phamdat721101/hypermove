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
  noopReason?: string;
  error?: string;
  hint?: ErrorHint;
}

export async function insertGeneratedMCP(req: GeneratedMCP): Promise<GeneratedMCPResult> {
  const p = getPool();
  if (!p) return { ok: true, noopReason: 'no_database_url' };

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
    return { ok: true, id: rows[0]?.id };
  } catch (err) {
    const hint = classifyError(err);
    console.error(`[generated-mcp] insert failed hint=${hint}`, err);
    return { ok: false, error: String(err), hint };
  } finally {
    client?.release();
  }
}
