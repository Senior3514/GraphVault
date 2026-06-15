'use client';

/**
 * App-wide vault context. A single {@link useVault} instance is created at the
 * provider and shared by every page/component via {@link useVaultContext}, so
 * navigating between `/vault`, `/sync-status`, and `/settings` keeps one
 * consistent in-memory vault and search index.
 *
 * ## Passphrase gate
 *
 * When the vault is encrypted and the passphrase has not yet been supplied for
 * this session, the provider renders a full-screen {@link PassphraseGate}
 * instead of the app children. The gate calls `vault.unlock(passphrase)`:
 *  - On success: `needsPassphrase` becomes `false`, the gate unmounts, and the
 *    app renders normally.
 *  - On wrong passphrase: the gate shows an error and lets the user retry. The
 *    encrypted blob is NEVER modified on a failed attempt.
 */

import { createContext, useContext, type ReactNode } from 'react';

import { PassphraseGate } from '../../components/PassphraseGate';
import { useVault, type UseVault } from './useVault';

const VaultContext = createContext<UseVault | null>(null);

export function VaultProvider({ children }: { children: ReactNode }) {
  const vault = useVault();

  // If the vault is encrypted and we don't have the passphrase yet, block
  // rendering the app and show the passphrase gate instead.
  if (vault.needsPassphrase) {
    return (
      <VaultContext.Provider value={vault}>
        <PassphraseGate onUnlock={vault.unlock} />
      </VaultContext.Provider>
    );
  }

  return <VaultContext.Provider value={vault}>{children}</VaultContext.Provider>;
}

export function useVaultContext(): UseVault {
  const ctx = useContext(VaultContext);
  if (!ctx) {
    throw new Error('useVaultContext must be used within a <VaultProvider>.');
  }
  return ctx;
}
