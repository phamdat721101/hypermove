/**
 * src/lib/mcp/tools.ts
 * --------------------
 * The tool registry — the gateway's public surface. Each tool declares its
 * price tier so the paywall can meter it. Handlers are thin: they compose the
 * catalog / search / vector / news / payment modules. Hybrid search (lexical +
 * vector backfill) lives here as the orchestration seam.
 */

import { getCatalog, type CatalogEntry, type PriceTier } from './catalog';
import { lexicalSearch, type SearchHit, type SearchOptions, type SearchResult } from './search';
import { getEmbedder } from './embeddings';
import { MemoryVectorStore } from './vector-store';
import { newsSearch, newsDigest, newsInsight } from './news';
import { insightRoadmap, ideasGenerate, skillify } from './agentic';
import { supportedNetworks } from './payment-router';
import { settleSelection, findActiveSession, TIER_PRICE_USD } from './paywall';
import { isMcpVectorSearchEnabled, isMcpNewsEnabled, isMcpAgenticEnabled } from '../platform-flag';
import type { McpSession } from './auth';

/** Per-call context injected by the gateway (never from client args). */
export interface ToolContext {
  session: McpSession;
}

export interface ToolDef {
  name: string;
  description: string;
  tier: PriceTier;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<unknown>;
  /** Skip free-tier metering (e.g. payments.* — metering them would deadlock). */
  unmetered?: boolean;
}

// ─── Lazy catalog vector index (deterministic; built once) ─────────────────

let vectorIndex: MemoryVectorStore<CatalogEntry> | null = null;

async function getVectorIndex(): Promise<MemoryVectorStore<CatalogEntry>> {
  if (vectorIndex) return vectorIndex;
  const embedder = getEmbedder();
  const store = new MemoryVectorStore<CatalogEntry>();
  const items = await Promise.all(
    getCatalog().map(async (e) => ({
      id: e.id,
      embedding: await embedder.embed(`${e.id} ${e.description} ${e.keywords.join(' ')}`),
      meta: e,
    })),
  );
  store.upsert(items);
  vectorIndex = store;
  return store;
}

export function _resetTools(): void {
  vectorIndex = null;
}

/** Hybrid: lexical first, vector backfill when under limit + flag on. */
async function hybridSearch(opts: SearchOptions): Promise<SearchResult> {
  const catalog = getCatalog();
  const base = lexicalSearch(catalog, opts);
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  if (!isMcpVectorSearchEnabled() || base.hits.length >= limit || !opts.query) return base;

  const qv = await getEmbedder().embed(opts.query);
  const store = await getVectorIndex();
  const seen = new Set(base.hits.map((h) => h.id));
  const backfill: SearchHit[] = [];
  for (const m of store.query(qv, limit)) {
    if (seen.has(m.id) || m.score <= 0) continue;
    if (opts.service && m.meta.service !== opts.service) continue;
    if (opts.kind && m.meta.kind !== opts.kind) continue;
    backfill.push({
      id: m.meta.id, service: m.meta.service, chain: m.meta.chain, kind: m.meta.kind,
      score: Math.round(m.score * 1000) / 1000, tier: 'vector',
      description: m.meta.description, signature: m.meta.signature,
    });
    if (base.hits.length + backfill.length >= limit) break;
  }
  return { ...base, hits: [...base.hits, ...backfill], total: base.total + backfill.length, truncated: base.truncated };
}

// ─── Tool definitions ───────────────────────────────────────────────────────

const searchTool: ToolDef = {
  name: 'search',
  description: 'Ranked search over the unified cross-chain web3 catalog (operations, chains, protocols). Hybrid lexical + vector.',
  tier: 't1_read',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string' }, service: { type: 'string' }, chain: { type: 'string' },
      kind: { type: 'string' }, limit: { type: 'number' },
    },
    required: ['query'],
  },
  handler: (args) => hybridSearch(args as unknown as SearchOptions),
};

const vectorSearchTool: ToolDef = {
  name: 'codemode.vector.search',
  description: 'Pure semantic (vector) search over the catalog. Returns top-K by cosine similarity.',
  tier: 't3_vector',
  inputSchema: { type: 'object', properties: { query: { type: 'string' }, k: { type: 'number' } }, required: ['query'] },
  handler: async (args) => {
    const query = String(args.query ?? '');
    const k = Math.min(Math.max(Number(args.k ?? 10), 1), 50);
    const qv = await getEmbedder().embed(query);
    const store = await getVectorIndex();
    return {
      hits: store.query(qv, k).map((m) => ({
        id: m.id, service: m.meta.service, chain: m.meta.chain, kind: m.meta.kind,
        score: Math.round(m.score * 1000) / 1000, tier: 'vector', description: m.meta.description,
      })),
    };
  },
};

const specTool: ToolDef = {
  name: 'codemode.spec',
  description: 'Unified OpenAPI-3.1-style super spec for all gateway operations.',
  tier: 't1_read',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => buildSuperSpec(),
};

const catalogTool: ToolDef = {
  name: 'codemode.catalog',
  description: 'Full catalog manifest as flat data for arbitrary client-side grep.',
  tier: 't1_read',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => ({ entries: getCatalog() }),
};

const describeTool: ToolDef = {
  name: 'codemode.describe',
  description: 'Canonical detail-on-demand for one catalog entry id.',
  tier: 't1_read',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  handler: async (args) => {
    const entry = getCatalog().find((e) => e.id === args.id);
    return entry ?? { error: 'not_found', hint: `unknown id "${String(args.id)}"; use codemode.catalog() to list ids` };
  },
};

const paymentsNetworksTool: ToolDef = {
  name: 'codemode.payments.networks',
  description: 'Supported payment networks × rails × assets × tier prices. Call before paying to choose a network.',
  tier: 't1_read',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const { TIER_PRICE_USD } = await import('./paywall');
    return { networks: supportedNetworks(), tiers: TIER_PRICE_USD };
  },
};

const newsSearchTool: ToolDef = {
  name: 'news.search',
  description: 'Search daily web3 news across tracked projects (hybrid lexical + vector).',
  tier: 't1_read',
  inputSchema: { type: 'object', properties: { query: { type: 'string' }, project: { type: 'string' }, limit: { type: 'number' } }, required: ['query'] },
  handler: (args) => newsSearch(args as { query: string; project?: string; limit?: number }),
};

const newsDigestTool: ToolDef = {
  name: 'codemode.news.digest',
  description: 'Per-project daily news rollup.',
  tier: 't2_realtime',
  inputSchema: { type: 'object', properties: { project: { type: 'string' }, date: { type: 'string' } } },
  handler: (args) => newsDigest(args.project as string | undefined, args.date as string | undefined),
};

const newsInsightTool: ToolDef = {
  name: 'codemode.news.insight',
  description: 'AI-synthesized insight for one project from today\'s news.',
  tier: 't3_vector',
  inputSchema: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
  handler: (args) => newsInsight(String(args.project ?? '')),
};

// ─── Payment settlement over MCP (n-payment) ───────────────────────────────

const paymentsSettleTool: ToolDef = {
  name: 'payments.settle',
  description: 'Settle a payment via n-payment to unlock a paid session (100 queries) for a price tier. Submit the x402 proof + network selection. Call codemode.payments.networks first to choose chain/rail/asset.',
  tier: 't1_read',
  unmetered: true,
  inputSchema: {
    type: 'object',
    properties: {
      tier: { type: 'string', description: 't1_read | t2_realtime | t3_vector' },
      chain: { type: 'string' }, rail: { type: 'string' }, asset: { type: 'string' },
      proof: { type: 'string', description: 'base64 EIP-3009 x402 authorization+signature' },
    },
    required: ['tier', 'chain'],
  },
  handler: async (args, ctx) => {
    const tier = String(args.tier ?? '') as PriceTier;
    if (!(tier in TIER_PRICE_USD)) return { ok: false, error: `unknown tier "${tier}"`, hint: `tiers: ${Object.keys(TIER_PRICE_USD).join(', ')}` };
    return settleSelection(
      ctx?.session.userId ?? 'anonymous',
      tier,
      { chain: String(args.chain ?? ''), rail: args.rail as 'x402' | 'mpp' | undefined, asset: args.asset ? String(args.asset) : undefined },
      args.proof ? String(args.proof) : undefined,
    );
  },
};

const paymentsStatusTool: ToolDef = {
  name: 'payments.status',
  description: 'Report the active paid-session quota remaining for a tier.',
  tier: 't1_read',
  unmetered: true,
  inputSchema: { type: 'object', properties: { tier: { type: 'string' } }, required: ['tier'] },
  handler: async (args, ctx) => {
    const tier = String(args.tier ?? 't1_read') as PriceTier;
    const active = await findActiveSession(ctx?.session.userId ?? 'anonymous', tier);
    return active ?? { active: false, tier, hint: 'no active paid session — call payments.settle' };
  },
};

// ─── Live cross-chain data (routes through the provider AdapterRouter) ──────

const dataCallTool: ToolDef = {
  name: 'data.call',
  description: 'Execute a canonical read against live cross-chain data (EVM + Stellar + XRPL) via the best provider, with automatic fallback. Discover ops via search / codemode.catalog.',
  tier: 't2_realtime',
  inputSchema: {
    type: 'object',
    properties: {
      chain: { type: 'string', description: 'e.g. base-mainnet, stellar-mainnet, xrpl-mainnet' },
      method: { type: 'string', description: 'canonical operation id, e.g. getAccount, xrplAccountInfo' },
      params: { type: 'object' },
    },
    required: ['chain', 'method'],
  },
  handler: async (args) => {
    const { buildRouter } = await import('./providers');
    return buildRouter().dispatch({
      chain: String(args.chain ?? ''),
      method: String(args.method ?? ''),
      params: (args.params as Record<string, unknown>) ?? {},
    });
  },
};

// ─── Agentic meta-tools (roadmap / ideation / skillify) ────────────────────

const roadmapTool: ToolDef = {
  name: 'insight.roadmap',
  description: 'Synthesize a product-upgrade roadmap for a project from today\'s Stellar/XRPL/web3 news + the gateway capability catalog.',
  tier: 't3_vector',
  inputSchema: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
  handler: (args) => insightRoadmap(String(args.project ?? '')),
};

const ideasTool: ToolDef = {
  name: 'ideas.generate',
  description: 'Generate grounded product/feature ideas for a topic or chain, each tied to a real gateway capability.',
  tier: 't3_vector',
  inputSchema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
  handler: (args) => ideasGenerate(String(args.topic ?? '')),
};

const skillifyTool: ToolDef = {
  name: 'skillify',
  description: 'Codify a described task into a reusable skill spec (name, steps, tools) referencing real gateway tools.',
  tier: 't2_realtime',
  inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
  handler: (args) => skillify(String(args.task ?? '')),
};

export function getTools(): ToolDef[] {
  const tools = [
    searchTool, vectorSearchTool, specTool, catalogTool, describeTool, paymentsNetworksTool,
    paymentsSettleTool, paymentsStatusTool, dataCallTool,
  ];
  if (isMcpNewsEnabled()) tools.push(newsSearchTool, newsDigestTool, newsInsightTool);
  if (isMcpAgenticEnabled()) tools.push(roadmapTool, ideasTool, skillifyTool);
  return tools;
}

export function getTool(name: string): ToolDef | undefined {
  return getTools().find((t) => t.name === name);
}

function buildSuperSpec() {
  const paths: Record<string, unknown> = {};
  for (const t of getTools()) {
    paths[`/${t.name}`] = { post: { summary: t.description, 'x-price-tier': t.tier, requestBody: { content: { 'application/json': { schema: t.inputSchema } } } } };
  }
  return { openapi: '3.1.0', info: { title: 'HyperMove MCP Gateway', version: '1.0.0' }, paths };
}
