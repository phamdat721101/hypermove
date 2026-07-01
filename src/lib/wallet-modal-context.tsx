'use client';

import { createContext, useContext, useState, useCallback } from 'react';

interface WalletModalContextType {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

const WalletModalContext = createContext<WalletModalContextType>({
  isOpen: false,
  open: () => {},
  close: () => {},
});

export function WalletModalProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  return (
    <WalletModalContext.Provider value={{ isOpen, open, close }}>
      {children}
    </WalletModalContext.Provider>
  );
}

export function useWalletModal() {
  return useContext(WalletModalContext);
}
