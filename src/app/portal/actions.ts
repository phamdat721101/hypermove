'use server';

/**
 * src/app/portal/actions.ts
 * --------------------------
 * Server Action for bundle requests. Runs on the server (no browser exposure
 * of DATABASE_URL); called directly from BundleRequestForm via `action={…}`.
 *
 * SOLID:
 *  - Single Responsibility: this file owns the registry-write input contract.
 *    db.ts owns the connection pool + DDL. Form owns the UI.
 *  - Validation happens here, NOT in the form, so a hand-crafted POST cannot
 *    bypass the email/bundle_id checks.
 */

import { headers } from 'next/headers';
import { insertRegistryRequest, type ErrorHint } from '@/lib/db';
import { readBundles } from '@/lib/bundles';

export interface RegisterResult {
  ok: boolean;
  id?: number | null;
  persisted?: boolean;
  message?: string;
  error?: string;
  hint?: ErrorHint;
}

const EMAIL_RX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export async function registerBundleRequest(input: {
  email: string;
  bundleId: string;
}): Promise<RegisterResult> {
  const email = String(input.email ?? '').trim().toLowerCase();
  const bundleId = String(input.bundleId ?? '').trim();

  if (!EMAIL_RX.test(email))       return { ok: false, error: 'invalid_email' };
  if (email.length > 254)          return { ok: false, error: 'email_too_long' };

  const catalog = await readBundles();
  if (!catalog.bundles.some((b) => b.id === bundleId)) {
    return { ok: false, error: 'unknown_bundle' };
  }

  const h = safeHeaders();
  const ip = h?.get('x-forwarded-for')?.split(',')[0]?.trim() ?? h?.get('x-real-ip') ?? undefined;
  const userAgent = h?.get('user-agent') ?? undefined;

  const result = await insertRegistryRequest({ email, bundleId, ip, userAgent });
  if (!result.ok) return { ok: false, error: 'persist_failed', hint: result.hint };

  return {
    ok: true,
    id: result.id ?? null,
    persisted: !result.noopReason,
    message: result.noopReason
      ? 'Registered (set DATABASE_URL to persist).'
      : 'Registered. We will email the bundle within minutes.',
  };
}

/** headers() throws outside of a request scope (e.g. vitest). Treat that as no metadata. */
function safeHeaders(): ReturnType<typeof headers> | null {
  try {
    return headers();
  } catch {
    return null;
  }
}
