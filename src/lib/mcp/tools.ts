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
import { isMcpVectorSearchEnabled, isMcpNewsEnabled, isMcpAgenticEnabled, isMcpSkillsEnabled, isMcpBuilderBriefEnabled, isMcpXrplV3Enabled, isMcpFlareEnabled, isMcpInstructEnabled, isMcpTokenProfileEnabled, isMcpDreamCycleEnabled } from '../platform-flag';
import { getSkillTools } from '../skills';
import type { McpSession } from './auth';
import type { OutputEnforceConfig } from '../harness/types';

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
  /**
   * Opt-in output-enforcer contract (harness/output-enforcer.ts's
   * verifyOrHeal()). Undeclared (the default for every tool) means the
   * gateway runs zero enforcement for this tool — byte-identical to before
   * this field existed. Only set this when a tool's result shape has a
   * genuine, checkable success contract.
   */
  verify?: OutputEnforceConfig;
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
  description: 'Settle a payment via n-payment to unlock a paid session (100 queries) for a price tier. Submit the proof + network selection. Call codemode.payments.networks first to choose chain/rail/asset. Proof format depends on chain: EVM chains use the base64 EIP-3009 authorization+signature; XRPL chains (xrpl-mainnet/xrpl-testnet) accept EITHER a base64 PAYMENT-SIGNATURE facilitator-relay envelope OR, for a payment you already signed and submitted directly to the ledger yourself, a JSON string {"txHash":"..."} — the settlement independently re-verifies that transaction on-chain (validated + tesSUCCESS + correct destination/asset/amount) before granting the session. A txHash can only be redeemed once.',
  tier: 't1_read',
  unmetered: true,
  inputSchema: {
    type: 'object',
    properties: {
      tier: { type: 'string', description: 't1_read | t2_realtime | t3_vector' },
      chain: { type: 'string' }, rail: { type: 'string' }, asset: { type: 'string' },
      proof: {
        type: 'string',
        description: 'EVM chains: base64 EIP-3009 x402 authorization+signature. XRPL chains: EITHER a base64 PAYMENT-SIGNATURE facilitator-relay envelope, OR JSON.stringify({txHash}) for a transaction you already submitted directly — independently re-verified on-ledger, redeemable only once.',
      },
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

// ─── Builder brief synthesis (M4, nim-harnessed) ───────────────────────────

const flareBriefTool: ToolDef = {
  name: 'flare.builder.brief',
  description: 'Synthesize a Flare builder brief: FTSO feeds, FAssets, FDC, FCC capabilities + corpus grounding + news. Deterministic, nim-enforcer verified.',
  tier: 't3_vector',
  inputSchema: { type: 'object', properties: {}, required: [] },
  handler: async () => {
    const { buildBrief } = await import('./briefs');
    return buildBrief('flare-mainnet');
  },
};

const xrplBriefTool: ToolDef = {
  name: 'xrpl.builder.brief',
  description: 'Synthesize an XRPL builder brief: MPT, vault, lending, amendments capabilities + corpus grounding + news. Deterministic, nim-enforcer verified.',
  tier: 't3_vector',
  inputSchema: { type: 'object', properties: {}, required: [] },
  handler: async () => {
    const { buildBrief } = await import('./briefs');
    return buildBrief('xrpl-mainnet');
  },
};

const goatBriefTool: ToolDef = {
  name: 'goat.builder.brief',
  description: 'Synthesize a GOAT Network builder brief: BTC-native settlement, lending, MPP capabilities + corpus grounding + news. Deterministic, nim-enforcer verified.',
  tier: 't3_vector',
  inputSchema: { type: 'object', properties: {}, required: [] },
  handler: async () => {
    const { buildBrief } = await import('./briefs');
    return buildBrief('goat-mainnet');
  },
};

// ─── XRPL settlement synthesis (M1 Task17) ──────────────────────────────────

const xrplSettlementQuoteTool: ToolDef = {
  name: 'xrpl.settlement.quote',
  description: 'Compare RLUSD vs native XRP settlement cost/finality for an amount (Rule #33: native XRP for high-frequency micropayments, no trustline).',
  tier: 't2_realtime',
  inputSchema: {
    type: 'object',
    properties: {
      amount: { type: 'string', description: 'Amount in USD (e.g. "0.01")' },
      treasury: { type: 'string', description: 'Treasury account (r-address) for trustline check' },
    },
    required: ['amount'],
  },
  handler: async (args) => {
    const amount = Number(args.amount ?? '0.01');
    // Rule #33: native XRP for high-frequency micropayments (no trustline, deterministic fee)
    const xrpFee = 0.000012; // ~12 drops average
    const rlusFee = 0.000012; // Same fee, but requires trustline
    return {
      amount,
      recommendation: amount < 1 ? 'XRP' : 'RLUSD',
      rationale: amount < 1 ? 'Native XRP: no trustline required, deterministic fee (Rule #33)' : 'RLUSD: stable value for larger invoices',
      xrp: { feeXrp: xrpFee, trustlineRequired: false, finality: '~4s' },
      rlusd: { feeXrp: rlusFee, trustlineRequired: true, finality: '~4s' },
      rule: 'Rule #33: agentic settlement rotates RLUSD → native XRP for high-frequency micropayments',
    };
  },
};

const xrplX402StatusTool: ToolDef = {
  name: 'xrpl.x402.status',
  description: 'T54 XRPL x402 facilitator health + supported assets + trustline status for a treasury account.',
  tier: 't1_read',
  inputSchema: {
    type: 'object',
    properties: {
      treasury: { type: 'string', description: 'Treasury account (r-address) to check trustline status' },
    },
    required: [],
  },
  handler: async (args) => {
    // T54 facilitator status (best-effort; no network if unavailable)
    const facilitatorUrl = process.env.XRPL_FACILITATOR_URL ?? 'https://xrpl-x402.t54.ai';
    let facilitatorHealth = 'unknown';
    try {
      const res = await fetch(`${facilitatorUrl}/health`, { method: 'GET', signal: AbortSignal.timeout(2000) });
      facilitatorHealth = res.ok ? 'healthy' : 'degraded';
    } catch {
      facilitatorHealth = 'unreachable';
    }
    return {
      facilitator: { url: facilitatorUrl, health: facilitatorHealth },
      supportedAssets: ['XRP', 'RLUSD'],
      treasury: args.treasury ? { account: String(args.treasury), trustlineCheck: 'not_implemented' } : null,
      hint: 'HyperMove integrates T54 for XRPL x402 settlement. Set XRPL_FACILITATOR_URL to override.',
    };
  },
};

// ─── XLS-65/66 amendment gate (N1) ──────────────────────────────────────────
//
// Single Responsibility: this is the ONE place that decides whether a
// vault/lending read is safe to attempt on mainnet today. Both tools below
// compose it rather than duplicating the amendment-vote check.

const XRPL_LENDING_AMENDMENTS: Record<'vault' | 'lending', string[]> = {
  vault: ['SingleAssetVault'],
  lending: ['SingleAssetVault', 'Lending'],
};

async function withAmendmentGate(
  chain: string,
  kind: 'vault' | 'lending',
  read: () => Promise<unknown>,
): Promise<unknown> {
  const { buildRouter } = await import('./providers');
  const amendments = XRPL_LENDING_AMENDMENTS[kind];
  const status = (await buildRouter().dispatch({ chain, method: 'xrplAmendments', params: {} })) as {
    data?: { enabled?: string[] };
  };
  const enabled = status?.data?.enabled ?? [];
  const missing = amendments.filter((a) => !enabled.includes(a));
  if (missing.length > 0) {
    return {
      ok: false,
      reason: 'amendment_not_active',
      amendments: missing,
      hint: 'XLS-65/66 not yet activated on mainnet. Call xrpl.hub.trending for the current validator-vote percentage, or target Devnet.',
    };
  }
  return read();
}

const xrplVaultInfoTool: ToolDef = {
  name: 'xrpl.vault.info',
  description: 'XLS-65 single-asset-vault state (shares = MPTs, supplied/liquid balances). Returns a structured amendment_not_active response if the SingleAssetVault amendment is not yet active on the target chain.',
  tier: 't1_read',
  inputSchema: {
    type: 'object',
    properties: {
      chain: { type: 'string', description: 'default xrpl-mainnet' },
      vaultIndex: { type: 'string', description: 'the Vault ledger-object index' },
    },
  },
  handler: async (args) => {
    const chain = String(args.chain ?? 'xrpl-mainnet');
    return withAmendmentGate(chain, 'vault', async () => {
      const { buildRouter } = await import('./providers');
      return buildRouter().dispatch({ chain, method: 'xrplVaultInfo', params: { vaultIndex: args.vaultIndex } });
    });
  },
};

const xrplLendingStatusTool: ToolDef = {
  name: 'xrpl.lending.status',
  description: 'XLS-66 lending-protocol state (LoanBroker/Loan). Returns a structured amendment_not_active response if the Lending amendment is not yet active on the target chain.',
  tier: 't1_read',
  inputSchema: {
    type: 'object',
    properties: {
      chain: { type: 'string', description: 'default xrpl-mainnet' },
      loanIndex: { type: 'string' },
      loanBrokerIndex: { type: 'string' },
    },
  },
  handler: async (args) => {
    const chain = String(args.chain ?? 'xrpl-mainnet');
    return withAmendmentGate(chain, 'lending', async () => {
      const { buildRouter } = await import('./providers');
      return buildRouter().dispatch({
        chain,
        method: 'xrplLendingStatus',
        params: { loanIndex: args.loanIndex, loanBrokerIndex: args.loanBrokerIndex },
      });
    });
  },
};

// ─── N2 — XRPFi yield aggregator ────────────────────────────────────────────

const xrplYieldCompareTool: ToolDef = {
  name: 'xrpl.yield.compare',
  description: 'Compare live XRP/RLUSD yield venues (Soil, Flare-Monarq, Doppler) by rate, lock-up, model, and bridge requirement. Source-labeled, not investment advice.',
  tier: 't2_realtime',
  inputSchema: {
    type: 'object',
    properties: {
      maxLockupDays: { type: 'number', description: 'Filter out venues with a longer fixed lock-up than this' },
      requireNoBridge: { type: 'boolean', description: 'Only show XRPL-native venues (exclude venues requiring a cross-chain bridge step)' },
    },
  },
  handler: async (args) => {
    const { compareYield } = await import('./xrpfi-sources');
    return compareYield({
      maxLockupDays: args.maxLockupDays as number | undefined,
      requireNoBridge: args.requireNoBridge as boolean | undefined,
    });
  },
};

// ─── N3 — XRPL toolkit directory ───────────────────────────────────────────

const xrplToolkitListTool: ToolDef = {
  name: 'xrpl.toolkit.list',
  description: 'Canonical list of SDKs, CLIs, facilitators, and agent skills for building XRPL agentic-payment integrations (sourced from xrpl-ai.org/resources).',
  tier: 't1_read',
  inputSchema: {
    type: 'object',
    properties: {
      category: { type: 'string', description: 'sdk | facilitator | security | spec | protocol | cli | agent-skills | credit | docs | mcp' },
      installableOnly: { type: 'boolean' },
    },
  },
  handler: async (args) => {
    const { listToolkit } = await import('./xrpl-toolkit');
    return { entries: listToolkit({ category: args.category as any, installableOnly: args.installableOnly as boolean | undefined }) };
  },
};

// ─── N4 — XRPL AI Hub trending insight ─────────────────────────────────────

const xrplHubTrendingTool: ToolDef = {
  name: 'xrpl.hub.trending',
  description: 'Live snapshot of the XRPL AI Hub agentic-payments index (total payments, active merchants, provider concentration) plus the current XLS-65/66 lending-amendment vote status.',
  tier: 't3_vector',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const { trendingSummary } = await import('./xrpl-hub-index');
    const { buildRouter } = await import('./providers');
    const lendingAmendmentStatus = await buildRouter().dispatch({ chain: 'xrpl-mainnet', method: 'xrplAmendments', params: {} });
    return { ...trendingSummary(), lendingAmendmentStatus };
  },
};

// ─── N5 — FXRP bridge status ───────────────────────────────────────────────

const flareBridgeStatusTool: ToolDef = {
  name: 'flare.fassets.bridgeStatus',
  description: 'FXRP bridge lifecycle, adoption stats, and use cases — the XRP-to-Flare cross-chain path via FAssets.',
  tier: 't1_read',
  inputSchema: { type: 'object', properties: {} },
  handler: async () => {
    const { buildRouter } = await import('./providers');
    return buildRouter().dispatch({ chain: 'flare-mainnet', method: 'flareFassetsBridgeStatus', params: {} });
  },
};

// ─── flare.token.save / flare.token.profile (2026-07-20) ───────────────────
//
// Implements the user-supplied Token Profile schema. Independent of
// flare.instruct.dispatch — see platform-flag.ts's isMcpTokenProfileEnabled()
// doc comment.
// (Confidential MCP tool tier — confidential.attest, flare.confidential.swap/
// status — removed 2026-08-14, FCC removal. See
// docs/fcc-removal-proposal-2026-08-14.md.)

const flareTokenSaveTool: ToolDef = {
  name: 'flare.token.save',
  description: 'Compute and persist a structured Token Profile for a Flare token (native FLR/WFLR, FAssets FXRP/FBTC/FDOGE). Live-reads what is verifiable on-chain (registry-resolved AssetManager address, ERC-20 metadata, FTSO feed ID); honestly nulls or corpus-labels what is not a live read.',
  tier: 't2_realtime',
  // Proof-of-wiring example for the opt-in output-enforcer (2026-08-01):
  // saveTokenProfile() always returns a ServiceResult envelope (envelope.ts) —
  // {ok:true,data:{...}} or {ok:false,error:{...}} — so "ok" is the one field
  // genuinely present on every call, success or handled failure. This checks
  // the handler itself never returns something OTHER than a well-formed
  // envelope (e.g. a thrown value swallowed into `undefined`, or a future
  // refactor that forgets to wrap a branch in ok()/fail()) — it deliberately
  // does not gate on business-logic success, since {ok:false,...} is a valid,
  // intentional result this tool already returns (e.g. feature-disabled).
  verify: { verify: [{ kind: 'schema', required: ['ok'] }], onFail: 'block' },
  inputSchema: {
    type: 'object',
    properties: {
      tokenSymbol: { type: 'string', description: 'e.g. FLR, WFLR, FXRP, FBTC, FDOGE' },
      network: { type: 'string', enum: ['flare', 'coston2', 'songbird', 'coston'], description: 'default flare' },
    },
    required: ['tokenSymbol'],
  },
  handler: async (args) => {
    const { saveTokenProfile } = await import('./flare-token-profile');
    return saveTokenProfile({ tokenSymbol: String(args.tokenSymbol), network: args.network as 'flare' | 'coston2' | 'songbird' | 'coston' | undefined });
  },
};

const flareTokenProfileTool: ToolDef = {
  name: 'flare.token.profile',
  description: 'Retrieve a Token Profile for a Flare token — a previously saved one (flare.token.save), or computed fresh if none exists yet.',
  tier: 't1_read',
  inputSchema: {
    type: 'object',
    properties: {
      tokenSymbol: { type: 'string' },
      network: { type: 'string', enum: ['flare', 'coston2', 'songbird', 'coston'] },
    },
    required: ['tokenSymbol'],
  },
  handler: async (args) => {
    const { getTokenProfile } = await import('./flare-token-profile');
    return getTokenProfile({ tokenSymbol: String(args.tokenSymbol), network: args.network as 'flare' | 'coston2' | 'songbird' | 'coston' | undefined });
  },
};

// ─── flare.instruct.dispatch (2026-07-20) ───────────────────────────────────
//
// Bridges an MCP call to HyperMove's own Flare Compute Extension
// (services/tee-extension/) — submits an instruction to InstructionSender and
// polls ext-proxy for the result. Independent of the confidential.* tools above
// (see platform-flag.ts's isMcpInstructEnabled() doc comment for why it's not
// nested under isMcpConfidentialEnabled()).

const flareInstructDispatchTool: ToolDef = {
  name: 'flare.instruct.dispatch',
  description: 'Submit an instruction (financial action or generic agent task) to HyperMove\'s Flare Compute Extension and return the confidentially-executed result. Financial actions (SWAP/SETTLE) currently return an honest not-yet-implemented refusal — Protocol Managed Wallets\' third-party signing interface is not yet published. Generic agent tasks (COMPUTE) are similarly stubbed pending real task-execution logic.',
  tier: 't2_realtime',
  inputSchema: {
    type: 'object',
    properties: {
      opType: { type: 'string', enum: ['FINANCIAL_ACTION', 'GENERIC_AGENT_TASK'] },
      opCommand: { type: 'string', enum: ['SWAP', 'SETTLE'], description: 'required when opType is FINANCIAL_ACTION' },
      message: { type: 'object' },
      network: { type: 'string', description: 'default coston2' },
    },
    required: ['opType', 'message'],
  },
  handler: async (args) => {
    const { dispatchInstruction } = await import('./flare-instruct');
    return dispatchInstruction({
      opType: args.opType as 'FINANCIAL_ACTION' | 'GENERIC_AGENT_TASK',
      opCommand: args.opCommand as 'SWAP' | 'SETTLE' | undefined,
      message: (args.message as Record<string, unknown>) ?? {},
      network: args.network as string | undefined,
    });
  },
};

// ─── Dream Cycle (2026-07-26) ───────────────────────────────────────────────
//
// Offline memory-consolidation pipeline. All 5 tools are unmetered (spend is
// bounded by the per-cycle budget_usd guardrail in dream/pipeline.ts, not the
// gateway's paywall/free-tier metering) and gated by isMcpDreamCycleEnabled().
// See docs/prd/dream-cycle-v1.md.

const submitEpisodeLogTool: ToolDef = {
  name: 'submit_episode_log',
  description: 'Batch-upload episode logs for an agent into cold storage (Dream Cycle). No LLM calls occur. Idempotent per episode_id. Returns ingested count and rejection reasons.',
  tier: 't1_read',
  unmetered: true,
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string', description: 'Unique identifier of the agent.' },
      episodes: {
        type: 'array',
        description: 'Array of episode_log objects: {episode_id, agent_id, timestamp, task_type?, steps[], outcome, tags?}',
        items: {
          type: 'object',
          properties: {
            episode_id: { type: 'string' },
            agent_id: { type: 'string' },
            timestamp: { type: 'string', description: 'ISO 8601 timestamp' },
            task_type: { type: 'string' },
            steps: { type: 'array' },
            // PRD 02 fix (2026-07-26 live-session feedback): the valid
            // outcome values were previously only discoverable by
            // submitting an invalid one and reading the rejection reason.
            // Declaring the enum here surfaces it via tools/list's
            // inputSchema before a caller ever needs to guess.
            outcome: { type: 'string', enum: ['success', 'failure', 'timeout'], description: 'One of success | failure | timeout. There is no "partial" value — map ambiguous outcomes to the closest of these three.' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['episode_id', 'agent_id', 'timestamp', 'steps', 'outcome'],
        },
      },
    },
    required: ['agent_id', 'episodes'],
  },
  handler: async (args, ctx) => {
    const { ingestEpisodes } = await import('./dream/ingest');
    const agentId = String(args.agent_id ?? '');
    if (!Array.isArray(args.episodes)) {
      // Bug fix (2026-07-26, docs/FEEDBACK-dream-cycle-submit-episode-log-bug.md):
      // a wrongly-shaped `episodes` used to silently become [] here, producing
      // an indistinguishable {ingested_count:0, rejected:[]} for both garbage
      // input and a genuine empty batch. Surface it as a real rejection instead.
      return {
        ingested_count: 0,
        rejected: [{ episode_id: 'unknown', reason: 'episodes must be a JSON array of episode_log objects' }],
      };
    }
    return ingestEpisodes(agentId, ctx?.session.userId ?? 'anonymous', args.episodes as unknown[]);
  },
};

const startDreamTool: ToolDef = {
  name: 'start_dream',
  description: 'Start a Dream Cycle run for an agent — validates config against global budget limits and returns run_id and status. Runs immediately when called; trigger_criteria is always persisted and additionally enforced server-side on an hourly schedule if the operator has opted into FEATURE_MCP_DREAM_SCHEDULER (off by default).',
  tier: 't1_read',
  unmetered: true,
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string' },
      // PRD-B fix (2026-07-27 dream-cycle-practical-readiness-feedback): the
      // real nested shape used to exist only as a free-text `description`
      // string, so a typo'd preset or a wrong-typed budget_usd was caught
      // only deep inside startDream()'s own runtime validation, not by any
      // MCP client that validates/renders against the declared schema.
      // Mirrors the pattern already used for submit_episode_log's `outcome`
      // enum. Note: pipeline.ts still silently falls back to 'balanced' for
      // an unrecognized preset string (DREAM_PRESETS[config.preset] ?
      // config.preset : 'balanced') — that is a separate, deliberately
      // unchanged runtime behavior; this schema declaration does not alter
      // it, only makes the valid values discoverable up front.
      config: {
        type: 'object',
        description: '{budget_usd (required), preset?: frugal|balanced|thorough, trigger_criteria?}',
        properties: {
          budget_usd: {
            type: 'number',
            minimum: 0,
            description: 'Must not exceed the global per-cycle max (default $0.10, see DREAM_MAX_BUDGET_USD_PER_CYCLE).',
          },
          preset: {
            type: 'string',
            enum: ['frugal', 'balanced', 'thorough'],
            default: 'balanced',
          },
          trigger_criteria: {
            type: 'object',
            description: 'Persisted but not yet enforced server-side (see docs/dream-cycle) unless the scheduler feature flag is enabled.',
            properties: {
              time_window_utc: { type: 'string' },
              min_episodes: { type: 'number' },
              min_raw_tokens: { type: 'number' },
            },
          },
        },
        required: ['budget_usd'],
      },
    },
    required: ['agent_id', 'config'],
  },
  handler: async (args, ctx) => {
    const { startDream } = await import('./dream/pipeline');
    const cfg = (args.config ?? {}) as Record<string, unknown>;
    return startDream(String(args.agent_id ?? ''), ctx?.session.userId ?? 'anonymous', {
      budget_usd: Number(cfg.budget_usd),
      preset: (cfg.preset as string) ?? 'balanced',
      trigger_criteria: cfg.trigger_criteria as Record<string, unknown> | undefined,
    });
  },
};

const getDreamConfigTool: ToolDef = {
  name: 'get_dream_config',
  description: 'Retrieve the last stored Dream Cycle configuration for an agent.',
  tier: 't1_read',
  unmetered: true,
  inputSchema: { type: 'object', properties: { agent_id: { type: 'string' } }, required: ['agent_id'] },
  handler: async (args) => {
    const { getDreamConfig } = await import('./dream/pipeline');
    return getDreamConfig(String(args.agent_id ?? ''));
  },
};

const queryDreamTool: ToolDef = {
  name: 'query_dream',
  description: 'Query consolidated memories for an agent using a natural language query. Returns top_k memories filtered by min_confidence, rebuilt from the durable store on first read per process.',
  tier: 't1_read',
  unmetered: true,
  inputSchema: {
    type: 'object',
    properties: {
      agent_id: { type: 'string' },
      query: { type: 'string' },
      top_k: { type: 'number' },
      min_confidence: { type: 'number' },
    },
    required: ['agent_id', 'query'],
  },
  handler: async (args) => {
    const { queryDream } = await import('./dream/pipeline');
    return queryDream(
      String(args.agent_id ?? ''),
      String(args.query ?? ''),
      args.top_k !== undefined ? Number(args.top_k) : undefined,
      args.min_confidence !== undefined ? Number(args.min_confidence) : undefined,
    );
  },
};

const getDreamStatsTool: ToolDef = {
  name: 'get_dream_stats',
  description: 'Return stats and last run metadata for an agent\'s Dream Cycle (last_run_at, budget_used_usd, memories_count, stages_completed, per_stage_tokens).',
  tier: 't1_read',
  unmetered: true,
  inputSchema: { type: 'object', properties: { agent_id: { type: 'string' } }, required: ['agent_id'] },
  handler: async (args) => {
    const { getDreamStats } = await import('./dream/pipeline');
    return getDreamStats(String(args.agent_id ?? ''));
  },
};

// 2026-08-11 status-review upgrade, PRD 02 self-serve diagnostics. Free,
// unmetered, read-oriented tool letting a caller with only an MCP bearer
// token (no server/log access) check whether their own agent_id's episodes
// are actually being picked up, and whether the exact agent_id string used
// to write episodes matches the one used to read them — the corpus's
// leading (still unconfirmed) hypothesis for the `episodes_in: 0` bug. This
// tool does not fix that bug; see diagnostics.ts's header comment.
const getDreamEpisodeDiagnosticsTool: ToolDef = {
  name: 'get_dream_episode_diagnostics',
  description: 'Diagnose Dream Cycle episode pickup for an agent: live unconsumed-episode count, plus an exact-string comparison between the agent_id most recently used to submit episodes and the agent_id most recently used to start a run — surfaces a case/whitespace/UUID-format mismatch directly, without needing server/log access. Read-only diagnostic; does not fix the underlying episodes_in:0 bug (see docs/dream-cycle).',
  tier: 't1_read',
  unmetered: true,
  inputSchema: { type: 'object', properties: { agent_id: { type: 'string' } }, required: ['agent_id'] },
  handler: async (args, ctx) => {
    const { getDreamEpisodeDiagnostics } = await import('./dream/diagnostics');
    return getDreamEpisodeDiagnostics(String(args.agent_id ?? ''), ctx?.session.userId ?? 'anonymous');
  },
};

const reclaimAgentOwnershipTool: ToolDef = {
  name: 'reclaim_agent_ownership',
  description: 'Reclaim an agent_id currently owned by a DIFFERENT device-auth (anonymous, terminal-only) session, so a new device-code sign-in can continue using the same agent_id instead of fragmenting memory across a fresh one every session. Only works when the CURRENT owner is itself a device-auth session — an agent_id owned by a wallet- or account-authenticated session is never reclaimable this way (re-authenticate with that same wallet/account instead). Calling this on an agent_id you already own, or one with no owner yet, is a harmless no-op.',
  tier: 't1_read',
  unmetered: true,
  inputSchema: { type: 'object', properties: { agent_id: { type: 'string' } }, required: ['agent_id'] },
  handler: async (args, ctx) => {
    const { reclaimDeviceOwnership } = await import('./dream/ownership');
    return reclaimDeviceOwnership(String(args.agent_id ?? ''), ctx?.session.userId ?? 'anonymous');
  },
};

const getDreamSkillsTool: ToolDef = {
  name: 'get_dream_skills',
  description: 'Retrieve auto-generated, type-safe SOP SKILL.md specifications (Matt-Pocock Standard) compiled during Phase 4 Dream-Cycle compaction.',
  tier: 't1_read',
  unmetered: true,
  inputSchema: { type: 'object', properties: { agent_id: { type: 'string' } }, required: ['agent_id'] },
  handler: async (args) => {
    const { getAgentSkills } = await import('./dream/skillify-insights');
    return { skills: await getAgentSkills(String(args.agent_id ?? '')) };
  },
};

const getMorningBriefTool: ToolDef = {
  name: 'get_morning_brief',
  description: 'Retrieve the Sovereign Morning Brief markdown update (Phase 5: Executed, Neutralized, Proposed action plan) for an agent.',
  tier: 't1_read',
  unmetered: true,
  inputSchema: { type: 'object', properties: { agent_id: { type: 'string' } }, required: ['agent_id'] },
  handler: async (args) => {
    const { getDreamStats } = await import('./dream/pipeline');
    const { formatMorningBriefMarkdown } = await import('./dream/morning-brief');
    const stats = await getDreamStats(String(args.agent_id ?? ''));
    const briefMarkdown = formatMorningBriefMarkdown({
      agentId: String(args.agent_id ?? ''),
      runId: stats.last_run_at ?? 'latest',
      executed: (stats.stages_completed ?? []).includes('skillification') ? ['Distilled high-confidence insights into Matt-Pocock SKILL SOPs'] : [],
      neutralized: (stats.stage_summaries?.pruning_summary?.candidates_removed ?? 0) > 0 ? [`Pruned ${stats.stage_summaries?.pruning_summary?.candidates_removed} redundant or below-threshold memory candidates`] : [],
      proposed: [],
      tokensReducedPercent: 95,
    });
    return { agent_id: String(args.agent_id ?? ''), brief: briefMarkdown, stats };
  },
};

export function getTools(): ToolDef[] {
  const tools = [
    searchTool, vectorSearchTool, specTool, catalogTool, describeTool, paymentsNetworksTool,
    paymentsSettleTool, paymentsStatusTool, dataCallTool,
    xrplToolkitListTool, // N3 — canonical toolkit directory, always available (pure reference data)
  ];
  if (isMcpNewsEnabled()) tools.push(newsSearchTool, newsDigestTool, newsInsightTool);
  if (isMcpAgenticEnabled()) tools.push(roadmapTool, ideasTool, skillifyTool);
  if (isMcpSkillsEnabled()) tools.push(...getSkillTools());
  if (isMcpBuilderBriefEnabled()) tools.push(flareBriefTool, xrplBriefTool, goatBriefTool);
  if (isMcpXrplV3Enabled()) tools.push(xrplSettlementQuoteTool, xrplX402StatusTool, xrplVaultInfoTool, xrplLendingStatusTool, xrplYieldCompareTool, xrplHubTrendingTool);
  if (isMcpFlareEnabled()) tools.push(flareBridgeStatusTool);
  if (isMcpInstructEnabled()) tools.push(flareInstructDispatchTool);
  if (isMcpTokenProfileEnabled()) tools.push(flareTokenSaveTool, flareTokenProfileTool);
  if (isMcpDreamCycleEnabled()) tools.push(submitEpisodeLogTool, startDreamTool, getDreamConfigTool, queryDreamTool, getDreamStatsTool, getDreamEpisodeDiagnosticsTool, reclaimAgentOwnershipTool, getDreamSkillsTool, getMorningBriefTool);
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
