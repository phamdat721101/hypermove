import { isMcpGatewayEnabled, isMcpAuthEnabled } from '@/lib/platform-flag';
import { getTools } from '@/lib/mcp/tools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/mcp/health — public liveness + gateway status. */
export async function GET() {
  return Response.json({
    ok: true,
    gateway_enabled: isMcpGatewayEnabled(),
    auth_required: isMcpAuthEnabled(),
    transport: 'streamable-http',
    tools: isMcpGatewayEnabled() ? getTools().map((t) => t.name) : ['payment.x402', 'reputation.read'],
    version: '2.0.0',
    // PRD-A (2026-07-27 dream-cycle-practical-readiness-feedback): commit +
    // deployed_at — build-time constants only (see scripts/deploy-vps.sh),
    // never a runtime `git` call — let an external integrator confirm which
    // commit this specific process (hypermove-app, separate from llm-service)
    // is actually running, instead of trusting an unverifiable "should be
    // fixed" claim. Additive-only: every existing field above is unchanged.
    commit: process.env.GIT_SHA || null,
    deployed_at: process.env.DEPLOYED_AT || null,
    time: new Date().toISOString(),
  });
}
