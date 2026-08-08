/**
 * src/lib/mcp/prompts.ts
 * -----------------------
 * MCP prompts — reusable, user-controlled templates a client can select and
 * invoke, per the MCP spec's prompts/list + prompts/get methods.
 *
 * Prior to this file, no MCP prompt was ever real in this codebase: despite
 * isMcpResourcesEnabled() existing (M6 — "MCP resources + prompts exposure")
 * and docs/dream-cycle.json describing a `prompts` section, server.ts's
 * mcpHttpHandler() only ever called server.tool(...) on the real
 * @modelcontextprotocol/sdk handler — never server.prompt()/registerPrompt().
 * This file is the data layer (parallel to tools.ts's ToolDef/getTools());
 * server.ts's registerPrompt() is the transport-wiring layer that actually
 * calls the SDK.
 *
 * SOLID:
 *  - Single Responsibility: prompt definitions + their gating only. No
 *    transport/SDK code lives here (that's server.ts's job, mirroring how
 *    tools.ts never touches the SDK either).
 *  - Open/Closed: add a new prompt by appending a PromptDef + one line in
 *    getPrompts() — no caller (server.ts) changes.
 */

import { isMcpDreamCycleEnabled, isMcpDreamConfidentialEnabled } from '../platform-flag';

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptMessage {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
}

export interface PromptDef {
  name: string;
  description: string;
  arguments: PromptArgument[];
  /**
   * Resolves the prompt's arguments into the messages a client should send.
   * Mirrors ToolDef.handler's shape (args in, result out) but returns
   * PromptMessage[] instead of a tool result — matching the MCP spec's
   * GetPromptResult.messages shape exactly (server.ts's registerPrompt()
   * wraps this 1:1, no reshaping needed).
   */
  resolve(args: Record<string, string | undefined>): Promise<PromptMessage[]>;
}

/**
 * The original Dream Cycle spec's 3 prompts (docs/prd/dream-cycle-v1.md's
 * Task 12/docs/dream-cycle.json's mcp_interface.prompts) — planned since the
 * feature's original PRD but never actually built until this file existed
 * (see this module's header doc). Gated by isMcpDreamCycleEnabled() (the
 * base Dream Cycle flag, default ON) — these 3 are part of the core feature,
 * not the confidential extension, so they follow Dream Cycle's own
 * always-on-unless-opted-out convention, not the confidential feature's
 * opt-in one.
 */
const dreamSummarizeTodayPrompt: PromptDef = {
  name: 'dream/summarize_today',
  description: "Returns a brief summary of what the last Dream Cycle learned for the agent.",
  arguments: [{ name: 'agent_id', description: 'Unique identifier of the agent.', required: true }],
  async resolve(args) {
    const agentId = args.agent_id ?? '';
    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Summarize what the last Dream Cycle learned for agent "${agentId}". Read the hypermove:///agents/${agentId}/dream/summary resource for context before answering.`,
        },
      },
    ];
  },
};

const dreamSuggestPolicyUpdatesPrompt: PromptDef = {
  name: 'dream/suggest_policy_updates',
  description: 'Given a task_type, returns suggested policy changes based on learned rules and error patterns.',
  arguments: [
    { name: 'agent_id', description: 'Unique identifier of the agent.', required: true },
    { name: 'task_type', description: 'The task type to suggest policy updates for.', required: true },
  ],
  async resolve(args) {
    const agentId = args.agent_id ?? '';
    const taskType = args.task_type ?? '';
    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Suggest policy updates for agent "${agentId}" on task_type "${taskType}", grounded in its learned rules and error patterns. Read hypermove:///agents/${agentId}/dream/summary, hypermove:///agents/${agentId}/dream/rules, and hypermove:///agents/${agentId}/dream/errors for context before answering.`,
        },
      },
    ];
  },
};

const dreamCompareBeforeAfterPrompt: PromptDef = {
  name: 'dream/compare_before_after',
  description: 'Takes a JSON blob of evaluation scores and returns a brief comparison.',
  arguments: [{ name: 'eval_scores_json', description: 'JSON blob of before/after evaluation scores to compare.', required: true }],
  async resolve(args) {
    const evalScoresJson = args.eval_scores_json ?? '{}';
    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Compare the before/after evaluation scores in this JSON blob and summarize whether Dream Cycle improved performance: ${evalScoresJson}`,
        },
      },
    ];
  },
};

/**
 * Dream Cycle Confidential Extraction on Flare FCC, Task 8. Pre-fills a
 * start_dream({confidential:true}) call for the given agent_id, using
 * whatever budget/preset default is already stored for that agent (Task 9's
 * confidential_default/preferred_settlement, or the plain dream_configs
 * default from Task 2 if no confidential-specific default exists yet),
 * falling back to the 'balanced' preset / global default budget if no
 * config is stored at all — same fallback discipline startDream() itself
 * already uses (see pipeline.ts's `DREAM_PRESETS[config.preset] ?
 * config.preset : 'balanced'`).
 *
 * Gated behind isMcpDreamConfidentialEnabled() (Task 6) — getPrompts() below
 * omits this prompt entirely from prompts/list when the flag is off, rather
 * than registering it and erroring on invoke. A disabled capability should
 * not even be discoverable, matching how getTools() omits every flag-gated
 * tool the same way (see tools.ts's `if (isMcpXEnabled()) tools.push(...)`
 * pattern) rather than registering-then-rejecting.
 */
const dreamRunConfidentialPrompt: PromptDef = {
  name: 'dream/run_confidential',
  description: 'Start a confidential Dream Cycle run for an agent — extraction routes through Flare Confidential Compute (TEE) instead of the plaintext path, settled via XRPL/RLUSD. Pre-fills start_dream with confidential:true and the agent\'s stored defaults.',
  arguments: [
    { name: 'agent_id', description: 'Unique identifier of the agent to run confidential Dream Cycle for.', required: true },
  ],
  async resolve(args) {
    const agentId = args.agent_id ?? '';
    const { getDreamConfig } = await import('./dream/pipeline');
    const stored = agentId ? await getDreamConfig(agentId) : { config: null };
    const budgetUsd = stored.config?.budget_usd ?? (Number(process.env.DREAM_MAX_BUDGET_USD_PER_CYCLE) || 0.1);
    const preset = stored.config?.preset ?? 'balanced';

    const callText = JSON.stringify({
      tool: 'start_dream',
      arguments: {
        agent_id: agentId,
        config: { budget_usd: budgetUsd, preset, confidential: true },
      },
    });

    return [
      {
        role: 'user',
        content: {
          type: 'text',
          text: `Run a confidential Dream Cycle for agent "${agentId}". Extraction will execute inside Flare's Confidential Compute TEE (falls back to an honest fcc_not_live result if Flare hasn't shipped live compute yet) and settles via XRPL/RLUSD. Call the start_dream tool with this exact input: ${callText}`,
        },
      },
    ];
  },
};

/**
 * The full prompt registry. Mirrors getTools()'s exact shape (flag-gated
 * pushes, no unconditional entries yet since every current prompt belongs to
 * Dream Cycle) — server.ts's registerPrompt() loop is a direct parallel of
 * registerTool()'s.
 */
export function getPrompts(): PromptDef[] {
  const prompts: PromptDef[] = [];
  if (isMcpDreamCycleEnabled()) {
    prompts.push(dreamSummarizeTodayPrompt, dreamSuggestPolicyUpdatesPrompt, dreamCompareBeforeAfterPrompt);
  }
  if (isMcpDreamConfidentialEnabled()) prompts.push(dreamRunConfidentialPrompt);
  return prompts;
}

export function findPrompt(name: string): PromptDef | undefined {
  return getPrompts().find((p) => p.name === name);
}

