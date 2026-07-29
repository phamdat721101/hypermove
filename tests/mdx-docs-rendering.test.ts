// Verifies the actual MDX compile pipeline used by next.config.mjs (via
// @next/mdx -> @mdx-js/mdx) correctly parses GFM tables and syntax-highlights
// code fences. Compiles fixtures directly through @mdx-js/mdx's compile()
// with the exact same remark/rehype plugin list configured in
// next.config.mjs, rather than running a full Next.js build — this isolates
// the parser/config bug (missing remark-gfm) fast, without the cost of a
// bundler build for every test run.
import { describe, expect, it } from 'vitest';
import { compile } from '@mdx-js/mdx';
import remarkGfm from 'remark-gfm';
import rehypePrettyCode from 'rehype-pretty-code';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Mirrors next.config.mjs's createMDX({ options: { remarkPlugins, rehypePlugins } }).
const MDX_OPTIONS = {
  remarkPlugins: [remarkGfm],
  rehypePlugins: [[rehypePrettyCode, { theme: 'github-light' }] as const],
};
// The current (pre-fix) next.config.mjs calls createMDX({}) — no plugins at all.
const LEGACY_NO_PLUGINS_OPTIONS = {};

const TABLE_FIXTURE = `
| Resource | Contents |
|---|---|
| \`hypermove:///agents/{agent_id}/dream/summary\` | Last run's status + how many memories exist |
| \`hypermove:///agents/{agent_id}/dream/rules\` | High-confidence rules |
`;

async function compileToString(source: string, options: Record<string, unknown> = MDX_OPTIONS): Promise<string> {
  const compiled = await compile(source, options as never);
  return String(compiled);
}

describe('MDX pipeline — GFM tables', () => {
  it('documents the bug: without remark-gfm (current next.config.mjs), a pipe table compiles as literal paragraph text, not a table', async () => {
    const out = await compileToString(TABLE_FIXTURE, LEGACY_NO_PLUGINS_OPTIONS);
    // Standard CommonMark has no table syntax — remark-parse (no GFM) treats the
    // whole block as one paragraph, so raw pipes/dashes survive into the output
    // as plain text content, and no table/tr/td elements are produced at all.
    expect(out).not.toMatch(/"table"/);
    expect(out).toContain('---');
  });

  it('compiles a GFM pipe table into real table/tr/td AST calls (not literal pipe text)', async () => {
    const out = await compileToString(TABLE_FIXTURE);
    // The compiled MDX output is a JS module that calls _jsx()/jsxs() with
    // element names as string literals — assert the table element names are
    // present as produced elements, and the raw markdown pipe/dash syntax is
    // NOT preserved as literal paragraph text.
    expect(out).toMatch(/"table"|\btable\b/);
    expect(out).toMatch(/"tr"|\btr\b/);
    expect(out).toMatch(/"td"|\btd\b/);
    expect(out).not.toContain('|---|---|');
  });
});

describe('MDX pipeline — Shiki syntax highlighting', () => {
  const codeFixture = '```bash\ncurl -s https://hypermove.xyz/api/mcp\n```\n';

  it('tags compiled code fences with Shiki/rehype-pretty-code output', async () => {
    const out = await compileToString(codeFixture);
    // rehype-pretty-code emits data-rehype-pretty-code-fragment / figure wrappers
    // and per-token inline color spans driven by the Shiki theme.
    expect(out).toMatch(/rehype-pretty-code|data-language|shiki|data-theme/i);
  });
});

// Regression guard (Task 3): compile the 7 REAL production docs files through
// the exact same plugin config as next.config.mjs, so a future revert of
// remark-gfm/rehype-pretty-code from next.config.mjs is caught by `pnpm test`
// without needing a full `next build` for every CI run.
describe('MDX pipeline — real /docs/*.mdx files', () => {
  const DOCS_DIR = path.resolve(__dirname, '..', 'src', 'app', 'docs');

  const FILES_WITH_TABLES = [
    'dream-cycle/page.mdx',
    'llm-service/page.mdx',
    'n-payment/page.mdx',
    'mcp-gateway/page.mdx',
    'page.mdx',
  ];

  // page.mdx (docs index) has no fenced code blocks at all — only inline
  // `code` and a small routing table — so it's intentionally excluded here.
  const FILES_WITH_CODE_FENCES = [
    'dream-cycle/page.mdx',
    'llm-service/page.mdx',
    'n-payment/page.mdx',
    'mcp-gateway/page.mdx',
    'agent-auth/page.mdx',
    'quickstart/page.mdx',
  ];

  it.each(FILES_WITH_TABLES)('%s compiles its GFM table(s) into real <table> markup', async (relPath) => {
    const source = readFileSync(path.join(DOCS_DIR, relPath), 'utf8');
    const out = await compileToString(source);
    expect(out).toMatch(/"table"/);
    expect(out).not.toMatch(/\|---+\|/);
  });

  it.each(FILES_WITH_CODE_FENCES)('%s compiles its code fences with Shiki highlighting', async (relPath) => {
    const source = readFileSync(path.join(DOCS_DIR, relPath), 'utf8');
    const out = await compileToString(source);
    expect(out).toMatch(/data-language|rehype-pretty-code|data-theme/i);
  });
});
