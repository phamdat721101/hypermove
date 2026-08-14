/**
 * src/lib/mcp/dream/morning-brief.ts
 * -----------------------------------
 * Phase 5: Sovereign Morning Briefs and Human Intervention
 *
 * Delivers structured updates via Webhook (Telegram/Slack) upon Dream-Cycle completion.
 * Action plan structure:
 *  - Executed: High-value actions taken during overnight compaction.
 *  - Neutralized: Contradictions pruned or outdated instructions resolved.
 *  - Proposed: Resource requests or strategy escalations for human supervisor.
 */

export interface MorningBriefPayload {
  agentId: string;
  runId: string;
  executed: string[];
  neutralized: string[];
  proposed: string[];
  tokensReducedPercent: number;
}

export interface SovereignMorningBrief {
  brief_id: string;
  agent_id: string;
  markdown_brief: string;
  dispatched: boolean;
  timestamp: string;
}

export function formatMorningBriefMarkdown(payload: MorningBriefPayload): string {
  const executedList = payload.executed.length > 0
    ? payload.executed.map((e) => `* **Executed**: "${e}"`).join('\n')
    : '* **Executed**: "No new skills compiled this cycle."';

  const neutralizedList = payload.neutralized.length > 0
    ? payload.neutralized.map((n) => `* **Neutralized**: "${n}"`).join('\n')
    : '* **Neutralized**: "No contradictory SOP instructions detected."';

  const proposedList = payload.proposed.length > 0
    ? payload.proposed.map((p) => `* **Proposed**: "${p}"`).join('\n')
    : '* **Proposed**: "Maintain current budget allocation and SOP execution parameters."';

  return `### 🌅 Sovereign Morning Brief — Agent \`${payload.agentId}\`
**Dream-Cycle Run**: \`${payload.runId}\` | **Context Reduction**: \`${payload.tokensReducedPercent}%\`

${executedList}
${neutralizedList}
${proposedList}

---
*System evolved autonomously. Human supervisor action required only for Proposed items.*`;
}

/**
 * Dispatch Sovereign Morning Brief to Telegram/Slack webhook if configured.
 */
export async function dispatchMorningBrief(payload: MorningBriefPayload): Promise<SovereignMorningBrief> {
  const briefMarkdown = formatMorningBriefMarkdown(payload);
  const webhookUrl = process.env.DREAM_MORNING_BRIEF_WEBHOOK_URL;
  let dispatched = false;

  if (webhookUrl) {
    try {
      // Support standard Slack/Telegram webhook formats
      const body = webhookUrl.includes('telegram')
        ? JSON.stringify({ text: briefMarkdown, parse_mode: 'Markdown' })
        : JSON.stringify({ text: briefMarkdown });

      const res = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      });
      dispatched = res.ok;
    } catch {
      dispatched = false;
    }
  }

  return {
    brief_id: `brief-${payload.runId}`,
    agent_id: payload.agentId,
    markdown_brief: briefMarkdown,
    dispatched,
    timestamp: new Date().toISOString(),
  };
}
