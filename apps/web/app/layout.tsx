import type { Metadata } from 'next';
import './globals.css';
import { Sidebar } from '../components/Sidebar';
import { VaultProvider } from '../lib/vault/VaultProvider';

export const metadata: Metadata = {
  title: 'GraphVault',
  description: 'Local-first notes. Self-hosted sync. A graph you can think in.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <VaultProvider>
          <div className="flex h-screen w-screen overflow-hidden">
            <Sidebar />
            <div className="flex min-w-0 flex-1 flex-col">{children}</div>
          </div>
        </VaultProvider>
      </body>
    </html>
  );
}
