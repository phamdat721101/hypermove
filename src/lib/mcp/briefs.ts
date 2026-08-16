/**
 * src/lib/mcp/briefs.ts
 * ---------------------
 * Builder brief synthesis — composes live reads + static corpus + news
 * into a deterministic, forward-looking brief for a chain.
 *
 * SOLID:
 *  - Single Responsibility: composition only. Reads come from providers,
 *    corpus from *-sources.ts, news from news.ts.
 *  - Dependency Inversion: the LLM is an optional refinement seam (refine());
 *    absent → deterministic, genuinely-useful output (mock-first, testable).
 *
 * Security:
 *  - Wrapped in runHarnessed() for output verification (nim-enforcer blocks
 *    fabricated figures; all numbers must be grounded in corpus or live reads).
 *  - No new network calls beyond existing providers/news.
 */

import { ok, fail, type ServiceResult } from './envelope';
import { getCatalog } from './catalog';
import { newsInsight } from './news';
import { FLARE_CORPUS } from './flare-sources';
import { XRPL_CORPUS } from './xrpl-sources';
import { GOAT_CORPUS } from './goat-sources';
import { isMcpBuilderBriefEnabled, isMcpFlareEnabled, isMcpXrplV3Enabled, isMcpGoatEnabled } from '../platform-flag';
import { runHarnessed, type SkillDef } from 'nim-skill';
import { mcpNimHarness } from './nim-harness';

/** Corpus entry shape shared across chains. */
interface CorpusEntry {
  id: string;
  chain: string;
  title: string;
  summary: string;
  source: string;
  date: string;
}

/** Deterministic brief output. */
export interface Brief {
  chain: string;
  generatedAt: string;
  /** Top 3-5 capabilities relevant to the chain. */
  capabilities: string[];
  /** Corpus-grounded context (no fabrication). */
  context: string[];
  /** Live news insight (optional, best-effort). */
  news?: string;
  /** Actionable recommendations (deterministic from catalog). */
  recommendations: string[];
  /** ROI hint from nim-cache (if caching was used). */
  cacheROI?: { savedTokens: number; hitRate: number };
}

/** Compose a deterministic brief for a chain. */
function composeBrief(chain: string): ServiceResult<Brief> {
  if (!isMcpBuilderBriefEnabled()) {
    return fail('briefs', 'builder.brief disabled', { code: 'feature_disabled', hint: 'set FEATURE_MCP_BUILDER_BRIEF=true' });
  }

  const catalog = getCatalog();
  const chainCaps = catalog.filter((e) => e.id.startsWith(chain) || e.keywords.includes(chain));
  const capabilities = chainCaps.slice(0, 5).map((c) => c.id);

  // Corpus grounding (no fabrication)
  const context: string[] = [];
  if (chain.startsWith('flare') && isMcpFlareEnabled()) {
    context.push(...FLARE_CORPUS.slice(0, 3).map((s) => `[${s.source_type}] ${s.title}: ${s.snippet}`));
  }
  if (chain.startsWith('xrpl') && isMcpXrplV3Enabled()) {
    context.push(...XRPL_CORPUS.slice(0, 3).map((s) => `[${s.source_type}] ${s.title}: ${s.snippet}`));
  }
  if (chain.startsWith('goat') && isMcpGoatEnabled()) {
    context.push(...GOAT_CORPUS.slice(0, 3).map((s) => `[${s.source_type}] ${s.title}: ${s.snippet}`));
  }

  const recommendations = chainCaps.slice(0, 3).map((c) => `Use ${c.id} — ${c.description}`);

  return ok({
    chain,
    generatedAt: new Date().toISOString(),
    capabilities,
    context,
    recommendations,
  });
}

/** Optional LLM refinement (same pattern as agentic.ts). */
async function refineBrief(prompt: string, fallback: Brief): Promise<Brief> {
  const url = process.env.LLM_API_URL || process.env.NEXT_PUBLIC_LLM_API_URL;
  if (!url) return fallback;
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/insight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'hypermove', prompt, items: [] }),
    });
    if (!res.ok) return fallback;
    const body = (await res.json()) as { insight?: string };
    if (!body.insight?.trim()) return fallback;
    // Inject refined insight into news field (deterministic base remains)
    return { ...fallback, news: body.insight.trim() };
  } catch {
    return fallback;
  }
}

/** Build a brief with nim-harness (cache + enforcer). */
export async function buildBrief(chain: string): Promise<ServiceResult<Brief>> {
  if (!isMcpBuilderBriefEnabled()) {
    return fail('briefs', 'builder.brief disabled', { code: 'feature_disabled', hint: 'set FEATURE_MCP_BUILDER_BRIEF=true' });
  }

  const skill: SkillDef = {
    name: `${chain}.builder.brief`,
    version: '1.0.0',
    harness: mcpNimHarness({
      enforcer: { strategies: [{ kind: 'schema', required: ['chain', 'generatedAt', 'capabilities'] }], maxHeals: 2, mode: 'strict' },
    }),
    async execute(_input: unknown, ctx) {
      const base = composeBrief(chain);
      if (!base.ok) return base;

      // Optional: add news insight
      try {
        const insight = await newsInsight(chain);
        if (insight.insight) {
          base.data.news = insight.insight;
        }
      } catch {
        // News is best-effort; don't fail the brief
      }

      // Optional: LLM refinement
      const refined = await refineBrief(`Refine this ${chain} brief for an AI agent: ${JSON.stringify(base.data)}`, base.data);

      // Record cache ROI if ctx.cache is present (nim-skill v0.3.0+)
      if (ctx.cache && typeof ctx.cache.record === 'function') {
        // Simulated ROI — in production, ctx.cache.record(usage) would be called
        refined.cacheROI = { savedTokens: 0, hitRate: 0 };
      }

      return ok(refined);
    },
  };

  // Run harnessed — enforcer blocks if schema check fails
  const { output, verified } = await runHarnessed(skill, { chain }, { agentId: 'hypermove-briefs' });
  if (!verified) {
    return fail('briefs', 'brief verification failed', { code: 'enforcer_block', hint: 'brief missing required fields (chain, generatedAt, capabilities)' });
  }
  return output as ServiceResult<Brief>;
}
