/**
 * src/lib/mcp/resources.ts
 * -------------------------
 * MCP resources — subscribable live data exposed through the MCP resource API.
 * Resources are read-only, cacheable, and can be polled for updates.
 *
 * SOLID:
 *  - Single Responsibility: each resource is a thin wrapper over existing reads.
 *  - Open/Closed: add new resources by appending to RESOURCES map.
 */

import { isMcpResourcesEnabled, isMcpFlareEnabled, isMcpXrplV3Enabled, isMcpDreamCycleEnabled } from '../platform-flag';

export interface McpResource {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
  /**
   * `matchedUri` is the actual URI the client requested (e.g.
   * "hypermove:///agents/robot-42/dream/rules"), passed through so
   * per-agent resources (Dream Cycle) can parse path params out of it.
   * Existing static resources ignore this parameter — Open/Closed, no
   * behavior change for them.
   */
  read(matchedUri?: string): Promise<unknown>;
}

/** FTSO feed resource — live price feed from Flare FTSO (keyless). */
const ftsoFeedResource: McpResource = {
  uri: 'ftso://feeds/{feedId}',
  name: 'FTSO Price Feed',
  description: 'Live block-latency price feed from Flare FTSO (free 1000-feed oracle). Replace {feedId} with e.g. BTC/USD.',
  mimeType: 'application/json',
  async read() {
    if (!isMcpFlareEnabled()) {
      return { error: 'FTSO resource disabled', hint: 'set FEATURE_MCP_FLARE=true' };
    }
    // The actual read is dispatched through the data.call tool
    return { hint: 'Use data.call(chain: "flare-mainnet", method: "flareFtsoFeed", params: { feed: "BTC/USD" })' };
  },
};

/** XRPL amendments resource — enabled + voting amendments. */
const amendmentsResource: McpResource = {
  uri: 'xrpl://amendments',
  name: 'XRPL Amendments',
  description: 'Enabled + in-voting amendments (fixCleanup, XLS-65/66). Feature-gate awareness.',
  mimeType: 'application/json',
  async read() {
    if (!isMcpXrplV3Enabled()) {
      return { error: 'XRPL v3 resource disabled', hint: 'set FEATURE_MCP_XRPL_V3=true' };
    }
    return { hint: 'Use data.call(chain: "xrpl-mainnet", method: "xrplAmendments")' };
  },
};

/** FXRP capacity resource — Flare FAssets XRP bridge capacity. */
const fxrpCapacityResource: McpResource = {
  uri: 'flare://fxrp/capacity',
  name: 'FXRP Bridge Capacity',
  description: 'FAssets XRP bridge capacity on Flare (collateral + mint state).',
  mimeType: 'application/json',
  async read() {
    if (!isMcpFlareEnabled()) {
      return { error: 'FXRP resource disabled', hint: 'set FEATURE_MCP_FLARE=true' };
    }
    return { hint: 'Use data.call(chain: "flare-mainnet", method: "flareFassetsFxrp")' };
  },
};

// ─── Dream Cycle resources (2026-07-26) ────────────────────────────────────
//
// Per-agent, scoped strictly by the {agent_id} parsed out of the requested
// URI — never returns another agent's data (see extractAgentId() below).
// All four read from the SAME rebuild-on-read store as query_dream
// (dream/index.ts / dream/pipeline.ts), updated atomically at cycle end
// (the pipeline's final dream_cycle_runs UPDATE + index-cache invalidation).

function dreamDisabledError() {
  return { error: 'Dream Cycle resource disabled', hint: 'set FEATURE_MCP_DREAM_CYCLE=true' };
}

function missingAgentIdError() {
  return { error: 'missing or invalid {agent_id} in resource URI' };
}

const dreamSummaryResource: McpResource = {
  uri: 'hypermove:///agents/{agent_id}/dream/summary',
  name: 'Dream Cycle Summary',
  description: "Short summary of the agent's last Dream Cycle learnings.",
  mimeType: 'application/json',
  async read(matchedUri) {
    if (!isMcpDreamCycleEnabled()) return dreamDisabledError();
    const agentId = matchedUri ? extractAgentId(matchedUri) : null;
    if (!agentId) return missingAgentIdError();
    const { getDreamStats } = await import('./dream/pipeline');
    const stats = await getDreamStats(agentId);
    return {
      agent_id: agentId,
      last_run_at: stats.last_run_at ?? null,
      status: stats.status ?? 'no_run_yet',
      memories_count: stats.memories_count ?? 0,
    };
  },
};

const dreamRulesResource: McpResource = {
  uri: 'hypermove:///agents/{agent_id}/dream/rules',
  name: 'Dream Cycle Rules',
  description: 'List of high-confidence rules learned for the agent.',
  mimeType: 'application/json',
  async read(matchedUri) {
    if (!isMcpDreamCycleEnabled()) return dreamDisabledError();
    const agentId = matchedUri ? extractAgentId(matchedUri) : null;
    if (!agentId) return missingAgentIdError();
    const { queryDream } = await import('./dream/pipeline');
    const result = await queryDream(agentId, 'rule', 20, 0.5);
    return { agent_id: agentId, rules: result.memories.filter((m) => m.type === 'rule') };
  },
};

const dreamErrorsResource: McpResource = {
  uri: 'hypermove:///agents/{agent_id}/dream/errors',
  name: 'Dream Cycle Error Patterns',
  description: 'List of error patterns learned for the agent.',
  mimeType: 'application/json',
  async read(matchedUri) {
    if (!isMcpDreamCycleEnabled()) return dreamDisabledError();
    const agentId = matchedUri ? extractAgentId(matchedUri) : null;
    if (!agentId) return missingAgentIdError();
    const { queryDream } = await import('./dream/pipeline');
    const result = await queryDream(agentId, 'error_pattern', 20, 0.3);
    return { agent_id: agentId, error_patterns: result.memories.filter((m) => m.type === 'error_pattern') };
  },
};

const dreamStatsResource: McpResource = {
  uri: 'hypermove:///agents/{agent_id}/dream/stats',
  name: 'Dream Cycle Stats',
  description: 'Metadata about the agent\'s last Dream Cycle run (budget, stages, memory count).',
  mimeType: 'application/json',
  async read(matchedUri) {
    if (!isMcpDreamCycleEnabled()) return dreamDisabledError();
    const agentId = matchedUri ? extractAgentId(matchedUri) : null;
    if (!agentId) return missingAgentIdError();
    const { getDreamStats } = await import('./dream/pipeline');
    return getDreamStats(agentId);
  },
};

const dreamWakeResource: McpResource = {
  uri: 'hypermove:///agents/{agent_id}/dream/wake',
  name: 'Dream Cycle Wake Context',
  description: 'Agent-ready REM wake package with digest, active constraints, validated skills, and prompt snippet.',
  mimeType: 'application/json',
  async read(matchedUri) {
    if (!isMcpDreamCycleEnabled()) return dreamDisabledError();
    const agentId = matchedUri ? extractAgentId(matchedUri) : null;
    if (!agentId) return missingAgentIdError();
    const { getWakeContext } = await import('./dream/wake');
    return getWakeContext(agentId);
  },
};

/** All resources, gated by the master flag. */
export function getResources(): McpResource[] {
  if (!isMcpResourcesEnabled()) return [];
  const resources = [ftsoFeedResource, amendmentsResource, fxrpCapacityResource];
  if (isMcpDreamCycleEnabled()) resources.push(dreamSummaryResource, dreamRulesResource, dreamErrorsResource, dreamStatsResource, dreamWakeResource);
  return resources;
}

/** Extract {agent_id} from a URI matching the "hypermove:///agents/{agent_id}/dream/..." template. */
function extractAgentId(matchedUri: string): string | null {
  const m = matchedUri.match(/^hypermove:\/\/\/agents\/([^/]+)\/dream\//);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Template-aware match: supports both prefix templates (existing resources,
 *  "{param}" trailing/anywhere-but-matched-as-prefix) and mid-path templates
 *  like "hypermove:///agents/{agent_id}/dream/summary" (Dream Cycle). */
function uriMatchesTemplate(uri: string, template: string): boolean {
  const pattern = '^' + template.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\{[^}]+\\\}/g, '[^/]+') + '$';
  return new RegExp(pattern).test(uri);
}

/** Find a resource by URI pattern (template-aware — supports {param} anywhere
 *  in the template). Precise template matches are checked across the WHOLE
 *  list first; the legacy startsWith-prefix fallback (for existing resources
 *  whose {param} is a trailing suffix, e.g. "ftso://feeds/{feedId}") only
 *  runs if no resource's full template matched — otherwise a resource with a
 *  short, generic prefix (e.g. "hypermove:///agents/" shared by all 4 Dream
 *  Cycle resources) would incorrectly shadow the correct, more specific match. */
export function findResource(uri: string): McpResource | undefined {
  const resources = getResources();
  const exact = resources.find((r) => uriMatchesTemplate(uri, r.uri));
  if (exact) return exact;
  return resources.find((r) => uri.startsWith(r.uri.split('{')[0]));
}
