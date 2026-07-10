import type { NextRequest } from 'next/server';
import { verifyWalletSignature, storeToken } from '@/lib/mcp/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * POST /api/mcp/wallet-auth — wallet-signature sign-in for the MCP Gateway.
 *
 * Body: { address, message, signature } — the same triple wagmi's
 * useSignMessage() produces client-side. On success, returns a bearer token
 * from the same storeToken() the WorkOS flow uses (mcp_tokens table, 90-day
 * TTL) — the gateway treats both identity sources identically downstream.
 */
export async function POST(req: NextRequest) {
  let body: { address?: string; message?: string; signature?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { address, message, signature } = body;
  if (!address || !message || !signature) {
    return Response.json({ error: 'missing_fields', hint: 'address, message, signature are required' }, { status: 400 });
  }

  const verified = await verifyWalletSignature(address, message, signature as `0x${string}`);
  if (!verified.ok) {
    return Response.json({ error: 'signature_invalid', hint: verified.reason }, { status: 401 });
  }

  const token = await storeToken(verified.userId, undefined);
  if (!token) {
    return Response.json(
      { error: 'token_persist_failed', hint: 'DATABASE_URL is unset or unreachable — check server logs' },
      { status: 503 },
    );
  }
  return Response.json({
    ok: true,
    token,
    token_type: 'Bearer',
    usage: 'Send `Authorization: Bearer <token>` to /api/mcp',
  });
}
