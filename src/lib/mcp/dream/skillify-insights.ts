/**
 * src/lib/mcp/dream/skillify-insights.ts
 * ----------------------------------------
 * Phase 4: Proactive Skillification (Matt-Pocock Standard)
 *
 * Distills consolidated episodic memories and patterns into permanent,
 * type-safe SKILL SOPs formatted with TypeScript-level precision.
 */

import { withClient } from '../../db';
import { createHash } from 'node:crypto';

export interface GeneratedSkill {
  skill_id: string;
  agent_id: string;
  name: string;
  description: string;
  type_safe_sop: string;
  status: 'pending_validation' | 'promoted' | 'rejected';
  artifact_hash: string;
  created_at: string;
}

export interface SkillifyInputInsight {
  memory_id?: string;
  type: string;
  content: string;
  confidence: number;
}

export const NIM_SKILL_VALIDATION_COMMAND = "nim-skill enforce 'npx vitest run'";

export interface SkillValidationBundle {
  skill: GeneratedSkill;
  validation_command: typeof NIM_SKILL_VALIDATION_COMMAND;
}

/**
 * Generate a Matt-Pocock Standard type-safe SOP SKILL specification
 * from a cluster of consolidated memories.
 */
export function formatMattPocockSOP(name: string, description: string, memories: SkillifyInputInsight[]): string {
  const sanitizedSlug = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const rules = memories.map((m) => `  * ${sanitizeComment(m.content)} (confidence: ${m.confidence})`).join('\n');

  return `/**
 * @skill ${sanitizedSlug}
 * @description ${description}
 * @standard Matt-Pocock TypeScript Type-Safe SOP
 */

export interface ${capitalize(sanitizedSlug)}Input {
  agent_id: string;
  context: Record<string, unknown>;
  trace_id?: string;
}

export interface ${capitalize(sanitizedSlug)}Output {
  status: 'success' | 'failure' | 'requires_human_review';
  result_summary: string;
  insights_applied: number;
}

/**
 * Standard Operating Procedure (SOP) Rules:
${rules}
 */
export async function execute${capitalize(sanitizedSlug)}(
  input: ${capitalize(sanitizedSlug)}Input
): Promise<${capitalize(sanitizedSlug)}Output> {
  // Step 1: Precondition validation against consolidated rules
  // Step 2: High-signal execution turn
  // Step 3: Telemetry logging to line_db
  return {
    status: 'success',
    result_summary: 'Executed SOP ${sanitizedSlug} adhering to Matt-Pocock specification',
    insights_applied: ${memories.length},
  };
}
`;
}

/** Generated knowledge is data, never code. Escaping closes comment-breakout
 * attempts before a proposal is handed to a local nim-skill validator. */
function sanitizeComment(value: string): string {
  return value.replace(/\*\//g, '*\\/').replace(/[\r\n]+/g, ' ').slice(0, 200);
}

function capitalize(str: string): string {
  return str.split('_').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
}

/**
 * Skillify high-confidence consolidated memories into dream_skills store.
 */
export async function skillifyMemories(agentId: string, memories: SkillifyInputInsight[]): Promise<GeneratedSkill[]> {
  const highConfidence = memories.filter((m) => m.confidence >= 0.7);
  if (highConfidence.length === 0) return [];

  // Group memories by type
  const grouped: Record<string, SkillifyInputInsight[]> = {};
  for (const m of highConfidence) {
    grouped[m.type] = grouped[m.type] ?? [];
    grouped[m.type].push(m);
  }

  const createdSkills: GeneratedSkill[] = [];

  for (const [type, typeMemories] of Object.entries(grouped)) {
    const name = `sop_${type}_pattern`;
    const description = `Automated ${type} Standard Operating Procedure derived from ${typeMemories.length} high-confidence traces.`;
    const sopText = formatMattPocockSOP(name, description, typeMemories);

    const saved = await withClient(async (client) => {
      const { rows } = await client.query<{
        skill_id: string; agent_id: string; name: string; description: string; type_safe_sop: string; status: GeneratedSkill['status']; artifact_hash: string; created_at: string;
      }>(
        `INSERT INTO dream_skills (agent_id, name, description, type_safe_sop, status, artifact_hash)
         VALUES ($1, $2, $3, $4, 'pending_validation', $5)
         RETURNING skill_id, agent_id, name, description, type_safe_sop, status, artifact_hash, created_at::text`,
        [agentId, name, description, sopText, createHash('sha256').update(sopText).digest('hex')],
      );
      return rows[0] ?? null;
    });

    if (saved) {
      createdSkills.push(saved);
    }
  }

  return createdSkills;
}

/**
 * Retrieve all generated skills for an agent.
 */
export async function getAgentSkills(agentId: string): Promise<GeneratedSkill[]> {
  const rows = await withClient(async (client) => {
    const { rows } = await client.query<{
      skill_id: string; agent_id: string; name: string; description: string; type_safe_sop: string; status: GeneratedSkill['status']; artifact_hash: string; created_at: string;
    }>(
      `SELECT skill_id, agent_id, name, description, type_safe_sop, status, artifact_hash, created_at::text
       FROM dream_skills WHERE agent_id = $1 ORDER BY created_at DESC`,
      [agentId],
    );
    return rows;
  });
  return rows ?? [];
}

/** Return the immutable proposal and the command an owning agent must run in
 * its own workspace. The server never executes generated SOP source. */
export async function getSkillValidationBundle(agentId: string, skillId: string): Promise<SkillValidationBundle | null> {
  const rows = await withClient(async (client) => {
    const { rows } = await client.query<GeneratedSkill>(
      `SELECT skill_id, agent_id, name, description, type_safe_sop, status, artifact_hash, created_at::text
       FROM dream_skills WHERE agent_id = $1 AND skill_id = $2 LIMIT 1`,
      [agentId, skillId],
    );
    return rows;
  });
  const skill = rows?.[0];
  return skill ? { skill, validation_command: NIM_SKILL_VALIDATION_COMMAND } : null;
}

/** Promotion is explicit and hash-bound. A stale or altered proposal cannot
 * be promoted after an agent has reviewed a different artifact. */
export async function resolveSkillProposal(
  agentId: string,
  skillId: string,
  artifactHash: string,
  decision: 'promoted' | 'rejected',
  validationCommand?: string,
): Promise<{ ok: boolean; message?: string }> {
  if (decision === 'promoted' && validationCommand !== NIM_SKILL_VALIDATION_COMMAND) {
    return { ok: false, message: `promotion requires validation_command: ${NIM_SKILL_VALIDATION_COMMAND}` };
  }
  const updated = await withClient(async (client) => {
    const { rowCount } = await client.query(
      `UPDATE dream_skills SET status = $1
       WHERE agent_id = $2 AND skill_id = $3 AND artifact_hash = $4 AND status = 'pending_validation'`,
      [decision, agentId, skillId, artifactHash],
    );
    return rowCount ?? 0;
  });
  if (updated === null) return { ok: true }; // mock-first local development
  return updated > 0 ? { ok: true } : { ok: false, message: 'proposal not found, already resolved, or artifact hash differs' };
}
