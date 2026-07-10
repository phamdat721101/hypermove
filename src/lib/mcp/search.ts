/**
 * src/lib/mcp/search.ts
 * ---------------------
 * Lexical scorer ported from Raven's searchCatalogPage. Pure + deterministic —
 * no I/O, no vector calls (those are layered on top in tools.ts as the hybrid
 * backfill). Returns ranked hits + a server-authored nextSteps hint.
 */

import type { CatalogEntry } from './catalog';

export type SearchTier = 'lexical' | 'vector';

export interface SearchHit {
  id: string;
  service: string;
  chain?: string;
  kind: string;
  score: number;
  tier: SearchTier;
  description: string;
  signature?: string;
}

export interface SearchOptions {
  query: string;
  kind?: string;
  service?: string;
  chain?: string;
  limit?: number;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  truncated: boolean;
  nextSteps: string;
}

const FIELD_WEIGHTS = { id: 12, service: 8, kind: 2, description: 5, keyword: 4 } as const;
const KIND_WEIGHT: Record<string, number> = { operation: 1, chain: 0.75, protocol: 0.75, dapp: 1 };
const MAX_SIGNATURE_CHARS = 2000;

function tokenize(q: string): string[] {
  return q.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
}

function scoreEntry(entry: CatalogEntry, tokens: string[]): { score: number; matched: number } {
  let score = 0;
  let matched = 0;
  const id = entry.id.toLowerCase();
  const desc = entry.description.toLowerCase();
  for (const t of tokens) {
    let hit = false;
    if (id.includes(t)) { score += FIELD_WEIGHTS.id; hit = true; }
    if (entry.service.toLowerCase().includes(t)) { score += FIELD_WEIGHTS.service; hit = true; }
    if (entry.kind.includes(t)) { score += FIELD_WEIGHTS.kind; hit = true; }
    if (desc.includes(t)) { score += FIELD_WEIGHTS.description; hit = true; }
    if (entry.keywords.includes(t)) { score += FIELD_WEIGHTS.keyword; hit = true; }
    if (hit) matched += 1;
  }
  return { score: score * (KIND_WEIGHT[entry.kind] ?? 1), matched };
}

/** Server-authored hint restated on every call (Raven pattern). */
function buildNextSteps(opts: SearchOptions, badService?: string): string {
  if (badService) {
    return `Unknown service "${badService}". Valid services: moralis, alchemy, quicknode, hypermove, npayment. Remove the filter or pick one of these.`;
  }
  return 'Refine with { service, chain, kind, limit }. Read a hit in detail via codemode.describe(id). Access payloads through the ".data" envelope property.';
}

/** Pure lexical search over a catalog slice. */
export function lexicalSearch(catalog: CatalogEntry[], opts: SearchOptions): SearchResult {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const tokens = tokenize(opts.query);

  const validServices = new Set(['moralis', 'alchemy', 'quicknode', 'hypermove', 'npayment']);
  if (opts.service && !validServices.has(opts.service)) {
    return { hits: [], total: 0, truncated: false, nextSteps: buildNextSteps(opts, opts.service) };
  }

  // Filter by structural fields first.
  let pool = catalog;
  if (opts.service) pool = pool.filter((e) => e.service === opts.service);
  if (opts.kind) pool = pool.filter((e) => e.kind === opts.kind);
  if (opts.chain) pool = pool.filter((e) => !e.chain || e.chain === opts.chain);

  const coverageThreshold = tokens.length <= 2 ? tokens.length : Math.ceil(tokens.length * 0.6);

  const scored = pool
    .map((entry) => ({ entry, ...scoreEntry(entry, tokens) }))
    .filter((s) => tokens.length === 0 || (s.score > 0 && s.matched >= coverageThreshold))
    .sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id));

  // Per-service diversity quota so one chatty provider can't blanket results.
  const perServiceCap = Math.max(2, Math.ceil(0.4 * limit));
  const perService = new Map<string, number>();
  const kept: typeof scored = [];
  for (const s of scored) {
    const used = perService.get(s.entry.service) ?? 0;
    if (used >= perServiceCap) continue;
    perService.set(s.entry.service, used + 1);
    kept.push(s);
  }

  const total = kept.length;
  const hits: SearchHit[] = kept.slice(0, limit).map((s) => ({
    id: s.entry.id,
    service: s.entry.service,
    chain: s.entry.chain,
    kind: s.entry.kind,
    score: Math.round(s.score * 100) / 100,
    tier: 'lexical',
    description: s.entry.description,
    signature: s.entry.signature && s.entry.signature.length > MAX_SIGNATURE_CHARS
      ? s.entry.signature.slice(0, MAX_SIGNATURE_CHARS) + ' /* …truncated */'
      : s.entry.signature,
  }));

  return { hits, total, truncated: total > hits.length, nextSteps: buildNextSteps(opts) };
}
