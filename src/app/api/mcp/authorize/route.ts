import type { NextRequest } from 'next/server';
import { randomUUID } from 'node:crypto';
import { workosAuthorizeUrl } from '@/lib/mcp/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/mcp/authorize — start the WorkOS AuthKit OAuth flow. */
export async function GET(_req: NextRequest) {
  const state = randomUUID();
  const url = workosAuthorizeUrl(state);
  if (!url) {
    return Response.json(
      { error: 'oauth_not_configured', hint: 'set WORKOS_CLIENT_ID + WORKOS_REDIRECT_URI' },
      { status: 503 },
    );
  }
  // Bind the state to the browser via an HttpOnly cookie; callback verifies it (CSRF defense).
  return new Response(null, {
    status: 302,
    headers: {
      location: url,
      'set-cookie': `mcp_oauth_state=${state}; HttpOnly; Secure; SameSite=Lax; Path=/api/mcp; Max-Age=600`,
    },
  });
}
