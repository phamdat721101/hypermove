/**
 * src/lib/mcp/agentic.ts
 * ----------------------
 * Agentic meta-tools: turn the gateway's own data + news into forward-looking
 * output an agent can act on — roadmap synthesis, product ideation, and
 * "skillify" (codify a task into a reusable skill spec).
 *
 * SOLID:
 *  - Single Responsibility: composition only. Grounds every result in the REAL
 *    catalog (catalog.ts) + news insight (news.ts) — no new data source.
 *  - Dependency Inversion: the LLM is an optional refinement seam (refine());
 *    absent → deterministic, genuinely-useful output (mock-first, testable).
 */

import { getCatalog, type CatalogEntry } from './catalog';
import { newsInsight } from './news';
import { fetchWithTimeout } from './http';

/** Optional LLM prose refinement. Absent/failed → returns the deterministic seed. */
async function refine(prompt: string, fallback: string): Promise<string> {
  const url = process.env.LLM_API_URL || process.env.NEXT_PUBLIC_LLM_API_URL;
  if (!url) return fallback;
  try {
    const res = await fetchWithTimeout(`${url.replace(/\/$/, '')}/insight`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'hypermove', prompt, items: [] }),
    });
    if (!res.ok) return fallback;
    const body = (await res.json()) as { insight?: string };
    return body.insight?.trim() || fallback;
  } catch {
    return fallback;
  }
}

/** Rank catalog entries relevant to a free-text query (grounding). */
function capabilitiesFor(query: string, limit = 12): CatalogEntry[] {
  const q = query.toLowerCase();
  const hits = getCatalog().filter((e) => `${e.id} ${e.description} ${e.keywords.join(' ')}`.toLowerCase().includes(q));
  return (hits.length ? hits : getCatalog()).slice(0, limit);
}

export interface Roadmap {
  project: string;
  summary: string;
  themes: string[];
  recommendations: string[];
  capabilities: string[];
  sources: string[];
}

/** Synthesize an upgrade roadmap for a project from today's news + capabilities. */
export async function insightRoadmap(project: string): Promise<Roadmap> {
  const insight = await newsInsight(project);
  const caps = capabilitiesFor(project);
  const themes = Array.from(new Set(caps.map((c) => c.kind)));
  const recommendations = caps.slice(0, 5).map((c) => `Leverage ${c.id} — ${c.description}`);
  const summary = await refine(`Given this news insight for ${project}: "${insight.insight}", propose a concise product roadmap.`, insight.insight);
  return { project, summary, themes, recommendations, capabilities: caps.map((c) => c.id), sources: insight.sources };
}

export interface Idea {
  title: string;
  rationale: string;
  buildsOn: string[];
}

/** Generate grounded product ideas for a topic/chain from the catalog. */
export async function ideasGenerate(topic: string): Promise<{ topic: string; ideas: Idea[]; nextSteps: string }> {
  const caps = capabilitiesFor(topic, 8);
  const ideas: Idea[] = caps.slice(0, 5).map((c) => ({
    title: `Agent capability built on ${c.id}`,
    rationale: c.description,
    buildsOn: [c.id],
  }));
  return { topic, ideas, nextSteps: 'Prototype an idea via data.call + news.insight, then codify it with skillify.' };
}

export interface SkillSpec {
  name: string;
  description: string;
  steps: string[];
  tools: string[];
  groundedIn: string[];
}

/** Codify a described task into a reusable skill spec referencing real tools. */
export async function skillify(task: string): Promise<SkillSpec> {
  const caps = capabilitiesFor(task, 6);
  const name = (task.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)) || 'custom-skill';
  const description = await refine(`Write a one-sentence description of a reusable agent skill for: ${task}`, `Reusable skill for: ${task}`);
  return {
    name,
    description,
    steps: [
      'search(query) — discover the relevant cross-chain operations',
      'data.call(chain, method, params) — fetch the live data',
      'news.search / codemode.news.insight(project) — add real-time context',
      'synthesize the result and return it to the caller',
    ],
    tools: Array.from(new Set(['search', 'data.call', 'codemode.news.insight', ...caps.map((c) => c.id)])).slice(0, 8),
    groundedIn: caps.map((c) => c.id),
  };
}
