/**
 * src/lib/harness/runtime.ts
 * --------------------------
 * The harness runtime — the moat. Every skill runs INSIDE this pipeline:
 *   ① observability.wrapMcpTool  → tracing + structured error capture
 *   ② sentinel (via wrapMcpTool) → policy: cost cap / rate / prompt-injection
 *   ③ skill.execute              → the author's logic
 *   ④ output-enforcer            → verify before ship; bounded self-heal
 *
 * defineSkillTool() turns a SkillDef into a gateway ToolDef, so the skill is
 * automatically listed by getTools() → callable over the MCP transport (the
 * server iterates getTools()) with tier metering handled by the gateway.
 *
 * When FEATURE_HM_PLATFORM=false, wrapMcpTool is an identity function, so the
 * skill still runs — just without tracing/policy — preserving the rollback
 * contract. The output-enforcer always runs (it is skill correctness, not a
 * platform feature).
 */

import { wrapMcpTool } from '../observability';
import { defaultSentinel } from '../sentinel';
import { verifyOrHeal } from './output-enforcer';
import type { SkillDef, HarnessConfig } from './types';
import type { ToolDef, ToolContext } from '../mcp/tools';

/** Compact, serializable summary of which harness layers wrapped a run. */
function harnessSummary(h: HarnessConfig): Record<string, unknown> {
  return {
    errorHandler: h.errorHandler !== false,
    policy: h.policy !== false,
    outputEnforcer: h.outputEnforcer ? h.outputEnforcer.verify.map((v) => v.kind) : false,
    docExtract: h.docExtract ?? false,
  };
}

/**
 * Run a skill through the full harness and return a structured envelope.
 * `agentId` threads the caller identity into observability + sentinel.
 */
export async function runHarnessed(
  skill: SkillDef,
  args: Record<string, unknown>,
  agentId: string,
): Promise<Record<string, unknown>> {
  // ①②③ observability + sentinel wrap around the skill's execute.
  const wrapped = wrapMcpTool<Record<string, unknown>, Record<string, unknown>>({
    name: `skill.${skill.name}`,
    version: skill.version,
    sentinel: skill.harness.policy === false ? undefined : defaultSentinel(),
    handler: async (a) => {
      const raw = await skill.execute(a);
      // ④ output-enforcer verify-gate (+ bounded self-heal) — always runs.
      if (skill.harness.outputEnforcer) {
        const enforced = await verifyOrHeal(raw, skill.harness.outputEnforcer, {
          reExecute: (feedback) => skill.execute({ ...a, _feedback: feedback }),
        });
        return {
          skill: skill.name,
          version: skill.version,
          verified: enforced.verified,
          heals: enforced.heals,
          checks: enforced.checks,
          output: enforced.output,
        };
      }
      return { skill: skill.name, version: skill.version, verified: true, heals: 0, checks: [], output: raw };
    },
  });

  const result = await wrapped(args, agentId);
  return { ...result, harness: harnessSummary(skill.harness) };
}

/** Turn a SkillDef into a gateway ToolDef (name `skill.<name>`). */
export function defineSkillTool(skill: SkillDef): ToolDef {
  return {
    name: `skill.${skill.name}`,
    description: `${skill.description} [harness-wrapped skill · ${skill.category}]`,
    tier: skill.tier,
    inputSchema: skill.inputSchema,
    handler: async (args: Record<string, unknown>, ctx?: ToolContext) => {
      const userId = ctx?.session.userId ?? 'anonymous';
      return runHarnessed(skill, args, userId);
    },
  };
}
