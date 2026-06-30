'use client';

import { useUpgradeModal } from '@/lib/upgrade-modal-context';
import { useWalletModal } from '@/lib/wallet-modal-context';
import { useAccount } from 'wagmi';

export default function UpgradeButton() {
  const { open: openUpgrade } = useUpgradeModal();
  const { open: openWallet } = useWalletModal();
  const { isConnected } = useAccount();

  return (
    <button
      onClick={() => isConnected ? openUpgrade() : openWallet()}
      className="w-full rounded-lg bg-indigo-600 hover:bg-indigo-500 px-4 py-2.5 text-center text-sm font-medium text-white transition-colors"
    >
      Upgrade with BTC
    </button>
  );
}
