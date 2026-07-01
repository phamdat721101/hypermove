'use client';

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAccount, useConnect, useDisconnect } from 'wagmi';
import { Wallet, LogOut, X } from 'lucide-react';
import { useWalletModal } from '@/lib/wallet-modal-context';

/** Button that shows in Navbar */
export function WalletConnectButton() {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  const { open } = useWalletModal();
  const [mounted, setMounted] = useState(false);

  useEffect(() => { setMounted(true); }, []);

  if (!mounted) return <div className="w-[120px] h-8" />; // placeholder to avoid layout shift

  if (isConnected && address) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-xs font-mono text-gray-400">
          {address.slice(0, 6)}...{address.slice(-4)}
        </span>
        <button onClick={() => disconnect()} className="flex items-center gap-1 rounded-lg border border-gray-700 px-2 py-1 text-xs text-gray-400 hover:text-white transition-colors">
          <LogOut className="h-3 w-3" />
        </button>
      </div>
    );
  }

  return (
    <button
      onClick={open}
      className="flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition-colors"
    >
      <Wallet className="h-3.5 w-3.5" />
      <span>Connect Wallet</span>
    </button>
  );
}

/** Modal rendered at body level via portal */
export function WalletModal() {
  const { isOpen, close } = useWalletModal();
  const { connect, connectors } = useConnect();

  if (!isOpen || typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={close} />
      <div className="relative z-10 w-full max-w-sm rounded-xl border border-gray-800 bg-gray-950 p-6 shadow-2xl">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-display text-lg font-semibold text-white">Connect Wallet</h3>
          <button onClick={close} className="text-gray-500 hover:text-white transition-colors">
            <X className="h-5 w-5" />
          </button>
        </div>
        <div className="space-y-2 max-h-[60vh] overflow-y-auto">
          {connectors.map((connector) => (
            <button
              key={connector.uid}
              onClick={() => { connect({ connector }); close(); }}
              className="w-full flex items-center gap-3 rounded-lg border border-gray-800 bg-gray-900/50 hover:bg-gray-800 px-4 py-3 transition-colors"
            >
              {connector.icon && (
                <img src={connector.icon} alt="" className="h-6 w-6 rounded" />
              )}
              <span className="text-sm font-medium text-white">{connector.name}</span>
            </button>
          ))}
          {connectors.length === 0 && (
            <p className="text-sm text-gray-500 text-center py-4">
              No wallet detected. Install MetaMask or another EVM wallet.
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
