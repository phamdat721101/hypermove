'use client';

import { useEffect, useState } from 'react';
import ChainBadge from './ChainBadge';

interface RevenueState {
  totalUsdc: number;
  calls: number;
}

export function RevenueCounter({ optimisticDelta = 0 }: { optimisticDelta?: number }) {
  const [state, setState] = useState<RevenueState>({ totalUsdc: 0, calls: 0 });

  useEffect(() => {
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await fetch('/api/revenue', { cache: 'no-store' });
        const json = (await res.json()) as RevenueState;
        if (!cancelled) setState(json);
      } catch {
        /* ignore — counter is best-effort */
      }
    };
    tick();
    const id = setInterval(tick, 5_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const display = state.totalUsdc + optimisticDelta;

  return (
    <div className="flex items-baseline gap-2 font-mono">
      <span className="text-label-mono uppercase tracking-wider text-on-surface-variant">
        Revenue ticker
      </span>
      <span className="text-headline-md text-tertiary">${display.toFixed(2)}</span>
      <span className="text-label-mono text-on-surface-variant">· {state.calls} calls</span>
    </div>
  );
}

interface ReceiptProps {
  txHash: string;
  chainId?: string;
  onDismiss?: () => void;
}

export function PaymentReceiptToast({ txHash, chainId = 'base-sepolia', onDismiss }: ReceiptProps) {
  useEffect(() => {
    if (!onDismiss) return;
    const id = setTimeout(onDismiss, 4_000);
    return () => clearTimeout(id);
  }, [onDismiss]);

  return (
    <div
      role="status"
      className="glass-panel pointer-events-auto flex items-center gap-3 rounded-lg border-tertiary-container/40 px-4 py-3 shadow-neon-purple animate-slide-up"
    >
      <span aria-hidden="true" className="grid h-8 w-8 place-items-center rounded-full bg-tertiary-container/30 text-tertiary">
        ✓
      </span>
      <div className="flex flex-col leading-tight">
        <span className="text-label-mono uppercase tracking-wider text-on-surface-variant">
          Payment settled · $0.01 USDC
        </span>
        <span className="font-mono text-body-sm text-on-surface">
          {txHash.slice(0, 10)}…{txHash.slice(-6)}
        </span>
      </div>
      <ChainBadge chainId={chainId} size="sm" />
    </div>
  );
}
