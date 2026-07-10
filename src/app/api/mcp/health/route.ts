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
    time: new Date().toISOString(),
  });
}
