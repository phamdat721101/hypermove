import type { NextRequest } from 'next/server';
import { workosExchange, storeToken } from '@/lib/mcp/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/mcp/callback — WorkOS redirects here with ?code=&state=. */
export async function GET(req: NextRequest) {
  const params = new URL(req.url).searchParams;
  const code = params.get('code');
  const state = params.get('state');
  if (!code) return Response.json({ error: 'missing_code' }, { status: 400 });

  // CSRF: the state must match the cookie set by /authorize.
  const cookieState = req.cookies.get('mcp_oauth_state')?.value;
  if (!state || !cookieState || state !== cookieState) {
    return Response.json({ error: 'invalid_state' }, { status: 400 });
  }

  const user = await workosExchange(code);
  if (!user) return Response.json({ error: 'exchange_failed' }, { status: 401 });

  const token = await storeToken(user.userId, user.email);
  const clearStateCookie = 'mcp_oauth_state=; Path=/api/mcp; Max-Age=0';
  if (!token) {
    return Response.json(
      { error: 'token_persist_failed', hint: 'DATABASE_URL is unset or unreachable — check server logs' },
      { status: 503, headers: { 'set-cookie': clearStateCookie } },
    );
  }

  // Browsers (the WorkOS redirect target) land on /mcp-connect, which renders
  // the token as a copyable key instead of raw JSON. Non-browser callers that
  // explicitly ask for JSON (e.g. a CLI polling this endpoint) still get the
  // machine-readable shape.
  if (req.headers.get('accept')?.includes('application/json')) {
    return new Response(
      JSON.stringify({
        ok: true,
        token,
        token_type: 'Bearer',
        usage: 'Send `Authorization: Bearer <token>` to https://hypermove.xyz/api/mcp',
      }),
      { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': clearStateCookie } },
    );
  }

  const redirectUrl = new URL('/mcp-connect', req.url);
  redirectUrl.searchParams.set('token', token);
  return new Response(null, {
    status: 302,
    headers: { location: redirectUrl.toString(), 'set-cookie': clearStateCookie },
  });
}
