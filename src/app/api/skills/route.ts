import type { NextRequest } from 'next/server';
import { isMcpSkillsEnabled } from '@/lib/platform-flag';
import { listSkillManifests } from '@/lib/skills';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * GET /api/skills — public catalog of HyperMove harness-wrapped skills.
 * The fetch target for the copy-paste install prompt + /tools page + CLI.
 * Read-only, unmetered (discovery/install, not execution).
 */
export async function GET(req: NextRequest) {
  if (!isMcpSkillsEnabled()) {
    return Response.json({ error: 'skills_disabled' }, { status: 404 });
  }
  const category = req.nextUrl.searchParams.get('category') ?? undefined;
  const skills = listSkillManifests(category);
  return Response.json({ count: skills.length, skills });
}
