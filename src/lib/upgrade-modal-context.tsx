'use client';

import { createContext, useContext, useState, useCallback } from 'react';

interface UpgradeModalContextType {
  isOpen: boolean;
  open: () => void;
  close: () => void;
}

const UpgradeModalContext = createContext<UpgradeModalContextType>({
  isOpen: false,
  open: () => {},
  close: () => {},
});

export function UpgradeModalProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);
  return (
    <UpgradeModalContext.Provider value={{ isOpen, open, close }}>
      {children}
    </UpgradeModalContext.Provider>
  );
}

export function useUpgradeModal() {
  return useContext(UpgradeModalContext);
}
