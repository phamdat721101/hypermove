/**
 * src/lib/mcp/providers/news-provider.ts
 * --------------------------------------
 * NewsProvider contract + deterministic MockNewsProvider (mock-first default)
 * + RssNewsProvider (real, RSS_FEEDS env). Same ServiceResult envelope as the
 * data providers — the contract is reused, not re-invented.
 */

import { createHash } from 'node:crypto';
import { ok, softEmpty, type ServiceResult } from '../envelope';
import { fetchWithTimeout } from '../http';
import { CHAINS, PROTOCOLS } from '../../registry';

export interface NewsItem {
  id: string;          // sha256(url + title)
  project: string;
  chain?: string;
  title: string;
  summary?: string;
  url?: string;
  source: string;
  publishedAt: string; // ISO-8601
}

export interface NewsFetchOptions {
  /** ISO date (YYYY-MM-DD) the daily snapshot is anchored to — keeps mock deterministic. */
  date: string;
  project?: string;
}

export interface NewsProvider {
  readonly name: string;
  fetchLatest(opts: NewsFetchOptions): Promise<ServiceResult<NewsItem[]>>;
}

export function newsId(url: string, title: string): string {
  return createHash('sha256').update(`${url}|${title}`).digest('hex').slice(0, 32);
}

/**
 * Curated default news feeds — used when RSS_FEEDS is unset but live news is
 * enabled (NEWS_LIVE=true). Stellar + XRPL ecosystem sources front and centre.
 */
export const DEFAULT_FEEDS: readonly string[] = [
  'Stellar|https://www.stellar.org/blog/rss.xml',
  'XRPL|https://xrpl.org/blog/feed.xml',
  'Ripple|https://ripple.com/insights/feed/',
];

/** Deterministic per-day, per-project news — same date in → same items out. */
export class MockNewsProvider implements NewsProvider {
  readonly name = 'mock';

  async fetchLatest(opts: NewsFetchOptions): Promise<ServiceResult<NewsItem[]>> {
    const projects = PROTOCOLS.map((p) => p.name).concat(CHAINS.map((c) => c.name));
    const chosen = opts.project ? projects.filter((p) => p.toLowerCase() === opts.project!.toLowerCase()) : projects;
    if (chosen.length === 0) return softEmpty('mock', `no tracked project "${opts.project}"`);

    const items: NewsItem[] = chosen.map((project) => {
      const seed = `${project}:${opts.date}`;
      const url = `https://news.hypermove.dev/${encodeURIComponent(project)}/${opts.date}`;
      const title = `${project} daily update — ${opts.date}`;
      return {
        id: newsId(url, title),
        project,
        title,
        summary: `Deterministic mock digest for ${project} on ${opts.date}. Seed ${seed.length}.`,
        url,
        source: 'mock',
        publishedAt: `${opts.date}T00:00:00.000Z`,
      };
    });
    return ok(items);
  }
}

/** Real RSS provider. RSS_FEEDS="proj|url,proj|url". Absent → curated defaults → mock. */
export class RssNewsProvider implements NewsProvider {
  readonly name = 'rss';
  private mock = new MockNewsProvider();

  async fetchLatest(opts: NewsFetchOptions): Promise<ServiceResult<NewsItem[]>> {
    const configured = (process.env.RSS_FEEDS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const feeds = configured.length ? configured : DEFAULT_FEEDS;
    if (feeds.length === 0) return this.mock.fetchLatest(opts);

    const items: NewsItem[] = [];
    for (const feed of feeds) {
      const [project, url] = feed.split('|');
      if (!project || !url) continue;
      if (opts.project && project.toLowerCase() !== opts.project.toLowerCase()) continue;
      try {
        const res = await fetchWithTimeout(url);
        if (!res.ok) continue;
        const xml = await res.text();
        for (const it of parseRssItems(xml).slice(0, 5)) {
          items.push({
            id: newsId(it.link, it.title),
            project,
            title: it.title,
            summary: it.description,
            url: it.link,
            source: 'rss',
            publishedAt: it.pubDate ?? `${opts.date}T00:00:00.000Z`,
          });
        }
      } catch {
        // skip this feed; other feeds + mock coverage remain
      }
    }
    return items.length ? ok(items) : this.mock.fetchLatest(opts);
  }
}

interface RssRaw { title: string; link: string; description?: string; pubDate?: string }

/** Minimal, dependency-free RSS item extraction. */
function parseRssItems(xml: string): RssRaw[] {
  const out: RssRaw[] = [];
  const blocks = xml.split(/<item[\s>]/i).slice(1);
  for (const block of blocks) {
    const pick = (tag: string) => {
      const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
      if (!m) return undefined;
      return m[1].replace(/<!\[CDATA\[|\]\]>/g, '').trim();
    };
    const title = pick('title');
    const link = pick('link');
    if (title && link) out.push({ title, link, description: pick('description'), pubDate: pick('pubDate') });
  }
  return out;
}
