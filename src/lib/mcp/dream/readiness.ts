/**
 * Agent-facing, read-only answer to: "do I have a lesson to use, and if not,
 * what is the safe manual next step?" This intentionally does not claim an
 * agent namespace or start a paid run.
 */

import { withClient } from '../../db';

export type DreamReadinessState =
  | 'uninitialized'
  | 'idle_no_lessons'
  | 'ready_to_dream'
  | 'run_active'
  | 'ownership_recovery_required';

export interface DreamReadiness {
  agent_id: string;
  state: DreamReadinessState;
  pending_episodes: number;
  learned_constraints: number;
  next_action: string;
  manual_start_sequence: string[];
}

const MANUAL_START_SEQUENCE = [
  'Call submit_episode_log with at least one meaningful episode step.',
  'Call get_dream_episode_diagnostics to confirm pending episodes use this exact agent_id.',
  'Request and settle the quote required by start_dream, then retry start_dream with the returned payment headers.',
  'Call get_wake_context after the run completes and use its active constraints in the next task.',
];

export async function getDreamReadiness(agentId: string, userId: string): Promise<DreamReadiness> {
  const result = await withClient(async (client) => {
    const [ownerResult, pendingResult, memoriesResult, activeRunResult] = await Promise.all([
      client.query<{ owner_user_id: string }>('SELECT owner_user_id FROM mcp_agent_ownership WHERE agent_id = $1 LIMIT 1', [agentId]),
      client.query<{ count: string }>('SELECT COUNT(*)::text AS count FROM dream_episode_logs WHERE agent_id = $1 AND consumed_by_run IS NULL', [agentId]),
      client.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM dream_consolidated_memories WHERE agent_id = $1 AND quarantined_at IS NULL AND type IN ('rule', 'error_pattern', 'preference')`, [agentId]),
      client.query<{ run_id: string }>("SELECT run_id FROM dream_cycle_runs WHERE agent_id = $1 AND status = 'started' ORDER BY started_at DESC LIMIT 1", [agentId]),
    ]);
    return {
      owner: ownerResult.rows[0]?.owner_user_id ?? null,
      pending: Number(pendingResult.rows[0]?.count ?? 0),
      constraints: Number(memoriesResult.rows[0]?.count ?? 0),
      hasActiveRun: Boolean(activeRunResult.rows[0]),
    };
  });

  const base = { agent_id: agentId, pending_episodes: result?.pending ?? 0, learned_constraints: result?.constraints ?? 0, manual_start_sequence: MANUAL_START_SEQUENCE };
  if (!result?.owner) return { ...base, state: 'uninitialized', next_action: 'Start by submitting an episode. That first write claims this agent_id for the current authenticated session.' };
  if (result.owner !== userId) return { ...base, state: 'ownership_recovery_required', next_action: 'Use the session that owns this agent_id, or for a device-auth namespace use reclaim_agent_ownership with its stored recovery secret.' };
  if (result.hasActiveRun) return { ...base, state: 'run_active', next_action: 'A Dream run is active. Wait for it to complete, then call get_wake_context; do not start a second run.' };
  if (result.constraints === 0 && result.pending === 0) return { ...base, state: 'idle_no_lessons', next_action: 'No specific Dream lesson exists yet. Work normally, submit a meaningful episode when finished, then use the manual start sequence.' };
  return { ...base, state: 'ready_to_dream', next_action: result.pending > 0 ? 'Pending episodes are ready for a manual, quote-bound start_dream run.' : 'Use get_wake_context now; it contains your available learned constraints.' };
}
