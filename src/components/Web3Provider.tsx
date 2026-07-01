'use client';

import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { config } from '@/lib/wagmi';
import { WalletModalProvider } from '@/lib/wallet-modal-context';
import { UpgradeModalProvider, useUpgradeModal } from '@/lib/upgrade-modal-context';
import { WalletModal } from '@/components/WalletConnect';
import UpgradeModal from '@/components/UpgradeModal';

function UpgradeModalGlobal() {
  const { isOpen, close } = useUpgradeModal();
  return <UpgradeModal isOpen={isOpen} onClose={close} onSuccess={close} />;
}
import { useState } from 'react';

export default function Web3Provider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <WalletModalProvider>
          <UpgradeModalProvider>
            {children}
            <WalletModal />
            <UpgradeModalGlobal />
          </UpgradeModalProvider>
        </WalletModalProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
