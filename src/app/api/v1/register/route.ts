import type { NextRequest } from 'next/server';
import { insertRegistryRequest } from '@/lib/db';
import { readBundles } from '@/lib/bundles';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

interface RegisterBody {
  email?: string;
  bundle_id?: string;
}

export async function POST(req: NextRequest) {
  let body: RegisterBody;
  try {
    body = (await req.json()) as RegisterBody;
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const email = String(body.email ?? '').trim().toLowerCase();
  const bundleId = String(body.bundle_id ?? '').trim();

  if (!EMAIL_RX.test(email)) {
    return Response.json({ error: 'invalid_email' }, { status: 400 });
  }
  if (email.length > 254) {
    return Response.json({ error: 'email_too_long' }, { status: 400 });
  }

  // Validate bundle_id against the catalog so we never persist a junk id.
  const catalog = await readBundles();
  const known = catalog.bundles.some((b) => b.id === bundleId);
  if (!known) {
    return Response.json({ error: 'unknown_bundle' }, { status: 400 });
  }

  const ip =
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    req.headers.get('x-real-ip') ??
    undefined;
  const userAgent = req.headers.get('user-agent') ?? undefined;

  const result = await insertRegistryRequest({ email, bundleId, ip, userAgent });
  if (!result.ok) {
    return Response.json({ error: 'persist_failed', detail: result.error }, { status: 500 });
  }

  return Response.json({
    ok: true,
    id: result.id ?? null,
    persisted: !result.noopReason,
    bundle_id: bundleId,
    message: result.noopReason
      ? 'Registered (in-memory; set DATABASE_URL to persist).'
      : 'Registered. We will email the bundle within minutes.',
  });
}
