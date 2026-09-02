/**
 * src/lib/mcp/dream/ownership.ts
 * -------------------------------
 * Agent ownership binding for Dream Cycle. This MCP server authenticates a
 * *session* (user/wallet/device), not the `agent_id` string a tool caller
 * supplies — so without this module, any authenticated caller could write
 * episode logs / trigger dream cycles into ANY agent_id, including one
 * "owned" by a different user. First-write-claims-it closes that gap.
 *
 * SOLID: Single Responsibility — this module owns ONLY the claim/check
 * decision over `mcp_agent_ownership`. Callers (ingest.ts, pipeline.ts) call
 * claimOrCheckOwnership() before touching any other dream_* table.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { withClient } from '../../db';

export interface OwnershipResult {
  ok: boolean;
  reason?: string;
}

function hashRecoverySecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Bootstrap or rotate a recovery secret for the current device owner only. */
export async function issueDeviceRecoverySecret(agentId: string, userId: string): Promise<OwnershipResult & { recovery_secret?: string }> {
  if (!userId.startsWith('device:')) return { ok: false, reason: 'recovery secrets are available only to device-auth sessions' };
  const secret = randomBytes(32).toString('base64url');
  const result = await withClient(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE mcp_agent_ownership SET recovery_secret_hash = $1 WHERE agent_id = $2 AND owner_user_id = $3`,
      [hashRecoverySecret(secret), agentId, userId],
    );
    return rowCount ?? 0;
  });
  if (result === null) return { ok: true, recovery_secret: secret };
  return result > 0 ? { ok: true, recovery_secret: secret } : { ok: false, reason: 'only the current device owner can bootstrap a recovery secret' };
}

/** Non-sensitive restart/recovery view for one agent namespace. */
export async function getDreamSession(agentId: string, userId: string) {
  const row = await withClient(async (client) => {
    const { rows } = await client.query<{ owner_user_id: string; session_id: string | null; run_id: string | null; is_delegate: boolean }>(
      `SELECT o.owner_user_id, s.session_id, r.run_id,
              EXISTS (SELECT 1 FROM mcp_agent_delegates d WHERE d.agent_id = o.agent_id AND d.delegate_user_id = $2) AS is_delegate
       FROM mcp_agent_ownership o
       LEFT JOIN LATERAL (SELECT session_id FROM mcp_paid_sessions WHERE user_id = $2 AND agent_id = o.agent_id AND expires_at > NOW() AND quota_used < quota_limit ORDER BY created_at DESC LIMIT 1) s ON true
       LEFT JOIN LATERAL (SELECT run_id FROM dream_cycle_runs WHERE agent_id = o.agent_id ORDER BY started_at DESC LIMIT 1) r ON true
       WHERE o.agent_id = $1 LIMIT 1`, [agentId, userId]);
    return rows[0] ?? null;
  });
  if (!row) return { ownership: 'unclaimed', recoveryHint: 'submit an episode or start a paid run to claim this agent_id' };
  if (row.owner_user_id === userId) return { ownership: 'current_session', ...(row.session_id ? { activePaymentSessionId: row.session_id } : {}), ...(row.run_id ? { lastRunId: row.run_id } : {}), recoveryHint: 'continue with this authenticated identity' };
  if (row.is_delegate) return { ownership: 'authorized_delegate', ...(row.session_id ? { activePaymentSessionId: row.session_id } : {}), ...(row.run_id ? { lastRunId: row.run_id } : {}), recoveryHint: 'continue with this delegated session' };
  if (row.owner_user_id.startsWith('device:')) return { ownership: 'recoverable_device_owner', recoveryHint: 'call reclaim_agent_ownership from a new device-auth session' };
  return { ownership: 'other_durable_owner', recoveryHint: 're-authenticate with the wallet or account that originally claimed this agent_id' };
}

/** List only namespaces owned by the requesting identity. This replaces the
 * trial-and-error ownership discovery that previously required a failed write. */
export async function listMyDreamAgentIds(userId: string): Promise<{ agent_ids: string[] }> {
  const rows = await withClient(async (client) => {
    const { rows } = await client.query<{ agent_id: string }>(
      `SELECT agent_id FROM mcp_agent_ownership WHERE owner_user_id = $1
       UNION
       SELECT agent_id FROM mcp_agent_delegates WHERE delegate_user_id = $1
       ORDER BY agent_id ASC`,
      [userId],
    );
    return rows;
  });
  return { agent_ids: (rows ?? []).map((row) => row.agent_id) };
}

/**
 * First caller for a given agent_id claims it for their session's userId.
 * Subsequent calls from the SAME userId or an authorized DELEGATE userId succeed.
 * A call from an unauthorized DIFFERENT userId against an already-claimed agent_id is rejected.
 *
 * Race-safety: uses INSERT ... ON CONFLICT DO NOTHING, then re-selects the
 * actual owner — so two concurrent first-claims for the same agent_id never
 * both "win"; the DB's unique constraint on agent_id is the source of truth,
 * not a check-then-insert race in application code.
 */
export async function claimOrCheckOwnership(agentId: string, userId: string): Promise<OwnershipResult> {
  const result = await withClient(async (client) => {
    await client.query(
      `INSERT INTO mcp_agent_ownership (agent_id, owner_user_id) VALUES ($1, $2)
       ON CONFLICT (agent_id) DO NOTHING`,
      [agentId, userId],
    );
    const { rows } = await client.query<{ owner_user_id: string }>(
      `SELECT owner_user_id FROM mcp_agent_ownership WHERE agent_id = $1 LIMIT 1`,
      [agentId],
    );
    const owner = rows[0]?.owner_user_id ?? null;
    if (owner === null || owner === userId) return { authorized: true };

    // Check delegate authorization
    const delegateRes = await client.query<{ delegate_user_id: string }>(
      `SELECT delegate_user_id FROM mcp_agent_delegates WHERE agent_id = $1 AND delegate_user_id = $2 LIMIT 1`,
      [agentId, userId],
    );
    if ((delegateRes.rows?.length ?? 0) > 0) return { authorized: true };

    return { authorized: false, owner };
  });

  // withClient() returns null when DATABASE_URL is unset (dev/mock-first
  // mode) — degrade to "allow" so the rest of the pipeline remains testable
  // without a live DB, matching every other dream_*/mcp_* module's no-op
  // convention (see db.ts's insertRegistryRequest, etc.).
  if (result === null) return { ok: true };

  if (result.authorized) return { ok: true };

  return {
    ok: false,
    reason: `agent_id "${agentId}" is already claimed by a different session. Choose a different agent_id, or if you own this agent_id, verify you're using the same authenticated session/credentials that first claimed it, or have the owner grant delegation to your session via grant_agent_delegate.`,
  };
}

/**
 * Reclaim ownership of an agent_id currently owned by a DEVICE-kind session
 * (2026-08-10, dream-cycle blocker escalation, issue #2).
 *
 * Root cause this closes: device-auth.ts's device-code flow mints a brand
 * new, cryptographically random userId (`device:${randomBytes(12)...}`) on
 * EVERY approval — there is no mechanism to link two separate device-auth
 * sessions to the same real-world operator. Once claimOrCheckOwnership()
 * binds an agent_id to one such session, that agent_id is PERMANENTLY
 * locked out for any future device-auth session, even the same human
 * approving from the same terminal — the only workaround was a fresh
 * agent_id every time, which fragments an agent's memory across disposable
 * identities instead of accumulating it.
 *
 * Security model (deliberately matches device-auth's own documented
 * "trust-the-terminal" bar, not a downgrade from it — see device-auth.ts's
 * own header comment): reclaim is allowed ONLY when the CURRENT owner is
 * itself a device-kind session (owner_user_id starts with "device:"). A
 * wallet-authed ("wallet:0x...") or WorkOS-authed owner is NEVER reclaimable
 * this way — those identities are already durable/re-provable by their own
 * mechanism (re-sign with the same wallet, re-auth with the same account),
 * so silently allowing a random new device session to take them over would
 * be a genuine security regression, not parity. Reclaiming a device-owned
 * agent_id requires only that the calling session ALSO reach this MCP
 * server with a live session — the exact same trust bar device-auth's own
 * approval flow already requires (anyone who can complete a device-code
 * approval already has the level of access this reclaim grants).
 *
 * No cooldown/rate-limit on reclaim itself — the underlying device-auth
 * approval flow this depends on is already the real gate (5-minute code
 * TTL, one-shot approval, per-IP rate-limited /device/start; see
 * device-auth.ts's own header comment for why those three mitigations are
 * "non-negotiable, not defense-in-depth extras").
 */
export async function reclaimDeviceOwnership(agentId: string, newUserId: string, recoverySecret: string): Promise<OwnershipResult> {
  if (!recoverySecret) return { ok: false, reason: 'recovery_secret is required to reclaim a device-owned agent_id' };
  const result = await withClient(async (client) => {
    const { rows } = await client.query<{ owner_user_id: string; recovery_secret_hash: string | null }>(
      `SELECT owner_user_id, recovery_secret_hash FROM mcp_agent_ownership WHERE agent_id = $1 LIMIT 1`,
      [agentId],
    );
    const currentOwner = rows[0]?.owner_user_id ?? null;
    if (currentOwner === null) {
      return { outcome: 'not_claimed' as const };
    }
    if (currentOwner === newUserId) {
      return { outcome: 'already_owner' as const };
    }
    if (!currentOwner.startsWith('device:')) {
      return { outcome: 'not_reclaimable' as const, currentOwner };
    }
    const expected = rows[0]?.recovery_secret_hash;
    const supplied = hashRecoverySecret(recoverySecret);
    if (!expected || expected.length !== supplied.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) return { outcome: 'invalid_secret' as const };
    await client.query(
      `UPDATE mcp_agent_ownership SET owner_user_id = $1, claimed_at = NOW() WHERE agent_id = $2`,
      [newUserId, agentId],
    );
    return { outcome: 'reclaimed' as const };
  });

  // withClient() returns null when DATABASE_URL is unset — degrade to
  // "allow" so the tool is exercisable without a live DB, matching every
  // other dream_*/mcp_* module's no-op convention.
  if (result === null) return { ok: true };

  switch (result.outcome) {
    case 'not_claimed':
      return { ok: false, reason: `agent_id "${agentId}" has no existing owner to reclaim from — call submit_episode_log or start_dream directly to claim it fresh.` };
    case 'already_owner':
      return { ok: true };
    case 'not_reclaimable':
      return {
        ok: false,
        reason: `agent_id "${agentId}" is owned by a wallet- or account-authenticated session, not a device-auth session — reclaim is only available for agent_ids currently owned by an anonymous device-auth session. If you own this agent_id, re-authenticate with the same wallet/account that originally claimed it instead.`,
      };
    case 'invalid_secret':
      return { ok: false, reason: 'recovery_secret is invalid or has not been bootstrapped by the current device owner' };
    case 'reclaimed':
      return { ok: true };
  }
}

/**
 * Grant write and dream authorization to a secondary session/user identity.
 * Can ONLY be performed by the actual primary owner of the agent_id.
 */
export async function grantAgentDelegate(agentId: string, ownerUserId: string, delegateUserId: string): Promise<OwnershipResult> {
  const trimmedDelegate = delegateUserId?.trim();
  if (!trimmedDelegate) {
    return { ok: false, reason: 'delegate_user_id cannot be empty' };
  }
  const result = await withClient(async (client) => {
    const { rows } = await client.query<{ owner_user_id: string }>(
      `SELECT owner_user_id FROM mcp_agent_ownership WHERE agent_id = $1 LIMIT 1`,
      [agentId],
    );
    const currentOwner = rows[0]?.owner_user_id ?? null;
    if (currentOwner === null) {
      return { outcome: 'not_claimed' as const };
    }
    if (currentOwner !== ownerUserId) {
      return { outcome: 'not_owner' as const };
    }
    await client.query(
      `INSERT INTO mcp_agent_delegates (agent_id, delegate_user_id) VALUES ($1, $2)
       ON CONFLICT (agent_id, delegate_user_id) DO NOTHING`,
      [agentId, trimmedDelegate],
    );
    return { outcome: 'granted' as const };
  });

  if (result === null) return { ok: true };

  switch (result.outcome) {
    case 'not_claimed':
      return { ok: false, reason: `agent_id "${agentId}" has no existing owner to grant delegation from.` };
    case 'not_owner':
      return { ok: false, reason: `only the primary owner of agent_id "${agentId}" can grant delegation.` };
    case 'granted':
      return { ok: true };
  }
}

/**
 * Revoke delegation from a secondary session/user identity.
 * Can ONLY be performed by the actual primary owner of the agent_id.
 */
export async function revokeAgentDelegate(agentId: string, ownerUserId: string, delegateUserId: string): Promise<OwnershipResult> {
  const trimmedDelegate = delegateUserId?.trim();
  if (!trimmedDelegate) {
    return { ok: false, reason: 'delegate_user_id cannot be empty' };
  }
  const result = await withClient(async (client) => {
    const { rows } = await client.query<{ owner_user_id: string }>(
      `SELECT owner_user_id FROM mcp_agent_ownership WHERE agent_id = $1 LIMIT 1`,
      [agentId],
    );
    const currentOwner = rows[0]?.owner_user_id ?? null;
    if (currentOwner === null) {
      return { outcome: 'not_claimed' as const };
    }
    if (currentOwner !== ownerUserId) {
      return { outcome: 'not_owner' as const };
    }
    const { rowCount } = await client.query(
      `DELETE FROM mcp_agent_delegates WHERE agent_id = $1 AND delegate_user_id = $2`,
      [agentId, trimmedDelegate],
    );
    return { outcome: 'revoked' as const, deletedCount: rowCount ?? 0 };
  });

  if (result === null) return { ok: true };

  switch (result.outcome) {
    case 'not_claimed':
      return { ok: false, reason: `agent_id "${agentId}" has no existing owner.` };
    case 'not_owner':
      return { ok: false, reason: `only the primary owner of agent_id "${agentId}" can revoke delegation.` };
    case 'revoked':
      return { ok: true };
  }
}

/**
 * List all authorized delegate user IDs for an agent.
 * Available to the owner or authorized delegates.
 */
export async function listAgentDelegates(agentId: string, userId: string): Promise<{ ok: boolean; delegates?: string[]; reason?: string }> {
  const auth = await claimOrCheckOwnership(agentId, userId);
  if (!auth.ok) {
    return { ok: false, reason: auth.reason ?? 'not authorized to view delegates' };
  }

  const rows = await withClient(async (client) => {
    const { rows } = await client.query<{ delegate_user_id: string }>(
      `SELECT delegate_user_id FROM mcp_agent_delegates WHERE agent_id = $1 ORDER BY granted_at ASC`,
      [agentId],
    );
    return rows;
  });

  return { ok: true, delegates: (rows ?? []).map((r) => r.delegate_user_id) };
}
