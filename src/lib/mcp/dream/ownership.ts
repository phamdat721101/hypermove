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

import { withClient } from '../../db';

export interface OwnershipResult {
  ok: boolean;
  reason?: string;
}

/**
 * First caller for a given agent_id claims it for their session's userId.
 * Subsequent calls from the SAME userId succeed (idempotent). A call from a
 * DIFFERENT userId against an already-claimed agent_id is rejected.
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
    return rows[0]?.owner_user_id ?? null;
  });

  // withClient() returns null when DATABASE_URL is unset (dev/mock-first
  // mode) — degrade to "allow" so the rest of the pipeline remains testable
  // without a live DB, matching every other dream_*/mcp_* module's no-op
  // convention (see db.ts's insertRegistryRequest, etc.).
  if (result === null) return { ok: true };

  if (result === userId) return { ok: true };
  return { ok: false, reason: `agent_id "${agentId}" is already claimed by a different session` };
}
