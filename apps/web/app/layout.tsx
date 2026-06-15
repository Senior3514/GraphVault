import type { Metadata } from 'next';
import './globals.css';
import { AppFrame } from '../components/AppFrame';

export const metadata: Metadata = {
  title: 'GraphVault — open and write. No folders, no file access.',
  description:
    'A dynamic, cloud-ready notes vault with a graph you can think in. Open the app and start writing — no folders to pick, no file permissions, no setup.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppFrame>{children}</AppFrame>
      </body>
    </html>
  );
}
