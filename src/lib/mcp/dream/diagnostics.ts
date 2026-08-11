/**
 * src/lib/mcp/dream/diagnostics.ts
 * -----------------------------------
 * Self-serve diagnostics for the `episodes_in: 0` bug (2026-08-11
 * status-review upgrade, PRD 02). This module does NOT root-cause or fix
 * that bug — no session in the corpus has had the live server/log access
 * needed to do that (see biz-team/bd-team/research/hypermove/
 * 2026-08-11-dream-cycle-fcc-rlusd-status-review/04-prds-hypermove-
 * upgrades.md, PRD 02). What it DOES do: expose, via a caller-facing MCP
 * tool, the exact comparison the corpus's leading (still unconfirmed)
 * hypothesis needs — an `agent_id` string mismatch (case/whitespace/
 * UUID-format) between the write side (submit_episode_log ->
 * dream_episode_logs) and the read side (start_dream's unconsumed-episode
 * fetch) — so a caller with only an MCP bearer token, not server access,
 * can check this themselves.
 *
 * Gated by the same claimOrCheckOwnership() ownership binding every other
 * Dream Cycle write-path tool already uses, so this cannot be used to probe
 * a different session's agent_id namespace.
 */

import { withClient } from '../../db';
import { claimOrCheckOwnership } from './ownership';

export interface DreamEpisodeDiagnostics {
  agent_id: string;
  live_unconsumed_count: number;
  last_submit_agent_id: string | null;
  last_submit_at: string | null;
  last_run_agent_id: string | null;
  last_run_at: string | null;
  /**
   * Byte-for-byte comparison of last_submit_agent_id vs. last_run_agent_id.
   * `null` when either side has no data yet (nothing to compare). This is
   * the field that directly targets the corpus's leading hypothesis: a
   * case/whitespace/UUID-format mismatch between what was written and what
   * was read would surface here as `false` while a naive glance at two
   * strings that "look the same" in a log line might not catch it.
   */
  agent_id_exact_match: boolean | null;
  ownership_error?: string;
}

/**
 * Returns diagnostics for one agent_id, scoped to the calling session's
 * ownership. Read-only from the caller's perspective, but still runs
 * claimOrCheckOwnership() — a caller diagnosing an agent_id they've never
 * touched before is a legitimate first-touch case (matches
 * submit_episode_log/start_dream's own claim-on-first-write semantics), and
 * this keeps one consistent ownership rule across every Dream Cycle tool
 * rather than a read-only tool being the sole exception.
 */
export async function getDreamEpisodeDiagnostics(agentId: string, userId: string): Promise<DreamEpisodeDiagnostics> {
  const ownership = await claimOrCheckOwnership(agentId, userId);
  if (!ownership.ok) {
    return {
      agent_id: agentId,
      live_unconsumed_count: 0,
      last_submit_agent_id: null,
      last_submit_at: null,
      last_run_agent_id: null,
      last_run_at: null,
      agent_id_exact_match: null,
      ownership_error: ownership.reason,
    };
  }

  // Live unconsumed count — same query shape as getDreamStats()'s
  // live_unconsumed_count (Task 2), duplicated deliberately rather than
  // imported: this module must stay independently correct even if
  // getDreamStats()'s implementation changes shape later, since this tool's
  // entire purpose is to be a second, independent diagnostic signal.
  const liveUnconsumedRow = await withClient(async (client) => {
    const { rows } = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM dream_episode_logs WHERE agent_id = $1 AND consumed_by_run IS NULL`,
      [agentId],
    );
    return rows[0] ?? null;
  });

  // Most recent write side: the exact agent_id string stored by the most
  // recent submit_episode_log call for this logical agent. Queried via a
  // case-INSENSITIVE match so a genuine case-mismatch bug (the leading
  // hypothesis) is actually findable — an exact-match WHERE clause would
  // silently return zero rows for exactly the mismatched case this tool
  // exists to detect.
  const lastSubmit = await withClient(async (client) => {
    const { rows } = await client.query<{ agent_id: string; occurred_at: string }>(
      `SELECT agent_id, occurred_at::text FROM dream_episode_logs WHERE agent_id ILIKE $1 ORDER BY occurred_at DESC LIMIT 1`,
      [agentId],
    );
    return rows[0] ?? null;
  });

  // Most recent read side: the exact agent_id string dream_cycle_runs
  // recorded for its own most recent run (the same string start_dream used
  // when it queried dream_episode_logs). Also case-insensitive for the same
  // reason as above.
  const lastRun = await withClient(async (client) => {
    const { rows } = await client.query<{ agent_id: string; started_at: string }>(
      `SELECT agent_id, started_at::text FROM dream_cycle_runs WHERE agent_id ILIKE $1 ORDER BY started_at DESC LIMIT 1`,
      [agentId],
    );
    return rows[0] ?? null;
  });

  const lastSubmitAgentId = lastSubmit?.agent_id ?? null;
  const lastRunAgentId = lastRun?.agent_id ?? null;

  return {
    agent_id: agentId,
    live_unconsumed_count: liveUnconsumedRow ? Number(liveUnconsumedRow.count) : 0,
    last_submit_agent_id: lastSubmitAgentId,
    last_submit_at: lastSubmit?.occurred_at ?? null,
    last_run_agent_id: lastRunAgentId,
    last_run_at: lastRun?.started_at ?? null,
    agent_id_exact_match: lastSubmitAgentId === null || lastRunAgentId === null ? null : lastSubmitAgentId === lastRunAgentId,
  };
}
