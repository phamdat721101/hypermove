import type { NextRequest } from 'next/server';
import { resolveDeviceCode } from '@/lib/mcp/device-auth';
import { isMcpDeviceAuthEnabled } from '@/lib/platform-flag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/mcp/device/approve — terminal device-code auth, step 2.
 *
 * Body: { user_code: string, decision: "y" | "n" }
 *
 * This IS the "verification" step for this flow — deliberately NOT a browser
 * URL. A human (or a script acting on a human's typed y/n) calls this from
 * the same terminal session as the agent that ran /device/start. No wallet
 * signature, no email, no pre-existing account — anonymous by design (see
 * device-auth.ts's module doc for the accepted tradeoff + mitigations).
 *
 * One-shot: a code can only move out of 'pending' once. A second call on an
 * already-resolved user_code returns a clear "already_resolved" error, never
 * a silent no-op and never a re-approval.
 */
export async function POST(req: NextRequest) {
  if (!isMcpDeviceAuthEnabled()) {
    return Response.json({ error: 'device_auth_disabled' }, { status: 404 });
  }

  let body: { user_code?: string; decision?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { user_code, decision } = body;
  if (!user_code || (decision !== 'y' && decision !== 'n')) {
    return Response.json(
      { error: 'missing_fields', hint: 'user_code (string) and decision ("y" | "n") are required' },
      { status: 400 },
    );
  }

  const result = await resolveDeviceCode(user_code, decision);
  if (!result.ok) {
    const status =
      result.error.code === 'not_found' ? 404 :
      result.error.code === 'already_resolved' ? 409 :
      result.error.code === 'expired' ? 410 :
      result.error.code === 'feature_disabled' ? 404 : 500;
    return Response.json({ error: result.error.code ?? 'approve_failed', hint: result.error.message }, { status });
  }

  return Response.json({ ok: true, status: result.data.status });
}
