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

import { isMcpDreamCycleEnabled } from '../platform-flag';

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

// (dream/run_confidential prompt removed 2026-08-14, FCC removal. See
// docs/fcc-removal-proposal-2026-08-14.md.)

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
  return prompts;
}

export function findPrompt(name: string): PromptDef | undefined {
  return getPrompts().find((p) => p.name === name);
}

