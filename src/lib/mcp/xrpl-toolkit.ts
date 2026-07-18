/**
 * src/lib/mcp/xrpl-toolkit.ts
 * ----------------------------
 * N3 — XRPL toolkit directory. The 12 xrpl-ai.org/resources entries as
 * structured, filterable data — the canonical answer to "how do I accept
 * x402 on XRPL / what SDK do I install". Same corpus-file pattern as
 * xrpfi-sources.ts / flare-sources.ts (in-memory, deterministic, zero cost).
 */

export type ToolkitCategory =
  | 'sdk' | 'facilitator' | 'security' | 'spec' | 'protocol' | 'cli' | 'agent-skills' | 'credit' | 'docs' | 'mcp';

export interface ToolkitEntry {
  name: string;
  category: ToolkitCategory;
  status: 'live' | 'beta' | 'external';
  description: string;
  install: string | null;
  url: string;
  date: string;
}

export const XRPL_TOOLKIT: readonly ToolkitEntry[] = [
  { name: 'x402-xrpl (TypeScript SDK)', category: 'sdk', status: 'live', description: 'Express middleware (requirePayment) + x402Fetch buyer client + currency helpers + Verifiable Intent.', install: 'npm i x402-xrpl', url: 'https://www.npmjs.com/package/x402-xrpl', date: '2026-07-18' },
  { name: 'x402-xrpl (Python SDK)', category: 'sdk', status: 'live', description: 'FastAPI/Starlette helpers + presigned-payment client.', install: 'pip install x402-xrpl', url: 'https://pypi.org/project/x402-xrpl/', date: '2026-07-18' },
  { name: 't54 x402 Facilitator', category: 'facilitator', status: 'live', description: 'Hosted verify + settle for XRPL presigned payments. No custody, no API keys.', install: null, url: 'https://xrpl-x402.t54.ai', date: '2026-07-18' },
  { name: 'x402 Secure — Verifiable Intent', category: 'security', status: 'live', description: 'Know-Your-Agent credential + owner→agent delegation + per-payment risk gating (L1-L3).', install: null, url: 'https://www.t54.ai/x402-secure', date: '2026-07-18' },
  { name: 'Verifiable Intent (spec)', category: 'spec', status: 'external', description: 'Open spec for cryptographic agent authorization in commerce.', install: null, url: 'https://verifiableintent.dev/', date: '2026-07-18' },
  { name: 'Virtuals — Agent Commerce Protocol (ACP)', category: 'protocol', status: 'external', description: 'Cross-agent commerce standard; live on Base, XRPL support coming soon.', install: null, url: 'https://os.virtuals.io/acp/overview', date: '2026-07-18' },
  { name: 'RLUSD CLI', category: 'cli', status: 'live', description: 'Multi-chain RLUSD CLI: trust lines, XRPL DEX/AMM, Uniswap/Aave on EVM, Wormhole bridging, x402 requests.', install: null, url: 'https://github.com/t54-labs/rlusd-cli', date: '2026-07-18' },
  { name: 'XRPL CLI — xrpl-up', category: 'cli', status: 'external', description: "Ripple's CLI for local dev: sandbox with pre-funded accounts, snapshots, Claude Code plugin.", install: 'npm i -g xrpl-up', url: 'https://github.com/ripple/xrpl-up', date: '2026-07-18' },
  { name: 'RLUSD Skills', category: 'agent-skills', status: 'live', description: 'Claude/MCP agent skills wrapping the RLUSD CLI, with per-transaction spend caps.', install: null, url: 'https://github.com/t54-labs/rlusd-skills', date: '2026-07-18' },
  { name: 'ClawCredit', category: 'credit', status: 'beta', description: "Agent-native credit, underwritten by t54's risk engine.", install: null, url: 'https://www.claw.credit', date: '2026-07-18' },
  { name: 'XRPL Docs MCP Server', category: 'mcp', status: 'external', description: 'Official MCP server giving agents grounded access to XRPL documentation.', install: null, url: 'https://xrpl.org/resources/dev-tools/ai-tools', date: '2026-07-18' },
  { name: 'XRPL Commons — xrpl-dev-skills', category: 'agent-skills', status: 'external', description: 'Community-maintained agent skills for XRPL development.', install: null, url: 'https://github.com/XRPL-Commons/xrpl-dev-skills', date: '2026-07-18' },
  // Reference hub only — NOT a corpus source for xrpl.yield.compare. aigent.run's
  // own docs cite yield venues (Doppler, "Strobe", "MoreMarkets") but only Doppler
  // is independently corroborated (see xrpfi-sources.ts); "Strobe"/"MoreMarkets"
  // are explicitly excluded from yield data per this project's anti-fabrication
  // discipline. Listed here so builders can find it, not as a data source.
  { name: 'aigent.run — AI Agent Terminal', category: 'docs', status: 'external', description: 'Chat-first AI Agent Terminal for XRPL + XRPL EVM Sidechain (onchain analysis, trading execution, account/wallet + bridging, data/research). No public API/MCP endpoint; reference only — its cited yield venues beyond Doppler are unverified and excluded from xrpl.yield.compare.', install: null, url: 'https://aigent.run', date: '2026-07-18' },
] as const;

export interface ToolkitFilter {
  category?: ToolkitCategory;
  installableOnly?: boolean;
}

export function listToolkit(filter?: ToolkitFilter): ToolkitEntry[] {
  let items = [...XRPL_TOOLKIT];
  if (filter?.category) items = items.filter((t) => t.category === filter.category);
  if (filter?.installableOnly) items = items.filter((t) => t.install !== null);
  return items;
}
