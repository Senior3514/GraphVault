'use client';

/**
 * Chrome wrapper. The landing page (`/`) is rendered full-bleed with no app
 * chrome; every other route gets the vault provider + sidebar shell. Keeping
 * this decision in one client component lets the root layout stay a server
 * component (so static metadata still works) without moving any app routes.
 */

import { usePathname } from 'next/navigation';
import { Sidebar } from './Sidebar';
import { VaultProvider } from '../lib/vault/VaultProvider';

export function AppFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // The marketing landing page stands alone.
  if (pathname === '/') {
    return <>{children}</>;
  }

  return (
    <VaultProvider>
      <div className="flex h-screen w-screen overflow-hidden">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </VaultProvider>
  );
}
