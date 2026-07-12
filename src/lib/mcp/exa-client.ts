/**
 * src/lib/mcp/exa-client.ts
 * -------------------------
 * Thin, standalone wrapper around Exa (the AI search engine) for the PAID
 * `xrpl-research-pro` skill. NOT a `DataProvider` — Exa is a web-search engine,
 * not a web3 data adapter, so forcing it into that interface would be the wrong
 * abstraction. The skill calls `xrplResearch()` directly.
 *
 * SOLID:
 *  - Single Responsibility: own the Exa call + map its result into the
 *    harness-verifiable XRPL research schema. Nothing else.
 *  - Honest degradation: no EXA_API_KEY → returns a typed plan-only result
 *    (providerConfigured:false), mirroring the catalog's provider-gated skills.
 *
 * Cost guard: default depth `deep-lite`; `deep-reasoning` is only reachable when
 * the caller has already passed the flag check (see the skill). exa-js is
 * lazy-imported so the module never hard-depends on it at build time.
 */

export type XrplDepth = 'fast' | 'deep-lite' | 'deep' | 'deep-reasoning';
export type XrplCategory = 'research paper' | 'news' | 'docs' | 'any';

export interface XrplResearchInput {
  query: string;
  /** ISO date — freshness floor for "latest". */
  since?: string;
  depth?: XrplDepth;
  category?: XrplCategory;
}

export interface XrplResearchResource {
  title: string;
  url: string;
  highlight?: string;
  date?: string;
  relevance?: number;
}

export interface XrplResearchResult extends Record<string, unknown> {
  summary: string;
  key_findings: string[];
  resources: XrplResearchResource[];
  providerConfigured: boolean;
  depth: XrplDepth;
  costUsdEstimate: number;
}

/** Harness output-enforcer schema (verified before the result ships). */
export const XRPL_RESEARCH_SCHEMA = {
  type: 'object',
  required: ['summary', 'resources'],
  properties: {
    summary: { type: 'string' },
    key_findings: { type: 'array', items: { type: 'string' } },
    resources: {
      type: 'array',
      items: {
        type: 'object',
        required: ['title', 'url'],
        properties: {
          title: { type: 'string' },
          url: { type: 'string' },
          highlight: { type: 'string' },
          date: { type: 'string' },
          relevance: { type: 'number' },
        },
      },
    },
  },
} as const;

/** Rough Exa $/query by depth (exa.ai/pricing, contents+summary, 10 results). */
const COST_BY_DEPTH: Record<XrplDepth, number> = {
  fast: 0.008,
  'deep-lite': 0.008,
  deep: 0.013,
  'deep-reasoning': 0.016,
};

function scopeQuery(query: string): string {
  // Keep it XRPL-scoped without over-constraining Exa's neural ranking.
  return /xrpl|xrp ledger|ripple/i.test(query) ? query : `${query} (XRP Ledger / XRPL)`;
}

/** Minimal shape we read from an exa-js result item (defensive, version-tolerant). */
interface ExaItem {
  title?: string;
  url?: string;
  publishedDate?: string;
  summary?: string;
  highlights?: string[];
  score?: number;
}

function toResources(items: ExaItem[]): XrplResearchResource[] {
  return items
    .filter((it) => it.url)
    .map((it) => ({
      title: it.title || it.url!,
      url: it.url!,
      highlight: it.highlights?.[0] ?? it.summary ?? undefined,
      date: it.publishedDate ?? undefined,
      relevance: typeof it.score === 'number' ? Math.round(it.score * 1000) / 1000 : undefined,
    }));
}

function synthSummary(items: ExaItem[], query: string): { summary: string; findings: string[] } {
  const findings = items
    .map((it) => it.summary || it.highlights?.[0])
    .filter((s): s is string => Boolean(s))
    .slice(0, 5);
  const summary = findings.length
    ? `Latest XRPL findings for "${query}": ${findings[0]}`
    : `No fresh XRPL sources found for "${query}".`;
  return { summary, findings };
}

/**
 * Deep, freshness-ranked XRPL research via Exa. Returns a schema-valid result
 * the harness output-enforcer can verify. Falls back to a plan-only result when
 * EXA_API_KEY is unset (zero cost, still schema-valid).
 */
export async function xrplResearch(input: XrplResearchInput): Promise<XrplResearchResult> {
  const depth: XrplDepth = input.depth ?? 'deep-lite';
  const query = scopeQuery(input.query.trim());

  if (!process.env.EXA_API_KEY) {
    return {
      summary: `Plan only — set EXA_API_KEY to run live XRPL research for "${input.query}".`,
      key_findings: [],
      resources: [],
      providerConfigured: false,
      depth,
      costUsdEstimate: 0,
    };
  }

  const { default: Exa } = (await import('exa-js')) as { default: new (key: string) => ExaSearch };
  const exa = new Exa(process.env.EXA_API_KEY);

  const res = await exa.searchAndContents(query, {
    type: depth,
    numResults: 10,
    category: input.category && input.category !== 'any' ? input.category : undefined,
    startPublishedDate: input.since,
    highlights: true,
    summary: true,
  });

  const items: ExaItem[] = Array.isArray(res?.results) ? res.results : [];
  const { summary, findings } = synthSummary(items, input.query);
  return {
    summary,
    key_findings: findings,
    resources: toResources(items),
    providerConfigured: true,
    depth,
    costUsdEstimate: COST_BY_DEPTH[depth],
  };
}

/** Narrow structural type for the exa-js client (avoids a hard type dep). */
interface ExaSearch {
  searchAndContents(
    query: string,
    opts: {
      type: string;
      numResults?: number;
      category?: string;
      startPublishedDate?: string;
      highlights?: boolean;
      summary?: boolean;
    },
  ): Promise<{ results?: ExaItem[] }>;
}
