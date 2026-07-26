/**
 * src/lib/mcp/prompts.ts
 * -----------------------
 * MCP prompts — reusable prompt templates that compose tools into higher-level
 * workflows. Prompts are exposed through the MCP prompt API.
 *
 * SOLID:
 *  - Single Responsibility: each prompt is a thin composition over tools.
 *  - Open/Closed: add new prompts by appending to PROMPTS map.
 */

import { isMcpBuilderBriefEnabled, isMcpFlareEnabled, isMcpGoatEnabled, isMcpXrplV3Enabled, isMcpDreamCycleEnabled } from '../platform-flag';

export interface McpPrompt {
  name: string;
  description: string;
  arguments: { name: string; description: string; required: boolean }[];
  messages: { role: 'user' | 'assistant'; content: { type: 'text'; text: string } }[];
}

/** Builder brief prompt — generates a decision-ready brief for a chain. */
const builderBriefPrompt: McpPrompt = {
  name: 'builder.brief',
  description: 'Synthesize a decision-ready builder brief for a chain (Flare, XRPL, GOAT) using live reads + corpus + news.',
  arguments: [
    { name: 'chain', description: 'Chain to build a brief for (flare-mainnet, xrpl-mainnet, goat-mainnet)', required: true },
  ],
  messages: [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `Generate a builder brief for the specified chain. Use the *.builder.brief tools to compose live reads + corpus + news into a decision-ready output.

For Flare: use flare.builder.brief
For XRPL: use xrpl.builder.brief
For GOAT: use goat.builder.brief

The brief must be:
1. Source-labeled (every figure traces to a corpus entry or live read)
2. Decision-ready (clear recommendations, not raw data)
3. Enforcer-verified (missing required fields will be blocked)`,
      },
    },
  ],
};

/** Settlement quote prompt — compare RLUSD vs XRP settlement. */
const settlementQuotePrompt: McpPrompt = {
  name: 'settlement.quote',
  description: 'Compare RLUSD vs native XRP settlement cost/finality for an amount (Rule #33).',
  arguments: [
    { name: 'amount', description: 'Amount in USD to settle', required: true },
  ],
  messages: [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `Use xrpl.settlement.quote to compare RLUSD vs native XRP settlement for the specified amount.

Rule #33: Native XRP is preferred for high-frequency micropayments (no trustline, deterministic fee).
RLUSD is preferred for larger invoices (stable value).`,
      },
    },
  ],
};

// ─── Dream Cycle prompts (2026-07-26) ──────────────────────────────────────
//
// Thin compositions over the dream/* tools + resources — each prompt tells
// the client which tool/resource to call, never reimplements pipeline logic
// here (matches builderBriefPrompt/settlementQuotePrompt's style exactly).

const dreamSummarizeTodayPrompt: McpPrompt = {
  name: 'dream/summarize_today',
  description: 'Returns a brief summary of what the last Dream Cycle learned for the agent.',
  arguments: [
    { name: 'agent_id', description: 'Unique identifier of the agent.', required: true },
  ],
  messages: [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `Summarize what Dream Cycle learned for agent {agent_id} today.

Read the hypermove:///agents/{agent_id}/dream/summary resource (or call get_dream_stats(agent_id)
if the resource is unavailable) and produce a brief, plain-language summary of:
1. What was learned (rules, error patterns, facts)
2. How many memories were added/removed this cycle
3. What the agent should do differently next time`,
      },
    },
  ],
};

const dreamSuggestPolicyUpdatesPrompt: McpPrompt = {
  name: 'dream/suggest_policy_updates',
  description: 'Given a task_type, returns suggested policy changes based on learned rules and error patterns.',
  arguments: [
    { name: 'agent_id', description: 'Unique identifier of the agent.', required: true },
    { name: 'task_type', description: 'The task type to suggest policy updates for.', required: true },
  ],
  messages: [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `Suggest policy updates for agent {agent_id}'s "{task_type}" tasks.

Read hypermove:///agents/{agent_id}/dream/summary, hypermove:///agents/{agent_id}/dream/rules,
and hypermove:///agents/{agent_id}/dream/errors (or call query_dream(agent_id, "{task_type}")
if resources are unavailable). Synthesize concrete, actionable policy changes the agent should
adopt for "{task_type}" tasks based on the rules and error patterns learned.`,
      },
    },
  ],
};

const dreamCompareBeforeAfterPrompt: McpPrompt = {
  name: 'dream/compare_before_after',
  description: 'Takes a JSON blob of evaluation scores and returns a brief comparison.',
  arguments: [
    { name: 'eval_scores_json', description: 'JSON blob of before/after evaluation scores.', required: true },
  ],
  messages: [
    {
      role: 'user',
      content: {
        type: 'text',
        text: `Compare the before/after evaluation scores in this JSON blob: {eval_scores_json}

You may also read hypermove:///agents/{agent_id}/dream/stats for the Dream Cycle run that
produced the "after" state. Produce a brief comparison highlighting what improved, what
regressed, and whether the Dream Cycle appears to have helped.`,
      },
    },
  ],
};

/** All prompts, gated by their respective feature flags. */
export function getPrompts(): McpPrompt[] {
  const prompts: McpPrompt[] = [];
  if (isMcpBuilderBriefEnabled()) prompts.push(builderBriefPrompt);
  if (isMcpXrplV3Enabled()) prompts.push(settlementQuotePrompt);
  if (isMcpDreamCycleEnabled()) prompts.push(dreamSummarizeTodayPrompt, dreamSuggestPolicyUpdatesPrompt, dreamCompareBeforeAfterPrompt);
  return prompts;
}

/** Find a prompt by name. */
export function findPrompt(name: string): McpPrompt | undefined {
  return getPrompts().find((p) => p.name === name);
}
