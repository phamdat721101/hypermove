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

import { isMcpBuilderBriefEnabled, isMcpFlareEnabled, isMcpGoatEnabled, isMcpXrplV3Enabled } from '../platform-flag';

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

/** All prompts, gated by their respective feature flags. */
export function getPrompts(): McpPrompt[] {
  const prompts: McpPrompt[] = [];
  if (isMcpBuilderBriefEnabled()) prompts.push(builderBriefPrompt);
  if (isMcpXrplV3Enabled()) prompts.push(settlementQuotePrompt);
  return prompts;
}

/** Find a prompt by name. */
export function findPrompt(name: string): McpPrompt | undefined {
  return getPrompts().find((p) => p.name === name);
}
