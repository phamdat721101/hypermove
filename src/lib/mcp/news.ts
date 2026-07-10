/**
 * src/lib/mcp/news.ts
 * -------------------
 * Real-time (daily) web3 news + AI insight layer. Ingests from a NewsProvider,
 * dedups, embeds, indexes in-process, and best-effort persists to mcp_news.
 * Exposes search / digest / insight — the three news tools.
 *
 * SOLID:
 *  - NewsProvider + InsightSynthesizer are injected interfaces (mock-first).
 *  - Reuses the shared Embedder + MemoryVectorStore — no new vector infra.
 */

import { withClient } from '../db';
import { fetchWithTimeout } from './http';
import { getEmbedder } from './embeddings';
import { MemoryVectorStore } from './vector-store';
import {
  MockNewsProvider,
  RssNewsProvider,
  type NewsItem,
  type NewsProvider,
} from './providers/news-provider';

// ─── Insight synthesis (AI layer) ──────────────────────────────────────────

export interface InsightSynthesizer {
  synthesize(project: string, items: NewsItem[]): Promise<string>;
}

/** Deterministic, zero-config insight — same items in → same text out. */
export class MockInsightSynthesizer implements InsightSynthesizer {
  async synthesize(project: string, items: NewsItem[]): Promise<string> {
    if (items.length === 0) return `No recent activity for ${project}.`;
    const titles = items.slice(0, 3).map((i) => i.title).join('; ');
    return `Insight for ${project}: ${items.length} update(s) today. Highlights: ${titles}.`;
  }
}

/** LLM-backed insight via the standalone LLM service. Falls back to mock. */
class LlmInsightSynthesizer implements InsightSynthesizer {
  private mock = new MockInsightSynthesizer();
  constructor(private url: string) {}

  async synthesize(project: string, items: NewsItem[]): Promise<string> {
    try {
      const res = await fetchWithTimeout(`${this.url.replace(/\/$/, '')}/insight`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ project, items: items.slice(0, 10) }),
      });
      if (!res.ok) throw new Error(`insight ${res.status}`);
      const body = (await res.json()) as { insight?: string };
      return body.insight?.trim() || this.mock.synthesize(project, items);
    } catch {
      return this.mock.synthesize(project, items);
    }
  }
}

function getSynthesizer(): InsightSynthesizer {
  const url = process.env.LLM_API_URL || process.env.NEXT_PUBLIC_LLM_API_URL;
  return url ? new LlmInsightSynthesizer(url) : new MockInsightSynthesizer();
}

function getProvider(): NewsProvider {
  return process.env.RSS_FEEDS || process.env.NEWS_LIVE === 'true' ? new RssNewsProvider() : new MockNewsProvider();
}

// ─── In-process index (rebuilt per snapshot date) ──────────────────────────

interface IndexedNews extends NewsItem { embedding: number[] }

let index: { date: string; items: IndexedNews[]; vectors: MemoryVectorStore<NewsItem> } | null = null;

export function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Ingest the daily snapshot: fetch → dedup → embed → index → best-effort persist. */
export async function ingestNews(date = todayUtc(), project?: string): Promise<NewsItem[]> {
  const res = await getProvider().fetchLatest({ date, project });
  const items = res.ok ? res.data : [];

  const seen = new Set<string>();
  const embedder = getEmbedder();
  const indexed: IndexedNews[] = [];
  for (const item of items) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    const embedding = await embedder.embed(`${item.title} ${item.summary ?? ''} ${item.project}`);
    indexed.push({ ...item, embedding });
  }

  const vectors = new MemoryVectorStore<NewsItem>();
  vectors.upsert(indexed.map((i) => ({ id: i.id, embedding: i.embedding, meta: stripEmbedding(i) })));
  index = { date, items: indexed, vectors };

  await persistNews(indexed);
  return indexed.map(stripEmbedding);
}

async function ensureIndex(): Promise<NonNullable<typeof index>> {
  if (!index || index.date !== todayUtc()) await ingestNews();
  return index!;
}

function stripEmbedding(i: IndexedNews): NewsItem {
  const { embedding: _e, ...rest } = i;
  return rest;
}

async function persistNews(items: IndexedNews[]): Promise<void> {
  if (items.length === 0) return;
  await withClient(async (client) => {
    for (const i of items) {
      await client.query(
        `INSERT INTO mcp_news (news_id, project, chain, title, summary, url, source, published_at, embedding)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (news_id) DO NOTHING`,
        [i.id, i.project, i.chain ?? null, i.title, i.summary ?? null, i.url ?? null, i.source, i.publishedAt, JSON.stringify(i.embedding)],
      );
    }
    return true;
  });
}

// ─── Tool operations ───────────────────────────────────────────────────────

export interface NewsSearchOptions {
  query: string;
  project?: string;
  limit?: number;
}

/** T1 — hybrid lexical + vector over the daily news index. */
export async function newsSearch(opts: NewsSearchOptions): Promise<{ hits: NewsItem[]; total: number; nextSteps: string }> {
  const idx = await ensureIndex();
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const q = opts.query.toLowerCase();
  const pool = opts.project ? idx.items.filter((i) => i.project.toLowerCase() === opts.project!.toLowerCase()) : idx.items;

  const lexical = pool.filter((i) => `${i.title} ${i.summary ?? ''}`.toLowerCase().includes(q));
  let hits = lexical.map(stripEmbedding);

  if (hits.length < limit) {
    const qv = await getEmbedder().embed(opts.query);
    const seen = new Set(hits.map((h) => h.id));
    for (const m of idx.vectors.query(qv, limit)) {
      if (seen.has(m.id)) continue;
      hits.push(m.meta);
      if (hits.length >= limit) break;
    }
  }

  hits = hits.slice(0, limit);
  return {
    hits,
    total: hits.length,
    nextSteps: 'Get an AI summary via codemode.news.insight(project). Group by day via codemode.news.digest(project).',
  };
}

/** T2 — per-project daily rollup. */
export async function newsDigest(project?: string, date = todayUtc()): Promise<{ date: string; projects: Record<string, NewsItem[]> }> {
  const idx = await ensureIndex();
  const grouped: Record<string, NewsItem[]> = {};
  for (const i of idx.items) {
    if (project && i.project.toLowerCase() !== project.toLowerCase()) continue;
    (grouped[i.project] ??= []).push(stripEmbedding(i));
  }
  return { date, projects: grouped };
}

/** T3 — LLM-synthesized insight for one project. */
export async function newsInsight(project: string): Promise<{ project: string; insight: string; sources: string[] }> {
  const idx = await ensureIndex();
  const items = idx.items.filter((i) => i.project.toLowerCase() === project.toLowerCase()).map(stripEmbedding);
  const insight = await getSynthesizer().synthesize(project, items);
  return { project, insight, sources: items.map((i) => i.url ?? '').filter(Boolean) };
}

/** Test hook. */
export function _resetNews(): void {
  index = null;
}
