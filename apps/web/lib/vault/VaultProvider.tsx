'use client';

/**
 * App-wide vault context. A single {@link useVault} instance is created at the
 * provider and shared by every page/component via {@link useVaultContext}, so
 * navigating between `/vault`, `/sync-status`, and `/settings` keeps one
 * consistent in-memory vault and search index.
 */

import { createContext, useContext, type ReactNode } from 'react';

import { useVault, type UseVault } from './useVault';

const VaultContext = createContext<UseVault | null>(null);

export function VaultProvider({ children }: { children: ReactNode }) {
  const vault = useVault();
  return <VaultContext.Provider value={vault}>{children}</VaultContext.Provider>;
}

export function useVaultContext(): UseVault {
  const ctx = useContext(VaultContext);
  if (!ctx) {
    throw new Error('useVaultContext must be used within a <VaultProvider>.');
  }
  return ctx;
}
