import type { NextRequest } from 'next/server';
import { isMcpSkillsEnabled } from '@/lib/platform-flag';
import { getSkillInstall, getSkillMd } from '@/lib/skills';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/skills/[name]           → JSON install payload (manifest + skill.md +
 *                                    hypermove.json + installPrompt + mcpConnect)
 * GET /api/skills/[name]?format=md → raw SKILL.md text (the fetch target the
 *                                    copy-paste install prompt saves to disk)
 *
 * Public, read-only, unmetered — this is the install fetch target, not skill
 * execution (execution runs through skill.<name> on the metered MCP gateway).
 */
export async function GET(req: NextRequest, { params }: { params: { name: string } }) {
  if (!isMcpSkillsEnabled()) {
    return Response.json({ error: 'skills_disabled' }, { status: 404 });
  }
  const name = params.name;

  if (req.nextUrl.searchParams.get('format') === 'md') {
    const md = getSkillMd(name);
    if (!md) return new Response('skill not found\n', { status: 404, headers: { 'content-type': 'text/plain' } });
    return new Response(md, {
      status: 200,
      headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'public, max-age=300' },
    });
  }

  const payload = getSkillInstall(name);
  if (!payload) {
    return Response.json({ ok: false, error: 'not_found', hint: 'GET /api/skills to list skills' }, { status: 404 });
  }
  return Response.json({ ok: true, ...payload });
}
