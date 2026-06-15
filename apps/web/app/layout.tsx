import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'GraphVault',
  description: 'Local-first notes. Self-hosted sync. A graph you can think in.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
