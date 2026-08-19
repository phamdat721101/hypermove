/**
 * Agent-facing REM wake package. This is deliberately a read model: it
 * composes durable Dream records without changing memory, skills, or runs.
 */

import { withClient } from '../../db';
import { isValidDreamSkillMarkdown } from './skillify-insights';

export interface WakeConstraint {
  type: 'rule' | 'error_pattern' | 'preference';
  content: string;
  importance: number;
  confidence: number;
}

export interface WakeContextResponse {
  agent_id: string;
  generated_at: string;
  daily_digest: {
    last_run_id: string | null;
    duration_ms: number | null;
    episodes_consolidated: number;
    memories_added: number;
    memories_pruned: number;
    contradictions_resolved: number;
    summary_narrative: string;
  };
  active_constraints: WakeConstraint[];
  new_skills: Array<{ name: string; description: string; skill_md: string; artifact_hash: string }>;
  prompt_injection_snippet: string;
}

interface WakeRunRow {
  run_id: string;
  duration_ms: number | null;
  memories_added: number;
  memories_removed: number;
  stage_summaries: { preprocessing_summary?: { episodes_in?: number } } | null;
}

function promptSnippet(runId: string | null, constraints: WakeConstraint[], skills: WakeContextResponse['new_skills']): string {
  const constraintLines = constraints.length
    ? constraints.map((constraint) => `- [${constraint.type.toUpperCase()}: I=${constraint.importance.toFixed(2)} C=${constraint.confidence.toFixed(2)}] ${constraint.content}`).join('\n')
    : '- No active high-confidence constraints yet.';
  const skillLines = skills.length
    ? skills.map((skill) => `- \`${skill.name}\`: ${skill.description}`).join('\n')
    : '- No validated Dream skills are available yet.';
  return `# Dream Cycle Wake Intelligence${runId ? ` (Run: ${runId})` : ''}\n\n## Active constraints\n${constraintLines}\n\n## Validated skills\n${skillLines}`;
}

export async function getWakeContext(agentId: string, maxConstraints = 12): Promise<WakeContextResponse> {
  const limit = Math.min(Math.max(Math.floor(maxConstraints), 1), 50);
  const result = await withClient(async (client) => {
    const [runResult, constraintsResult, skillsResult, contradictionsResult] = await Promise.all([
      client.query<WakeRunRow>(
        `SELECT run_id, duration_ms, memories_added, memories_removed, stage_summaries
         FROM dream_cycle_runs WHERE agent_id = $1 AND status IN ('completed', 'partial')
         ORDER BY ended_at DESC NULLS LAST, started_at DESC LIMIT 1`, [agentId],
      ),
      client.query<WakeConstraint>(
        `SELECT type, content, importance, confidence
         FROM dream_consolidated_memories
         WHERE agent_id = $1 AND quarantined_at IS NULL
           AND type IN ('rule', 'error_pattern', 'preference')
         ORDER BY (importance * confidence) DESC, created_at DESC LIMIT $2`, [agentId, limit],
      ),
      client.query<{ name: string; description: string; type_safe_sop: string; artifact_hash: string }>(
        `SELECT name, description, type_safe_sop, artifact_hash
         FROM dream_skills WHERE agent_id = $1 AND status = 'promoted'
         ORDER BY created_at DESC`, [agentId],
      ),
      client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM dream_contradictions
         WHERE agent_id = $1 AND status = 'resolved'`, [agentId],
      ),
    ]);
    return {
      run: runResult.rows[0] ?? null,
      constraints: constraintsResult.rows,
      skills: skillsResult.rows,
      contradictionsResolved: Number(contradictionsResult.rows[0]?.count ?? 0),
    };
  });

  const run = result?.run ?? null;
  const constraints = result?.constraints ?? [];
  const skills = (result?.skills ?? [])
    .filter((skill) => isValidDreamSkillMarkdown(skill.type_safe_sop))
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      skill_md: skill.type_safe_sop,
      artifact_hash: skill.artifact_hash,
    }));
  const dailyDigest: WakeContextResponse['daily_digest'] = {
    last_run_id: run?.run_id ?? null,
    duration_ms: run?.duration_ms ?? null,
    episodes_consolidated: run?.stage_summaries?.preprocessing_summary?.episodes_in ?? 0,
    memories_added: run?.memories_added ?? 0,
    memories_pruned: run?.memories_removed ?? 0,
    contradictions_resolved: result?.contradictionsResolved ?? 0,
    summary_narrative: run
      ? `Latest Dream Cycle consolidated ${run.memories_added} memories and pruned ${run.memories_removed}.`
      : 'No completed Dream Cycle is available yet.',
  };

  return {
    agent_id: agentId,
    generated_at: new Date().toISOString(),
    daily_digest: dailyDigest,
    active_constraints: constraints,
    new_skills: skills,
    prompt_injection_snippet: promptSnippet(run?.run_id ?? null, constraints, skills),
  };
}
