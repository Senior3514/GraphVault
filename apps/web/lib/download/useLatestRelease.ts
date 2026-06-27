'use client';

/**
 * Client hook that fetches the latest GitHub release for GraphVault and resolves
 * the per-OS installers.
 *
 * Privacy: this is the ONLY network call on the download page. It reads PUBLIC
 * release metadata from the GitHub API and sends NO user data — no auth header,
 * no cookies (default fetch credentials are omitted for a cross-origin GET),
 * no telemetry. The app's CSP already allows `connect-src 'self' https:`.
 *
 * The hook returns a discriminated state so the UI can render loading, a
 * friendly "no release yet" (404) message, a network-error fallback, or the
 * resolved installers — always keeping the instant web/PWA paths front-and-centre.
 */

import { useEffect, useState } from 'react';

import { pickAllDesktopAssets, type GithubRelease, type OsInstallers } from './releases';
import type { Os } from '../pwa/install';

/** The public GitHub API endpoint for the latest release of the GraphVault repo. */
export const LATEST_RELEASE_API =
  'https://api.github.com/repos/Senior3514/GraphVault/releases/latest';

/** The human-facing releases page, used as a fallback link. */
export const RELEASES_PAGE = 'https://github.com/Senior3514/GraphVault/releases';

export type ReleaseState =
  | { status: 'loading' }
  /** A published release was found and its assets resolved. */
  | {
      status: 'ready';
      version: string | null;
      htmlUrl: string;
      installers: Record<Exclude<Os, 'ios' | 'android' | 'unknown'>, OsInstallers>;
    }
  /** No release published yet (GitHub returns 404 when none exists). */
  | { status: 'no-release' }
  /** Network / rate-limit / unexpected error — point at the releases page. */
  | { status: 'error' };

export function useLatestRelease(): ReleaseState {
  const [state, setState] = useState<ReleaseState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();

    (async () => {
      try {
        const res = await fetch(LATEST_RELEASE_API, {
          signal: controller.signal,
          // No credentials: a public, read-only, cross-origin GET. Belt-and-
          // braces against ever attaching cookies/tokens.
          credentials: 'omit',
          headers: { Accept: 'application/vnd.github+json' },
        });

        // GitHub returns 404 when a repo has no published (non-draft) release.
        if (res.status === 404) {
          setState({ status: 'no-release' });
          return;
        }
        if (!res.ok) {
          setState({ status: 'error' });
          return;
        }

        const data = (await res.json()) as GithubRelease;
        const installers = pickAllDesktopAssets(data.assets);
        setState({
          status: 'ready',
          version: data.tag_name ?? data.name ?? null,
          htmlUrl: typeof data.html_url === 'string' ? data.html_url : RELEASES_PAGE,
          installers,
        });
      } catch (err) {
        // Aborted on unmount — not an error worth surfacing.
        if (err instanceof DOMException && err.name === 'AbortError') return;
        setState({ status: 'error' });
      }
    })();

    return () => controller.abort();
  }, []);

  return state;
}
