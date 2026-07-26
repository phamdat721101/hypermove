import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * GET /llms.txt — the llmstxt.org convention: one plain-text document an agent
 * fetches to read all of HyperMove's docs in a single request.
 *
 * SOLID / DRY: the docs stay authored once as MDX under src/app/docs; this route
 * derives the text from those same files (no duplicated content). It is rendered
 * statically at build (`force-static`) so the filesystem reads happen at build
 * time only — zero runtime fs, cache-friendly, and trivial to deploy.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-static';

const SITE = process.env.HYPERMOVE_SITE_URL ?? 'https://hypermove.xyz';

/** Doc order mirrors the DOCS_NAV outline: Overview → Get started → Platform → Payments. */
const DOCS: ReadonlyArray<{ slug: string; title: string; file: string }> = [
  { slug: '/docs', title: 'Introduction', file: 'src/app/docs/page.mdx' },
  { slug: '/docs/quickstart', title: 'Quickstart — 5 min', file: 'src/app/docs/quickstart/page.mdx' },
  { slug: '/docs/mcp-gateway', title: 'MCP Gateway', file: 'src/app/docs/mcp-gateway/page.mdx' },
  { slug: '/docs/dream-cycle', title: 'Dream Cycle — offline memory', file: 'src/app/docs/dream-cycle/page.mdx' },
  { slug: '/docs/n-payment', title: 'n-payment SDK', file: 'src/app/docs/n-payment/page.mdx' },
];

/** Strip the MDX `export const metadata = …` line → leave clean Markdown body. */
function toMarkdown(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('export const metadata'))
    .join('\n')
    .trim();
}

export function GET(): Response {
  const header = [
    '# HyperMove',
    '',
    '> Make any web3 dApp agent-callable and monetizable per call. One MCP endpoint lets AI agents discover, connect to, and pay for on-chain actions across 27+ chains. Open-source, MIT.',
    '',
    `> MCP endpoint: ${SITE}/api/mcp · Skill catalog: ${SITE}/api/skills · Manifest: ${SITE}/.well-known/webmcp.json`,
    '',
    '## Docs',
    '',
    ...DOCS.map((d) => `- [${d.title}](${SITE}${d.slug})`),
    '',
    '---',
  ];

  const body = DOCS.map((d) => {
    const raw = readFileSync(join(process.cwd(), d.file), 'utf8');
    return `\n${toMarkdown(raw)}\n\n---`;
  });

  return new Response([...header, ...body].join('\n') + '\n', {
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600, s-maxage=3600',
    },
  });
}
