import type { NextRequest } from 'next/server';
import { getQuota, consumeQuota } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/quota?wallet=0x... — check remaining quota */
export async function GET(req: NextRequest) {
  const wallet = req.nextUrl.searchParams.get('wallet');
  if (!wallet) return Response.json({ error: 'Missing wallet param' }, { status: 400 });

  const quota = await getQuota(wallet);
  if (!quota) return Response.json({ error: 'DB error' }, { status: 500 });

  return Response.json(quota);
}

/** POST /api/quota — consume 1 scan { wallet: "0x..." } */
export async function POST(req: NextRequest) {
  let body: { wallet?: string };
  try { body = await req.json(); } catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }

  if (!body.wallet) return Response.json({ error: 'Missing wallet' }, { status: 400 });

  const allowed = await consumeQuota(body.wallet);
  if (!allowed) return Response.json({ error: 'quota_exhausted', message: 'No free scans remaining. Upgrade to Pro.' }, { status: 402 });

  return Response.json({ ok: true });
}
