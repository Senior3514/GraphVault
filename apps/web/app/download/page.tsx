import type { Metadata } from 'next';

import { DownloadExperience } from '../../components/download/DownloadExperience';

/**
 * `/download` — the public, end-user download page.
 *
 * Rendered full-bleed (no app chrome) like the landing page; AppFrame excludes
 * this route from the sidebar shell. The interactive parts (OS auto-detect and
 * the runtime GitHub-release fetch) live in the `'use client'`
 * {@link DownloadExperience} component, so this route file stays a server
 * component and can export static metadata.
 */
export const metadata: Metadata = {
  title: 'Download GraphVault — native apps + instant web/PWA',
  description:
    'Download the native GraphVault desktop app for Windows, macOS, or Linux, or use it instantly in your browser. Open-source, works offline, no account.',
};

export default function DownloadPage() {
  return <DownloadExperience />;
}
