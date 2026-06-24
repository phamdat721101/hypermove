import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Process-local revenue counter. Replaced with Postgres in Sprint 3. */
let totalMicroUsdc = 0;
let calls = 0;

export async function GET() {
  return Response.json({ totalMicroUsdc, totalUsdc: totalMicroUsdc / 1_000_000, calls });
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const inc = Number((body as { amountMicroUsdc?: number }).amountMicroUsdc ?? 10_000);
  if (!Number.isFinite(inc) || inc <= 0 || inc > 1_000_000) {
    return Response.json({ error: 'invalid_amount' }, { status: 400 });
  }
  totalMicroUsdc += inc;
  calls += 1;
  return Response.json({ totalMicroUsdc, totalUsdc: totalMicroUsdc / 1_000_000, calls });
}
