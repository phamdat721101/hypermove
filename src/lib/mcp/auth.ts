/**
 * src/lib/mcp/auth.ts
 * -------------------
 * Raven's 3-layer auth gate, adapted:
 *   1. Admin-token bypass  (SHA-256, timing-safe) — internal ops.
 *   2. Loopback-dev bypass (env + loopback hostname second-factor).
 *   3a. Wallet signature (EIP-191, no third-party dependency — the
 *       identity system this product's users already have).
 *   3b. WorkOS AuthKit OAuth (opaque bearer token, for email-only sign-in).
 *
 * Both 3a and 3b terminate in the same storeToken()/mcp_tokens table — the
 * gateway doesn't care which identity system issued the token, only that
 * validateToken() can find it.
 *
 * When the auth sub-flag is off, authenticate() returns an anonymous session so
 * the rest of the gateway still functions (rollback contract).
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextRequest } from 'next/server';
import { verifyMessage } from 'viem';
import { withClient } from '../db';
import { fetchWithTimeout } from './http';
import { isMcpAuthEnabled } from '../platform-flag';

export type SessionKind = 'admin' | 'dev' | 'user' | 'device';
export interface McpSession {
  userId: string;
  email?: string;
  tier: 'free' | 'paid' | 'enterprise' | 'admin';
  kind: SessionKind;
}

export type AuthOutcome =
  | { ok: true; session: McpSession }
  | { ok: false; status: number; message: string; wwwAuthenticate?: string };

const TOKEN_TTL_DAYS = 90;

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

function timingSafeEqualStr(a: string, b: string): boolean {
  const da = sha256(a);
  const db = sha256(b);
  return da.length === db.length && timingSafeEqual(da, db);
}

function isLoopback(req: NextRequest): boolean {
  const host = (req.headers.get('host') ?? '').split(':')[0];
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}

function bearer(req: NextRequest): string | null {
  const h = req.headers.get('authorization');
  return h?.toLowerCase().startsWith('bearer ') ? h.slice(7).trim() : null;
}

// ─── Token store ────────────────────────────────────────────────────────────

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Persists a new bearer token and returns it, or null if persistence failed
 * (e.g. DATABASE_URL unset/unreachable). Callers MUST check for null — a
 * token that was never written can never authenticate a later request, so
 * returning it anyway would hand out keys that silently never work.
 */
export async function storeToken(userId: string, email: string | undefined): Promise<string | null> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TOKEN_TTL_DAYS * 86_400_000).toISOString();
  const persisted = await withClient(async (client) => {
    await client.query(
      `INSERT INTO mcp_users (workos_user_id, email, last_seen_at) VALUES ($1,$2,NOW())
       ON CONFLICT (workos_user_id) DO UPDATE SET last_seen_at = NOW()`,
      [userId, email ?? null],
    );
    await client.query(
      `INSERT INTO mcp_tokens (token_hash, user_id, email, expires_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (token_hash) DO NOTHING`,
      [hashToken(token), userId, email ?? null, expiresAt],
    );
    return true;
  });
  return persisted ? token : null;
}

async function validateToken(token: string): Promise<McpSession | null> {
  const row = await withClient(async (client) => {
    const { rows } = await client.query<{ user_id: string; email: string | null; tier: string | null }>(
      `SELECT t.user_id, t.email, u.tier
         FROM mcp_tokens t
         LEFT JOIN mcp_users u ON u.workos_user_id = t.user_id
        WHERE t.token_hash = $1 AND t.expires_at > NOW() LIMIT 1`,
      [hashToken(token)],
    );
    return rows[0] ?? null;
  });
  if (!row) return null;

  // userId prefix convention: "wallet:0x…" (verifyWalletSignature) and
  // "device:<id>" (device-code flow, see /api/mcp/device/poll) both identify
  // their session kind this way; a bare WorkOS user id has no prefix → 'user'.
  const kind: SessionKind = row.user_id.startsWith('device:') ? 'device' : 'user';

  // Hard cap (defense-in-depth): no code path upgrades mcp_users.tier today,
  // but a device-kind identity — anonymous, no wallet/email, issued from an
  // unauthenticated any-host endpoint (see device/start's rate-limit comment)
  // — must NEVER be treated as anything above 'free', even if a tier-upgrade
  // mechanism is added later without updating this check. Real per-call
  // payment settlement (paywall.ts) is unaffected by this — that's a
  // time-boxed paid session, not a permanent tier change, and stays available
  // to every session kind including 'device'.
  const tier: McpSession['tier'] = kind === 'device' ? 'free' : ((row.tier as McpSession['tier']) ?? 'free');

  return { userId: row.user_id, email: row.email ?? undefined, tier, kind };
}

// ─── The gate ────────────────────────────────────────────────────────────────

export async function authenticate(req: NextRequest): Promise<AuthOutcome> {
  if (!isMcpAuthEnabled()) {
    return { ok: true, session: { userId: 'anonymous', tier: 'free', kind: 'user' } };
  }

  // Layer 1 — admin token.
  const adminSecret = process.env.HYPERMOVE_MCP_ADMIN_TOKEN;
  if (adminSecret) {
    const presented = bearer(req) ?? req.headers.get('x-mcp-admin-token');
    if (presented && timingSafeEqualStr(presented, adminSecret)) {
      return { ok: true, session: { userId: 'admin', tier: 'admin', kind: 'admin' } };
    }
  }

  // Layer 2 — loopback dev bypass.
  if (process.env.HYPERMOVE_DEV_UNAUTHENTICATED === 'true' && isLoopback(req)) {
    return { ok: true, session: { userId: 'dev-loopback', tier: 'free', kind: 'dev' } };
  }

  // Layer 3 — OAuth bearer token.
  const token = bearer(req);
  if (token) {
    const session = await validateToken(token);
    if (session) return { ok: true, session };
  }

  return {
    ok: false,
    status: 401,
    message: 'authentication required — sign in via /api/mcp/authorize',
    wwwAuthenticate: `Bearer realm="hypermove.duckdns.org/mcp", authorize="/api/mcp/authorize"`,
  };
}

// ─── WorkOS AuthKit helpers ──────────────────────────────────────────────────

export function workosAuthorizeUrl(state: string): string | null {
  const clientId = process.env.WORKOS_CLIENT_ID;
  const redirectUri = process.env.WORKOS_REDIRECT_URI;
  if (!clientId || !redirectUri) return null;
  const u = new URL('https://api.workos.com/user_management/authorize');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('provider', 'authkit');
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('state', state);
  return u.toString();
}

/** Exchange an OAuth code for a WorkOS user. Returns null on failure. */
export async function workosExchange(code: string): Promise<{ userId: string; email?: string } | null> {
  const apiKey = process.env.WORKOS_API_KEY;
  const clientId = process.env.WORKOS_CLIENT_ID;
  if (!apiKey || !clientId) return null;
  try {
    const res = await fetchWithTimeout('https://api.workos.com/user_management/authenticate', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ client_id: clientId, grant_type: 'authorization_code', code }),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { user?: { id: string; email?: string } };
    return body.user ? { userId: body.user.id, email: body.user.email } : null;
  } catch {
    return null;
  }
}

// ─── Wallet-signature auth (EIP-191) ────────────────────────────────────────

const WALLET_MESSAGE_MAX_AGE_MS = 5 * 60_000; // signed message must be fresh

/**
 * Verify a wallet owns `address` by checking it signed `message`, and that
 * `message` embeds this exact address + a recent timestamp (anti-replay).
 * Returns a stable userId ("wallet:0x…") suitable for storeToken().
 */
export async function verifyWalletSignature(
  address: string,
  message: string,
  signature: `0x${string}`,
): Promise<{ ok: true; userId: string } | { ok: false; reason: string }> {
  const addr = address.toLowerCase();
  if (!/^0x[a-f0-9]{40}$/.test(addr)) return { ok: false, reason: 'invalid address' };
  if (!message.includes(addr) && !message.toLowerCase().includes(addr)) {
    return { ok: false, reason: 'message does not reference the signing address' };
  }
  const tsMatch = message.match(/timestamp:\s*(\d+)/);
  const ts = tsMatch ? Number(tsMatch[1]) : NaN;
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > WALLET_MESSAGE_MAX_AGE_MS) {
    return { ok: false, reason: 'signature expired — request a new one' };
  }
  const valid = await verifyMessage({ address: address as `0x${string}`, message, signature }).catch(() => false);
  if (!valid) return { ok: false, reason: 'signature does not match address' };
  return { ok: true, userId: `wallet:${addr}` };
}
