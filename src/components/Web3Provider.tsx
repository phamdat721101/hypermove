'use client';

import { WagmiProvider } from 'wagmi';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { config } from '@/lib/wagmi';
import { WalletModalProvider } from '@/lib/wallet-modal-context';
import { WalletModal } from '@/components/WalletConnect';
import { useState } from 'react';

export default function Web3Provider({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  return (
    <WagmiProvider config={config}>
      <QueryClientProvider client={queryClient}>
        <WalletModalProvider>
          {children}
          <WalletModal />
        </WalletModalProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
