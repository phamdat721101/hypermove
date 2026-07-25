import type { NextRequest } from 'next/server';
import { issueDeviceCode } from '@/lib/mcp/device-auth';
import { checkAndConsumeDeviceStart, clientIp, DEVICE_START_LIMIT_PER_IP } from '@/lib/mcp/rate-limit-device';
import { isMcpDeviceAuthEnabled } from '@/lib/platform-flag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/mcp/device/start — terminal device-code auth, step 1.
 *
 * No request body required. Returns a device_code (for polling) + a short
 * human-typable user_code (for the y/n approval prompt) + timing hints.
 * RFC-8628 field names so any generic device-flow client can consume this
 * without custom parsing.
 *
 * Deliberately reachable from any host, not just localhost (accepted
 * tradeoff — see platform-flag.ts's isMcpDeviceAuthEnabled() doc comment).
 * The only defense against free-token farming at this step is the per-IP
 * rate limit below; /device/approve's one-shot + 5-minute TTL close the loop.
 */
export async function POST(req: NextRequest) {
  if (!isMcpDeviceAuthEnabled()) {
    return Response.json({ error: 'device_auth_disabled' }, { status: 404 });
  }

  const ip = clientIp(req.headers);
  const rate = await checkAndConsumeDeviceStart(ip);
  if (!rate.allowed) {
    return Response.json(
      {
        error: 'rate_limited',
        hint: `max ${DEVICE_START_LIMIT_PER_IP} device-code requests / hour / IP`,
        retry_after_seconds: 3600,
      },
      { status: 429, headers: { 'retry-after': '3600' } },
    );
  }

  const result = await issueDeviceCode();
  if (!result.ok) {
    const status = result.error.code === 'feature_disabled' ? 404 : 500;
    return Response.json({ error: result.error.code ?? 'device_start_failed', hint: result.error.hint ?? result.error.message }, { status });
  }

  return Response.json(result.data);
}
