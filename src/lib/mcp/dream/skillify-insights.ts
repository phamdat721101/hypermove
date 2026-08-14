/**
 * src/lib/mcp/dream/skillify-insights.ts
 * ----------------------------------------
 * Phase 4: Proactive Skillification (Matt-Pocock Standard)
 *
 * Distills consolidated episodic memories and patterns into permanent,
 * type-safe SKILL SOPs formatted with TypeScript-level precision.
 */

import { withClient } from '../../db';

export interface GeneratedSkill {
  skill_id: string;
  agent_id: string;
  name: string;
  description: string;
  type_safe_sop: string;
  created_at: string;
}

export interface SkillifyInputInsight {
  memory_id?: string;
  type: string;
  content: string;
  confidence: number;
}

/**
 * Generate a Matt-Pocock Standard type-safe SOP SKILL specification
 * from a cluster of consolidated memories.
 */
export function formatMattPocockSOP(name: string, description: string, memories: SkillifyInputInsight[]): string {
  const sanitizedSlug = name.toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  const rules = memories.map((m) => `  * ${m.content} (confidence: ${m.confidence})`).join('\n');

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
        skill_id: string; agent_id: string; name: string; description: string; type_safe_sop: string; created_at: string;
      }>(
        `INSERT INTO dream_skills (agent_id, name, description, type_safe_sop)
         VALUES ($1, $2, $3, $4)
         RETURNING skill_id, agent_id, name, description, type_safe_sop, created_at::text`,
        [agentId, name, description, sopText],
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
      skill_id: string; agent_id: string; name: string; description: string; type_safe_sop: string; created_at: string;
    }>(
      `SELECT skill_id, agent_id, name, description, type_safe_sop, created_at::text
       FROM dream_skills WHERE agent_id = $1 ORDER BY created_at DESC`,
      [agentId],
    );
    return rows;
  });
  return rows ?? [];
}
