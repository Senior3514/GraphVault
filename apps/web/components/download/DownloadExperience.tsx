'use client';

/**
 * DownloadExperience — the Obsidian-style "get the app" surface.
 *
 * An end user (not a developer) lands here and either:
 *  - one-click downloads the native installer for their detected OS (the other
 *    OSes are offered below as secondary options), or
 *  - instantly uses GraphVault with zero install via the browser (`/vault`) or
 *    installs it as a PWA.
 *
 * The native installer is resolved AT RUNTIME from the latest GitHub release
 * (the only network call here — public release metadata, no user data, no
 * telemetry; see {@link useLatestRelease}). Filenames are version-specific, so
 * nothing is hardcoded; the tolerant {@link pickAssets} matcher maps assets to
 * OSes by extension + platform token.
 *
 * Graceful states:
 *  - loading        → skeleton button + the instant paths already usable.
 *  - no-release/404 → "Native installers are on the way" + instant paths.
 *  - network error  → link to the GitHub releases page + instant paths.
 *
 * Mobile (iOS/Android) users have no native binary, so they primarily see the
 * web/PWA path. Desktop users see native download + PWA.
 *
 * Accessibility: semantic headings, labelled links/buttons, ≥44px tap targets,
 * focus-visible rings, motion gated behind `motion-safe:`. Dark/light via the
 * neutral token ramp.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { InstallButton } from '../InstallButton';
import {
  detectIosFromNavigator,
  detectOs,
  isMobileOs,
  osLabel,
  type Os,
} from '../../lib/pwa/install';
import {
  RELEASES_PAGE,
  useLatestRelease,
  type ReleaseState,
} from '../../lib/download/useLatestRelease';
import { DESKTOP_OSES, type InstallerLink, type OsInstallers } from '../../lib/download/releases';

export function DownloadExperience() {
  const release = useLatestRelease();
  const os = useDetectedOs();
  const mobile = os !== null && isMobileOs(os);

  return (
    <main className="relative min-h-screen overflow-x-hidden bg-neutral-950 text-neutral-100">
      {/* Ambient backdrop — pure CSS, no images, matches the landing page. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(70rem_50rem_at_50%_-15%,theme(colors.sky.500/18),transparent)]"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-[0.045] [background-image:radial-gradient(theme(colors.neutral.400)_1px,transparent_1px)] [background-size:28px_28px]"
      />

      <div className="relative">
        <SiteNav />

        <section className="mx-auto max-w-3xl px-4 pb-20 pt-12 text-center sm:px-6 sm:pt-20">
          <div className="motion-safe:animate-slide-up">
            <p className="text-xs font-semibold uppercase tracking-widest text-sky-400">
              Download GraphVault
            </p>
            <h1 className="mt-3 text-balance text-4xl font-bold leading-[1.1] tracking-tight sm:text-5xl">
              Get GraphVault on {os === null ? 'every device' : osLabel(os)}.
            </h1>
            <p className="mx-auto mt-5 max-w-xl text-pretty text-lg leading-relaxed text-neutral-400">
              {mobile
                ? 'On mobile, GraphVault runs right in your browser — add it to your home screen for an app-like experience. No store, no install.'
                : 'Install the native desktop app, or skip the download entirely and use GraphVault in your browser. Both keep your notes on your device.'}
            </p>
          </div>

          {/* Native download block (desktop only). Mobile users skip straight
              to the instant paths, which are the primary affordance for them. */}
          {!mobile && (
            <div className="mt-10 motion-safe:animate-slide-up-delay">
              <NativeDownload release={release} os={os} />
            </div>
          )}

          {/* Instant, zero-install paths — always prominent and working today. */}
          <InstantPaths emphasised={mobile} />

          {/* Trust line. */}
          <p className="mt-10 text-sm text-neutral-500">
            Open-source · Works offline · No account · Your files stay yours.
          </p>

          {/* Other OSes (desktop only) — secondary list. */}
          {!mobile && release.status === 'ready' && (
            <OtherPlatforms release={release} detected={os} />
          )}
        </section>
      </div>
    </main>
  );
}

// ---------------------------------------------------------------------------
// Native download — primary button for the detected OS + graceful states
// ---------------------------------------------------------------------------

function NativeDownload({ release, os }: { release: ReleaseState; os: Os | null }) {
  // Only desktop OSes reach here; unknown OS gets a neutral fallback.
  const targetOs: Exclude<Os, 'ios' | 'android'> =
    os && os !== 'ios' && os !== 'android' ? os : 'unknown';

  if (release.status === 'loading') {
    return (
      <div
        className="mx-auto h-[52px] w-64 animate-pulse rounded-xl border border-neutral-800 bg-neutral-900/60"
        role="status"
        aria-label="Looking for the latest release"
      />
    );
  }

  if (release.status === 'no-release') {
    return <ComingSoon />;
  }

  if (release.status === 'error') {
    return (
      <div className="mx-auto max-w-md rounded-xl border border-neutral-800 bg-neutral-900/60 p-5 text-sm text-neutral-400">
        <p>We couldn&apos;t reach GitHub to find the latest installer.</p>
        <a
          href={RELEASES_PAGE}
          target="_blank"
          rel="noreferrer"
          className="mt-3 inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-2 font-medium text-neutral-100 transition-colors hover:border-neutral-600 hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          Browse all releases on GitHub
          <ExternalIcon className="h-4 w-4" />
        </a>
      </div>
    );
  }

  // status === 'ready'
  const forUnknown = targetOs === 'unknown';
  const installers = forUnknown ? null : release.installers[targetOs];
  const primary = installers?.primary ?? null;

  if (forUnknown || !primary) {
    // We resolved a release but can't match this OS (or couldn't detect it).
    // Send the user to the full list / releases page rather than a dead button.
    return (
      <div className="mx-auto max-w-md rounded-xl border border-neutral-800 bg-neutral-900/60 p-5 text-sm text-neutral-400">
        <p>
          {forUnknown
            ? "We couldn't detect your operating system."
            : `No ${osLabel(targetOs)} installer is in the latest release yet.`}{' '}
          Pick your platform below, or use GraphVault in your browser right now.
        </p>
        {release.installers && (
          <div className="mt-4 flex flex-col items-stretch gap-2">
            {DESKTOP_OSES.map((o) =>
              release.installers[o].primary ? (
                <PrimaryDownloadLink
                  key={o}
                  link={release.installers[o].primary as InstallerLink}
                  os={o}
                  size="md"
                />
              ) : null,
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <PrimaryDownloadLink link={primary} os={targetOs} size="lg" />
      {release.version && (
        <p className="mt-3 text-xs text-neutral-500">
          Latest release {release.version} · {primary.filename}
        </p>
      )}
      {installers && installers.alternates.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center justify-center gap-x-4 gap-y-1 text-xs text-neutral-500">
          <span className="text-neutral-600">Other formats:</span>
          {installers.alternates.map((alt) => (
            <a
              key={alt.filename}
              href={alt.url}
              className="underline decoration-neutral-700 underline-offset-2 transition-colors hover:text-neutral-200 hover:decoration-neutral-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
            >
              {alt.format}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function ComingSoon() {
  return (
    <div className="mx-auto max-w-md rounded-xl border border-sky-500/20 bg-sky-500/[0.06] p-5 text-sm text-neutral-300">
      <p className="font-medium text-neutral-100">Native installers are on the way.</p>
      <p className="mt-1.5 text-neutral-400">
        Desktop builds for Windows, macOS, and Linux are coming soon. In the meantime, GraphVault
        works fully in your browser — no install needed.
      </p>
    </div>
  );
}

function PrimaryDownloadLink({
  link,
  os,
  size,
}: {
  link: InstallerLink;
  os: Exclude<Os, 'ios' | 'android' | 'unknown'>;
  size: 'lg' | 'md';
}) {
  const lg = size === 'lg';
  return (
    <a
      href={link.url}
      // `download` is advisory for cross-origin; GitHub serves the binary with
      // Content-Disposition, so the browser downloads it either way.
      className={[
        'inline-flex items-center justify-center gap-2.5 rounded-xl bg-sky-500 font-semibold text-neutral-950 shadow-lg shadow-sky-500/25 transition-all hover:bg-sky-400 hover:shadow-sky-400/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950',
        lg ? 'min-h-[52px] px-7 py-3 text-base' : 'min-h-[44px] px-5 py-2.5 text-sm',
      ].join(' ')}
    >
      <DownloadIcon className={lg ? 'h-5 w-5' : 'h-4 w-4'} />
      Download for {osLabel(os)}
      <span className="font-normal text-neutral-900/70">({link.format})</span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Instant paths — browser + PWA, zero install
// ---------------------------------------------------------------------------

function InstantPaths({ emphasised }: { emphasised: boolean }) {
  return (
    <div className={emphasised ? 'mt-10' : 'mt-12'}>
      {emphasised && (
        <p className="mb-4 text-xs font-semibold uppercase tracking-widest text-sky-400">
          Use it now — zero install
        </p>
      )}
      <div className="flex flex-wrap items-center justify-center gap-3">
        <Link
          href="/vault"
          className="inline-flex min-h-[44px] items-center gap-2 rounded-lg border border-neutral-800 bg-neutral-900/70 px-5 py-2.5 font-medium text-neutral-100 transition-all hover:border-neutral-700 hover:bg-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
        >
          <BrowserIcon className="h-4 w-4 text-sky-400" />
          Open in your browser
        </Link>
        {/* PWA install affordance — platform-aware; renders nothing when
            already installed or when install isn't possible. */}
        <InstallButton />
      </div>
      <p className="mt-3 text-xs text-neutral-500">
        No download, no account — your notes are saved locally on this device.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Other platforms list (desktop, when a release is resolved)
// ---------------------------------------------------------------------------

function OtherPlatforms({
  release,
  detected,
}: {
  release: Extract<ReleaseState, { status: 'ready' }>;
  detected: Os | null;
}) {
  const others = DESKTOP_OSES.filter((o) => o !== detected && release.installers[o].primary);
  if (others.length === 0) return null;

  return (
    <div className="mx-auto mt-12 max-w-xl border-t border-neutral-900 pt-8">
      <h2 className="text-sm font-semibold text-neutral-300">Other platforms</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-3">
        {others.map((o) => (
          <OtherPlatformCard key={o} os={o} installers={release.installers[o]} />
        ))}
      </div>
    </div>
  );
}

function OtherPlatformCard({
  os,
  installers,
}: {
  os: Exclude<Os, 'ios' | 'android' | 'unknown'>;
  installers: OsInstallers;
}) {
  const primary = installers.primary;
  if (!primary) return null;
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/40 p-4 text-left">
      <div className="text-sm font-medium text-neutral-200">{osLabel(os)}</div>
      <a
        href={primary.url}
        className="mt-2 inline-flex min-h-[40px] items-center gap-1.5 text-sm text-sky-400 transition-colors hover:text-sky-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
      >
        <DownloadIcon className="h-4 w-4" />
        {primary.format}
      </a>
      {installers.alternates.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-neutral-500">
          {installers.alternates.map((alt) => (
            <a
              key={alt.filename}
              href={alt.url}
              className="underline decoration-neutral-700 underline-offset-2 hover:text-neutral-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500"
            >
              {alt.format}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// OS detection (live navigator, corrects iPadOS-desktop-UA masquerade)
// ---------------------------------------------------------------------------

function useDetectedOs(): Os | null {
  // `null` until mounted so SSR / first paint render the neutral copy and we
  // avoid a hydration mismatch (navigator isn't available on the server).
  const [os, setOs] = useState<Os | null>(null);
  useEffect(() => {
    const isIpadMasquerade = detectIosFromNavigator({
      userAgent: navigator.userAgent,
      maxTouchPoints: navigator.maxTouchPoints,
      platform: navigator.platform,
    });
    setOs(isIpadMasquerade ? 'ios' : detectOs(navigator.userAgent));
  }, []);
  return os;
}

// ---------------------------------------------------------------------------
// Lightweight nav (back to the landing page) — keeps the page standalone
// ---------------------------------------------------------------------------

function SiteNav() {
  return (
    <header className="sticky top-0 z-40 border-b border-neutral-900/80 bg-neutral-950/80 backdrop-blur-md">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6 sm:py-4">
        <Link
          href="/"
          className="flex items-center gap-2.5 text-base font-semibold tracking-tight text-neutral-100 transition-opacity hover:opacity-80"
        >
          <GraphMark className="h-6 w-6 text-sky-400" />
          <span>GraphVault</span>
        </Link>
        <div className="flex items-center gap-3 text-sm sm:gap-5">
          <a
            href={RELEASES_PAGE}
            target="_blank"
            rel="noreferrer"
            className="hidden text-neutral-400 transition-colors hover:text-neutral-100 sm:block"
          >
            Releases
          </a>
          <Link
            href="/vault"
            className="inline-flex min-h-[44px] items-center rounded-lg bg-sky-500 px-4 py-2 text-sm font-semibold text-neutral-950 shadow-md shadow-sky-500/25 transition-all hover:bg-sky-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950"
          >
            Open GraphVault
          </Link>
        </div>
      </nav>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Icons
// ---------------------------------------------------------------------------

function DownloadIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className={className}
      aria-hidden="true"
    >
      <path d="M10 3v9M6 8l4 4 4-4M4 15h12" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function BrowserIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className={className}
      aria-hidden="true"
    >
      <rect x="2.5" y="3.5" width="15" height="13" rx="2" />
      <path d="M2.5 7h15" strokeLinecap="round" />
    </svg>
  );
}

function ExternalIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className={className}
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M7 4H5a1 1 0 00-1 1v10a1 1 0 001 1h10a1 1 0 001-1v-2M12 4h4v4M16 4l-7 7"
      />
    </svg>
  );
}

function GraphMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <circle cx="5" cy="6" r="2.2" fill="currentColor" />
      <circle cx="19" cy="8" r="2.2" fill="currentColor" />
      <circle cx="12" cy="18" r="2.2" fill="currentColor" />
      <path
        d="M6.6 7.4 10.6 16M17.6 9.4 13.4 16M7 6.6 17 8"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        opacity="0.6"
      />
    </svg>
  );
}
