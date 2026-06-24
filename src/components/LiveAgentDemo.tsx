'use client';

import { useEffect, useRef, useState } from 'react';
import type { AgentFrame } from '@/lib/agent';
import { PaymentReceiptToast, RevenueCounter } from './RevenueAndReceipt';

const RECEIPT_HASH = '0xfa6c1c2e5d0a87f7b9a9eaf6c0f2a8a4cf18e3e9d3c7a52a9b4d3f9c1e4f8b21e';

export default function LiveAgentDemo() {
  const [frames, setFrames] = useState<AgentFrame[]>([]);
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(false);
  const [optimisticDelta, setOptimisticDelta] = useState(0);
  const [receiptVisible, setReceiptVisible] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const eventSrcRef = useRef<EventSource | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReducedMotion(mq.matches);
    const handler = (e: MediaQueryListEvent) => setReducedMotion(e.matches);
    mq.addEventListener?.('change', handler);
    return () => mq.removeEventListener?.('change', handler);
  }, []);

  useEffect(() => {
    if (!running) return;
    const src = new EventSource('/api/agent');
    eventSrcRef.current = src;

    src.addEventListener('frame', (ev: MessageEvent) => {
      try {
        const frame = JSON.parse(ev.data) as AgentFrame;
        setFrames((prev) => [...prev, frame]);
        if (frame.kind === 'revenue.tick') {
          setOptimisticDelta(0.01);
          // commit on server (best-effort).
          fetch('/api/revenue', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ amountMicroUsdc: 10_000 }),
          }).catch(() => {});
        }
        if (frame.kind === 'paywall.200') {
          setReceiptVisible(true);
        }
      } catch {
        /* ignore malformed */
      }
    });

    src.addEventListener('end', () => {
      setDone(true);
      setRunning(false);
      src.close();
    });
    src.addEventListener('error', () => {
      setRunning(false);
      src.close();
    });

    return () => {
      src.close();
      eventSrcRef.current = null;
    };
  }, [running]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [frames.length]);

  const start = () => {
    setFrames([]);
    setDone(false);
    setReceiptVisible(false);
    setOptimisticDelta(0);
    setRunning(true);
  };

  if (reducedMotion) return <StaticFallback />;

  return (
    <div className="relative">
      <div className="terminal-frame">
        <header className="flex items-center gap-2 border-b border-outline-variant/30 bg-surface-container-lowest/80 px-4 py-3">
          <span className="h-3 w-3 rounded-full bg-error/70" aria-hidden="true" />
          <span className="h-3 w-3 rounded-full bg-secondary/70" aria-hidden="true" />
          <span className="h-3 w-3 rounded-full bg-tertiary/70" aria-hidden="true" />
          <span className="ml-3 text-label-mono uppercase tracking-wider text-on-surface-variant">
            agent.sh · live demo
          </span>
          <span className="ml-auto chip border border-tertiary/40 bg-tertiary-container/15 text-tertiary">
            {done ? '✓ paid' : running ? 'streaming' : 'ready'}
          </span>
        </header>

        <div
          ref={scrollRef}
          aria-live="polite"
          className="h-80 overflow-y-auto scrollbar-thin bg-black/70 px-4 py-4 font-mono text-code-block"
        >
          <p className="text-on-surface-variant">
            <span className="text-tertiary">~</span> <span className="text-secondary">$</span>{' '}
            agent run --target hypermove.dev
          </p>
          <ul className="mt-3 flex flex-col gap-2">
            {frames.map((f, i) => (
              <li key={i} className="animate-fade-in">
                <p className="text-on-surface">
                  <span className="text-secondary">›</span> {f.label}
                </p>
                {f.detail && <p className="ml-4 text-on-surface-variant/80">{f.detail}</p>}
              </li>
            ))}
            {running && frames.length < 9 && (
              <li className="text-on-surface-variant animate-pulse-cyan">…</li>
            )}
          </ul>
        </div>

        <footer className="flex items-center justify-between border-t border-outline-variant/30 bg-surface-container-lowest/60 px-4 py-3">
          <RevenueCounter optimisticDelta={optimisticDelta} />
          <button
            type="button"
            onClick={start}
            disabled={running}
            className="btn-ghost text-body-sm"
          >
            {done ? '↻ Replay' : running ? 'Running…' : '▶ Run agent'}
          </button>
        </footer>
      </div>

      {receiptVisible && (
        <div className="pointer-events-none absolute -bottom-4 right-4 z-10">
          <PaymentReceiptToast
            txHash={RECEIPT_HASH}
            chainId={process.env.NEXT_PUBLIC_PAYMENT_CHAIN ?? 'base-sepolia'}
            onDismiss={() => setReceiptVisible(false)}
          />
        </div>
      )}
    </div>
  );
}

function StaticFallback() {
  return (
    <div
      role="img"
      aria-label="agent paying the page"
      className="terminal-frame flex h-80 flex-col gap-3 p-6 font-mono text-code-block text-on-surface-variant"
    >
      <p><span className="text-secondary">›</span> GET /.well-known/webmcp.json → 200</p>
      <p><span className="text-secondary">›</span> POST /api/mcp tools/call payment.x402</p>
      <p>← HTTP 402 · WWW-Authenticate: x402-USDC</p>
      <p>OWS vault · policy.check + sign EIP-3009 ✓</p>
      <p>tx 0xfa6c…b21e settled in 1.2s</p>
      <p className="text-tertiary">→ HTTP 200 · $0.01 USDC paid · revenue +$0.01</p>
      <p className="mt-auto text-label-mono uppercase tracking-wider text-on-surface-variant">
        Reduced-motion: animated cinematic disabled.
      </p>
    </div>
  );
}
