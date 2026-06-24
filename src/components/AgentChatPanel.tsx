'use client';

import { useEffect, useRef, useState } from 'react';

const PROMPTS = [
  'Send 0.001 USDC to vitalik.eth on base',
  'What does this dApp cost per agent call?',
  'Read my reputation score on Celo',
  'Lock 0.01 PegBTC and borrow $0.50 USDC',
] as const;

const KEY_STORAGE = 'hypermove.byok.anthropic';

interface ChatMessage {
  role: 'user' | 'agent';
  text: string;
}

export default function AgentChatPanel() {
  const [open, setOpen] = useState(false);
  const [byok, setByok] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const autoOpenRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const stored = window.localStorage.getItem(KEY_STORAGE);
    if (stored) setByok(stored);
    autoOpenRef.current = setTimeout(() => setOpen(true), 5_000);
    return () => {
      if (autoOpenRef.current) clearTimeout(autoOpenRef.current);
    };
  }, []);

  const persistKey = (v: string) => {
    setByok(v);
    try {
      if (v) window.localStorage.setItem(KEY_STORAGE, v);
      else window.localStorage.removeItem(KEY_STORAGE);
    } catch {
      /* localStorage unavailable */
    }
  };

  const sendPrompt = (text: string) => {
    setMessages((prev) => [...prev, { role: 'user', text }]);
    setInput('');
    // In real BYOK mode this fans out to the visitor's runtime; in mock mode echo a synthesized reply.
    setTimeout(() => {
      const reply = byok
        ? `[your agent] would invoke /api/mcp tools/call against ${text.split(' ')[0] ?? 'target'}…`
        : `[mock agent] would call /api/paid-endpoint and settle $0.01 USDC for: "${text}"`;
      setMessages((prev) => [...prev, { role: 'agent', text: reply }]);
    }, 700);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls="agent-chat-panel"
        className="fixed bottom-6 right-6 z-40 inline-flex items-center gap-2 rounded-full bg-primary-container px-5 py-3 text-body-sm font-semibold text-white shadow-neon-purple-strong transition-transform hover:scale-105"
      >
        <span aria-hidden="true">🤖</span>
        {open ? 'Hide live agent' : 'Try with my agent'}
      </button>

      <aside
        id="agent-chat-panel"
        hidden={!open}
        className="glass-panel fixed bottom-24 right-6 z-30 flex w-[min(360px,calc(100vw-3rem))] flex-col gap-3 rounded-lg p-4"
      >
        <header className="flex items-center justify-between">
          <h3 className="text-headline-md text-on-surface">Live agent</h3>
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="text-on-surface-variant hover:text-primary"
          >
            ✕
          </button>
        </header>

        <label className="flex flex-col gap-1 text-label-mono uppercase tracking-wider text-on-surface-variant">
          Bring your own key (stored in localStorage only)
          <input
            type="password"
            value={byok}
            onChange={(e) => persistKey(e.target.value)}
            placeholder="sk-ant-… (optional)"
            className="rounded-md border border-outline-variant/40 bg-surface-container-lowest px-3 py-2 font-mono text-body-sm text-on-surface focus:border-primary-container focus:outline-none"
          />
        </label>

        <ul className="flex max-h-48 flex-col gap-2 overflow-y-auto scrollbar-thin">
          {messages.length === 0 && (
            <li className="text-body-sm text-on-surface-variant">
              {byok ? 'Your runtime is wired. Pick a prompt below.' : 'Mock-mode replies. Paste a key to use your own runtime.'}
            </li>
          )}
          {messages.map((m, i) => (
            <li
              key={i}
              className={`rounded-md px-3 py-2 text-body-sm ${
                m.role === 'user'
                  ? 'bg-primary-container/20 text-on-surface'
                  : 'bg-surface-container-low text-on-surface-variant'
              }`}
            >
              {m.text}
            </li>
          ))}
        </ul>

        <div className="flex flex-wrap gap-2">
          {PROMPTS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => sendPrompt(p)}
              className="chip border border-outline-variant/40 bg-surface-container-high/40 text-on-surface-variant hover:border-primary-container/60 hover:text-primary"
            >
              {p}
            </button>
          ))}
        </div>

        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (input.trim()) sendPrompt(input.trim());
          }}
          className="flex gap-2"
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Or type a prompt…"
            className="flex-1 rounded-md border border-outline-variant/40 bg-surface-container-lowest px-3 py-2 text-body-sm text-on-surface focus:border-primary-container focus:outline-none"
          />
          <button type="submit" className="btn-primary px-4 py-2">Send</button>
        </form>
      </aside>
    </>
  );
}
