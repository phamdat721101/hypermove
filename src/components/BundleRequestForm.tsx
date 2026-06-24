'use client';

import { useState } from 'react';

type Status =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'ok'; message: string; id: number | null }
  | { kind: 'error'; message: string };

interface Props {
  bundleId: string;
}

export default function BundleRequestForm({ bundleId }: Props) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setStatus({ kind: 'sending' });
    try {
      const res = await fetch('/api/v1/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim(), bundle_id: bundleId }),
      });
      const json = await res.json();
      if (!res.ok) {
        setStatus({ kind: 'error', message: json.error ?? 'request_failed' });
        return;
      }
      setStatus({ kind: 'ok', message: json.message ?? 'Registered.', id: json.id ?? null });
    } catch (err) {
      setStatus({ kind: 'error', message: String(err) });
    }
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
      <button type="submit" disabled={status.kind === 'sending'} className="btn-primary">
        {status.kind === 'sending' ? 'Sending…' : 'Request bundle →'}
      </button>
      {status.kind === 'error' && (
        <span role="alert" className="basis-full text-label-mono text-error">
          {status.message}
        </span>
      )}
    </form>
  );
}
