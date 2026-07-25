import type { NextRequest } from 'next/server';
import { pollDeviceCode } from '@/lib/mcp/device-auth';
import { isMcpDeviceAuthEnabled } from '@/lib/platform-flag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/mcp/device/poll — terminal device-code auth, step 3.
 *
 * Body: { device_code: string }
 *
 * While pending → { status: "pending" } (agent should sleep `interval`
 * seconds, from /device/start's response, before polling again).
 * On approval → { status: "approved", token, token_type: "Bearer" } — the
 * SAME token on every repeat poll (idempotent mint, see device-auth.ts).
 * On denial/expiry → { status: "denied" | "expired" }, no token, terminal —
 * the agent should stop polling.
 */
export async function POST(req: NextRequest) {
  if (!isMcpDeviceAuthEnabled()) {
    return Response.json({ error: 'device_auth_disabled' }, { status: 404 });
  }

  let body: { device_code?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { device_code } = body;
  if (!device_code) {
    return Response.json({ error: 'missing_fields', hint: 'device_code (string) is required' }, { status: 400 });
  }

  const result = await pollDeviceCode(device_code);
  if (!result.ok) {
    const status =
      result.error.code === 'not_found' ? 404 :
      result.error.code === 'feature_disabled' ? 404 : 500;
    return Response.json({ error: result.error.code ?? 'poll_failed', hint: result.error.message }, { status });
  }

  return Response.json(result.data);
}
