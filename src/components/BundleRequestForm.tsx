'use client';

import { useState, useTransition } from 'react';
import { registerBundleRequest } from '@/app/portal/actions';

interface Props {
  bundleId: string;
}

export default function BundleRequestForm({ bundleId }: Props) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [message, setMessage] = useState('');
  const [pending, startTransition] = useTransition();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    startTransition(async () => {
      const res = await registerBundleRequest({ email: email.trim(), bundleId });
      if (!res.ok) { setStatus('error'); setMessage(res.error || 'Failed'); return; }
      setStatus('ok'); setMessage(res.message || 'Registered!');
    });
  };

  if (status === 'ok') {
    return <p className="rounded-lg border border-green-500/30 bg-green-500/5 px-3 py-2 text-sm text-green-400">✓ {message}</p>;
  }

  return (
    <form onSubmit={submit} className="flex gap-2 mt-2">
      <input
        type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        className="flex-1 rounded-lg border border-gray-700 bg-gray-950 px-3 py-2 text-sm font-mono text-white placeholder:text-gray-600 focus:border-indigo-500 focus:outline-none"
      />
      <button type="submit" disabled={pending}
        className="shrink-0 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50 transition-colors">
        {pending ? 'Sending…' : 'Request bundle →'}
      </button>
      {status === 'error' && <span className="text-xs text-red-400 self-center">{message}</span>}
    </form>
  );
}
