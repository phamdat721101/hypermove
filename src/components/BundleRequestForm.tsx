'use client';

import { useState, useTransition } from 'react';
import { registerBundleRequest } from '@/app/portal/actions';

type Status =
  | { kind: 'idle' }
  | { kind: 'ok'; message: string; id: number | null }
  | { kind: 'error'; message: string };

interface Props {
  bundleId: string;
}

const HINT_MESSAGES: Record<string, string> = {
  invalid_email:        'Email looks malformed — double-check the address.',
  email_too_long:       'Email is too long (max 254 chars).',
  unknown_bundle:       'That bundle is no longer in the catalog. Please refresh.',
  persist_failed:       'Couldn\u2019t save your request — please try again.',
  // Persistence hints
  dns_unreachable:      'Database host not reachable. (admin: check DATABASE_URL host)',
  connection_refused:   'Database refused connection. (admin: check port + firewall)',
  connection_timeout:   'Database timed out. (admin: check network + pool size)',
  auth_failed:          'Database auth failed. (admin: check password)',
  tenant_not_found:     'Wrong Supabase pooler shard or region. (admin: verify pooler URL)',
  tls_failed:           'TLS handshake failed. (admin: check ssl settings)',
  schema_error:         'Schema mismatch. (admin: re-run migrations)',
};

function messageFor(error: string | undefined, hint: string | undefined): string {
  if (hint && HINT_MESSAGES[hint]) return HINT_MESSAGES[hint];
  if (error && HINT_MESSAGES[error]) return HINT_MESSAGES[error];
  return error ?? 'Request failed.';
}

export default function BundleRequestForm({ bundleId }: Props) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [pending, startTransition] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    startTransition(async () => {
      const res = await registerBundleRequest({ email: email.trim(), bundleId });
      if (!res.ok) {
        setStatus({ kind: 'error', message: messageFor(res.error, res.hint) });
        return;
      }
      setStatus({ kind: 'ok', message: res.message ?? 'Registered.', id: res.id ?? null });
    });
  };

  if (status.kind === 'ok') {
    return (
      <p
        role="status"
        className="rounded-md border border-tertiary/40 bg-tertiary-container/15 px-3 py-2 text-body-sm text-tertiary"
      >
        ✓ {status.message}
        {status.id != null && (
          <span className="ml-2 font-mono text-label-mono text-on-surface-variant">
            (req #{status.id})
          </span>
        )}
      </p>
    );
  }

  return (
    <form onSubmit={submit} className="mt-1 flex flex-col gap-2 sm:flex-row">
      <input
        type="email"
        required
        autoComplete="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        aria-label="Email"
        className="flex-1 rounded-md border border-outline-variant/40 bg-surface-container-lowest px-3 py-2 font-mono text-body-sm text-on-surface focus:border-primary-container focus:outline-none"
      />
      <button type="submit" disabled={pending} className="btn-primary">
        {pending ? 'Sending…' : 'Request bundle →'}
      </button>
      {status.kind === 'error' && (
        <span role="alert" className="basis-full text-label-mono text-error">
          {status.message}
        </span>
      )}
    </form>
  );
}
