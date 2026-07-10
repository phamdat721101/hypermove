import { getTool } from '@/lib/mcp/tools';
import { isMcpGatewayEnabled } from '@/lib/platform-flag';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/mcp/spec — public OpenAPI-3.1-style super spec (via codemode.spec). */
export async function GET() {
  if (!isMcpGatewayEnabled()) {
    return Response.json({ error: 'gateway_disabled' }, { status: 404 });
  }
  const spec = getTool('codemode.spec');
  const body = spec ? await spec.handler({}) : { error: 'spec_unavailable' };
  return Response.json(body);
}
