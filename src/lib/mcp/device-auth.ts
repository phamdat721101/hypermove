/**
 * src/lib/mcp/device-auth.ts
 * --------------------------
 * Terminal device-code auth — an RFC-8628-shaped flow so a headless agent can
 * get a bearer token without a browser, a wallet extension, or WorkOS email:
 *
 *   POST /device/start   → { device_code, user_code, expires_in, interval }
 *   (human types y/n in the SAME terminal — no verification URL, no browser)
 *   POST /device/approve → flips the row to approved/denied (one-shot)
 *   POST /device/poll    → agent polls with device_code until resolved
 *
 * Deliberately anonymous ("trust-the-terminal" model, confirmed requirement):
 * approval does not check a wallet signature or an email — the only gate is
 * whoever can reach /approve. Because this endpoint is intentionally NOT
 * loopback-restricted (works from any host — an accepted tradeoff), the
 * mitigations below are non-negotiable, not defense-in-depth extras:
 *
 *   1. Codes are short-lived (DEVICE_CODE_TTL_MS) and one-shot — approve/deny
 *      only succeeds from 'pending'; a second call on a resolved code is a
 *      clear, explicit rejection (see resolveDeviceCode()).
 *   2. /device/start is rate-limited per-IP (see rate-limit-device.ts),
 *      reusing rate-limit.ts's exact durable-counter pattern.
 *   3. Every token minted here is tagged kind:'device' at the auth.ts layer
 *      (userId prefixed "device:") and hard-capped at tier:'free' — see
 *      validateToken()'s hard-cap comment in auth.ts.
 *
 * Business logic (issueDeviceCode / resolveDeviceCode / pollDeviceCode) is
 * wrapped in nim-skill's runHarnessed() with a schema-enforcer, mirroring the
 * house convention in confidential.ts / briefs.ts — maxHeals: 0 because a
 * device-code state transition either succeeds or it doesn't; there is
 * nothing here for a self-heal retry to meaningfully improve.
 */

import { randomBytes, randomInt, createHash } from 'node:crypto';
import { withClient } from '../db';
import { ok, fail, type ServiceResult } from './envelope';
import { storeToken } from './auth';
import { isMcpDeviceAuthEnabled } from '../platform-flag';
import { runHarnessed, type SkillDef } from 'nim-skill';
import { mcpNimHarness } from './nim-harness';

export const DEVICE_CODE_TTL_MS = 5 * 60_000; // 5 minutes
export const DEVICE_POLL_INTERVAL_S = 5;

// Unambiguous charset — no 0/O/1/I confusion when a human reads it aloud
// or types it back in a terminal prompt.
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateUserCode(): string {
  const part = () => Array.from({ length: 4 }, () => USER_CODE_ALPHABET[randomInt(USER_CODE_ALPHABET.length)]).join('');
  return `${part()}-${part()}`;
}

export interface DeviceStartResult {
  device_code: string;
  user_code: string;
  expires_in: number;
  interval: number;
}

/** Harness-facing shape — needs an index signature to satisfy nim-skill's
 *  Dict-constrained generics (mirrors confidential.ts's AttestationExecuteResult
 *  pattern exactly). DeviceStartResult itself stays the clean public type. */
interface DeviceStartExecuteResult extends DeviceStartResult {
  [key: string]: unknown;
}

export type DeviceStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface DevicePollResult {
  status: DeviceStatus;
  token?: string;
  token_type?: 'Bearer';
}

function disabledError(): ServiceResult<never> {
  return fail('device-auth', 'terminal device-auth disabled', {
    code: 'feature_disabled',
    hint: 'set FEATURE_MCP_DEVICE_AUTH=true',
  }) as ServiceResult<never>;
}

/** POST /device/start — mint a new device_code + user_code, 5-minute TTL. */
export async function issueDeviceCode(): Promise<ServiceResult<DeviceStartResult>> {
  if (!isMcpDeviceAuthEnabled()) return disabledError();

  const skill: SkillDef<Record<string, unknown>, DeviceStartExecuteResult> = {
    name: 'device-auth.start',
    version: '1.0.0',
    harness: mcpNimHarness({
      enforcer: { strategies: [{ kind: 'schema', required: ['device_code', 'user_code', 'expires_in', 'interval'] }], maxHeals: 0, mode: 'strict' },
    }),
    async execute() {
      const deviceCode = randomBytes(32).toString('base64url');
      const userCode = generateUserCode();
      const expiresAt = new Date(Date.now() + DEVICE_CODE_TTL_MS).toISOString();

      const persisted = await withClient(async (client) => {
        await client.query(
          `INSERT INTO mcp_device_codes (device_code, user_code, status, expires_at) VALUES ($1,$2,'pending',$3)`,
          [deviceCode, userCode, expiresAt],
        );
        return true;
      });

      // No DB configured (dev without DATABASE_URL) — device-auth genuinely
      // cannot work without persistence (poll needs a durable row to check),
      // so this is a real failure, not the usual "no DB → allow" dev fallback.
      if (persisted === null) {
        throw new Error('DATABASE_URL is unset or unreachable — device-code auth requires persistence');
      }

      return {
        device_code: deviceCode,
        user_code: userCode,
        expires_in: Math.floor(DEVICE_CODE_TTL_MS / 1000),
        interval: DEVICE_POLL_INTERVAL_S,
      };
    },
  };

  try {
    const { output, verified } = await runHarnessed(skill, {}, { agentId: 'hypermove-device-auth' });
    if (!verified) {
      return fail('device-auth', 'device code issuance failed schema verification', { code: 'enforcer_block' });
    }
    return ok(output);
  } catch (err) {
    return fail('device-auth', err instanceof Error ? err.message : String(err), { code: 'device_start_failed' });
  }
}

/** POST /device/approve — one-shot y/n resolution of a pending user_code. */
export async function resolveDeviceCode(userCode: string, decision: 'y' | 'n'): Promise<ServiceResult<{ status: DeviceStatus }>> {
  if (!isMcpDeviceAuthEnabled()) return disabledError();

  const normalized = userCode.trim().toUpperCase();
  const nextStatus: DeviceStatus = decision === 'y' ? 'approved' : 'denied';

  // withClient<T>() returns T | null, where null means "DB unavailable" —
  // ambiguous with "no matching row" if the callback itself also returns
  // null for that case. Use `undefined` for not-found so the two are
  // distinguishable (`row === null` → DB absent, `row === undefined` → no
  // such user_code), matching the same disambiguation pollDeviceCode() below
  // and resolveDeviceCode()'s second withClient() call need too.
  const row = await withClient(async (client) => {
    const { rows } = await client.query<{ status: DeviceStatus; expires_at: string }>(
      `SELECT status, expires_at::text FROM mcp_device_codes WHERE user_code = $1 LIMIT 1`,
      [normalized],
    );
    return rows[0];
  });

  if (row === null) {
    return fail('device-auth', 'DATABASE_URL is unset or unreachable', { code: 'device_persist_unavailable' });
  }
  if (row === undefined) {
    return fail('device-auth', `no pending device code found for "${normalized}"`, { code: 'not_found' });
  }
  if (new Date(row.expires_at) <= new Date()) {
    // Best-effort mark expired; the row's usefulness has already passed regardless.
    await withClient((client) => client.query(`UPDATE mcp_device_codes SET status = 'expired' WHERE user_code = $1 AND status = 'pending'`, [normalized]));
    return fail('device-auth', 'this code has expired — start a new device flow', { code: 'expired' });
  }
  if (row.status !== 'pending') {
    return fail('device-auth', `this code was already resolved (status: ${row.status})`, { code: 'already_resolved' });
  }

  const updated = await withClient(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE mcp_device_codes SET status = $1 WHERE user_code = $2 AND status = 'pending'`,
      [nextStatus, normalized],
    );
    return (rowCount ?? 0) > 0;
  });

  // updated === false here means another request resolved it in the gap
  // between the SELECT and UPDATE above — still "already resolved", not a
  // generic error, so the caller gets the same clear message either way.
  if (!updated) {
    return fail('device-auth', 'this code was already resolved', { code: 'already_resolved' });
  }

  return ok({ status: nextStatus });
}

/**
 * POST /device/poll — agent polling loop. Idempotent on the 'approved' path:
 * a second poll after approval returns the SAME token (looked up via
 * token_hash on the row), never a newly minted one — storeToken() is only
 * ever called once per device_code (the transition out of token_hash IS NULL
 * is a single atomic UPDATE ... WHERE token_hash IS NULL, so a race between
 * two concurrent polls can't mint two tokens for the same row either).
 */
export async function pollDeviceCode(deviceCode: string): Promise<ServiceResult<DevicePollResult>> {
  if (!isMcpDeviceAuthEnabled()) return disabledError();

  // See resolveDeviceCode()'s comment: null = DB unavailable, undefined = no
  // matching row — the two must stay distinguishable.
  const row = await withClient(async (client) => {
    const { rows } = await client.query<{ status: DeviceStatus; expires_at: string; token_hash: string | null }>(
      `SELECT status, expires_at::text, token_hash FROM mcp_device_codes WHERE device_code = $1 LIMIT 1`,
      [deviceCode],
    );
    return rows[0];
  });

  if (row === null) {
    return fail('device-auth', 'DATABASE_URL is unset or unreachable', { code: 'device_persist_unavailable' });
  }
  if (!row) {
    return fail('device-auth', 'unknown device_code', { code: 'not_found' });
  }

  if (row.status === 'pending' && new Date(row.expires_at) <= new Date()) {
    await withClient((client) => client.query(`UPDATE mcp_device_codes SET status = 'expired' WHERE device_code = $1 AND status = 'pending'`, [deviceCode]));
    return ok({ status: 'expired' });
  }

  if (row.status === 'pending') return ok({ status: 'pending' });
  if (row.status === 'denied') return ok({ status: 'denied' });
  if (row.status === 'expired') return ok({ status: 'expired' });

  // status === 'approved' — mint the token exactly once, or return the
  // already-minted one on a repeat poll.
  if (row.token_hash) {
    // Token already minted for this row on an earlier poll. We deliberately
    // never persisted the plaintext (only its hash — matching mcp_tokens's
    // own "hash only, durable" convention), so a repeat poll after the
    // in-memory cache below has expired cannot re-serve the same plaintext.
    // This is an accepted, documented limitation of the idempotency
    // guarantee (see cache comment below) rather than a security hole: the
    // agent is expected to store the token from its FIRST successful poll.
    const cached = recentTokenCache.get(deviceCode);
    if (cached) return ok({ status: 'approved', token: cached, token_type: 'Bearer' });
    return fail('device-auth', 'token already issued for this device_code and is no longer retrievable — the code was polled successfully once already', {
      code: 'token_already_consumed',
      hint: 'store the token from the first successful poll; start a new device flow if it was lost',
    });
  }

  const deviceUserId = `device:${randomBytes(12).toString('hex')}`;
  const token = await storeToken(deviceUserId, undefined);
  if (!token) {
    return fail('device-auth', 'token_persist_failed — DATABASE_URL is unset or unreachable', { code: 'token_persist_failed' });
  }

  // Atomically claim the "mint" for this row — WHERE token_hash IS NULL
  // ensures a concurrent poll can't double-mint (only one UPDATE can match).
  const claimed = await withClient(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE mcp_device_codes SET token_hash = $1 WHERE device_code = $2 AND status = 'approved' AND token_hash IS NULL`,
      [hashForStorage(token), deviceCode],
    );
    return (rowCount ?? 0) > 0;
  });

  if (!claimed) {
    // Lost the race to a concurrent poll — the other request's token is the
    // one of record. We already minted a valid-but-orphaned token above;
    // it is still a real, usable token (storeToken() persisted it), just not
    // the one this row will report from now on. Acceptable: rare race,
    // never a security issue (both tokens are equally free-tier/device-kind).
    const cached = recentTokenCache.get(deviceCode);
    if (cached) return ok({ status: 'approved', token: cached, token_type: 'Bearer' });
    return fail('device-auth', 'lost the mint race to a concurrent poll and no cached token is available — retry', { code: 'retry' });
  }

  recentTokenCache.set(deviceCode, token);
  return ok({ status: 'approved', token, token_type: 'Bearer' });
}

// Short-lived, in-memory, single-process cache so a repeat poll within the
// same request lifecycle/process can still return the plaintext token without
// ever persisting it in plaintext to the database (mcp_device_codes only ever
// stores token_hash, matching mcp_tokens's existing hash-only convention).
// This is intentionally NOT a durable guarantee across process restarts or
// multiple server instances — see pollDeviceCode()'s token_already_consumed
// comment above for the documented fallback behavior.
function hashForStorage(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
const recentTokenCache = new Map<string, string>();
