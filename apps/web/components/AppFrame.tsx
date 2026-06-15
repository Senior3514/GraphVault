'use client';

/**
 * Chrome wrapper. The landing page (`/`) is rendered full-bleed with no app
 * chrome; every other route gets the vault provider + sidebar shell. Keeping
 * this decision in one client component lets the root layout stay a server
 * component (so static metadata still works) without moving any app routes.
 *
 * The shell also owns:
 *  - the left sidebar's collapsed state, persisted to localStorage and
 *    toggleable with Cmd/Ctrl+B (or the in-rail button), and
 *  - the global {@link CommandPalette} (Cmd/Ctrl+K), mounted once so it works
 *    on every non-landing route.
 */

import { usePathname } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';

import { CommandPalette } from './CommandPalette';
import { Sidebar } from './Sidebar';
import { VaultProvider } from '../lib/vault/VaultProvider';

const COLLAPSE_KEY = 'graphvault.sidebar.collapsed';

export function AppFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // The marketing landing page stands alone.
  if (pathname === '/') {
    return <>{children}</>;
  }

  return (
    <VaultProvider>
      <AppShell>{children}</AppShell>
    </VaultProvider>
  );
}

function AppShell({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  // Restore the persisted collapse preference after mount (avoids SSR mismatch).
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      /* storage unavailable — fall back to expanded */
    }
    setHydrated(true);
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? '1' : '0');
      } catch {
        /* ignore persistence failures */
      }
      return next;
    });
  }, []);

  // Cmd/Ctrl+B toggles the sidebar, matching common editor conventions.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'b') {
        e.preventDefault();
        toggleCollapsed();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleCollapsed]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-neutral-950">
      <Sidebar collapsed={hydrated && collapsed} onToggle={toggleCollapsed} />
      <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      <CommandPalette />
    </div>
  );
}
