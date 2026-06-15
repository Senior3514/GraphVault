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
 *
 * Mobile layout (< md / 768 px):
 *  - The sidebar collapses to a top navigation bar with a hamburger/drawer
 *    slide-over for secondary navigation. Tap targets are ≥ 44 px.
 *  - `env(safe-area-inset-*)` padding is applied to the top bar and bottom
 *    edges so notched devices don't clip the chrome.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';

import { BackupHistory } from './BackupHistory';
import { CommandPalette } from './CommandPalette';
import { NavIcon } from './NavIcon';
import { OnboardingHint } from './onboarding/OnboardingHint';
import { Sidebar } from './Sidebar';
import { VaultProvider } from '../lib/vault/VaultProvider';
import { AssistantPanel } from './assistant/AssistantPanel';
import { AssistantButton } from './assistant/AssistantButton';

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
  // Mobile drawer open state (only relevant on small screens)
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);

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

  // Close mobile drawer on outside click / Escape.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setDrawerOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        setDrawerOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [drawerOpen]);

  return (
    // Outer shell: full viewport, no overflow, respects safe-area insets.
    // h-[100dvh] uses the dynamic viewport height on mobile (excludes browser
    // chrome bars), falling back to 100vh on older browsers.
    <div
      className="relative flex h-screen w-screen flex-col overflow-hidden bg-neutral-950"
      style={{ height: '100dvh' }}
    >
      {/* ------------------------------------------------------------------ */}
      {/* Mobile top bar (visible only below md breakpoint)                   */}
      {/* ------------------------------------------------------------------ */}
      <MobileTopBar onMenuOpen={() => setDrawerOpen(true)} />

      {/* ------------------------------------------------------------------ */}
      {/* Main content row: desktop sidebar + page content                    */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Desktop sidebar — hidden on mobile via `hidden md:flex` */}
        <div className="hidden md:flex">
          <Sidebar collapsed={hydrated && collapsed} onToggle={toggleCollapsed} />
        </div>

        {/* Page content */}
        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{children}</div>
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Mobile slide-over drawer                                            */}
      {/* ------------------------------------------------------------------ */}
      {drawerOpen && (
        <>
          {/* Backdrop */}
          <div
            aria-hidden="true"
            className="absolute inset-0 z-40 bg-neutral-950/70 backdrop-blur-sm md:hidden"
            onClick={() => setDrawerOpen(false)}
          />
          {/* Drawer panel */}
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation"
            className="absolute inset-y-0 left-0 z-50 flex w-64 flex-col md:hidden motion-safe:animate-slide-up"
          >
            <Sidebar
              collapsed={false}
              onToggle={() => setDrawerOpen(false)}
              mobileDrawerClose={() => setDrawerOpen(false)}
            />
          </div>
        </>
      )}

      <CommandPalette />
      {/* Version history / backup restore modal — opened via CommandPalette or
          the OPEN_BACKUP_HISTORY_EVENT custom event. Mounted once so the IDB
          load is shared across all triggers. */}
      <BackupHistory />
      {/* Onboarding hint: shown only on first use, persisted-dismissed in localStorage */}
      <OnboardingHint />
      {/* AI assistant panel — toggleable, off by default, privacy-first.
          Wrapped in Suspense because it reads useSearchParams() (current note),
          which requires a boundary for the static export to prerender. */}
      <Suspense fallback={null}>
        <AssistantPanel />
      </Suspense>
      <AssistantButton />
    </div>
  );
}

// ---- Mobile top bar ---------------------------------------------------------

function MobileTopBar({ onMenuOpen }: { onMenuOpen: () => void }) {
  const open = () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true }),
    );
  };

  return (
    <header
      className="flex h-12 shrink-0 items-center justify-between gap-1 border-b border-neutral-800 bg-neutral-950/95 px-2 md:hidden"
      style={{ paddingTop: 'env(safe-area-inset-top)' }}
    >
      {/* Left group: hamburger + back */}
      <div className="flex items-center">
        <button
          type="button"
          onClick={onMenuOpen}
          aria-label="Open navigation menu"
          className="flex h-10 w-10 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          <HamburgerIcon />
        </button>
        <button
          type="button"
          onClick={() => window.history.back()}
          aria-label="Go back"
          title="Back"
          className="flex h-10 w-10 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          <BackIcon />
        </button>
      </div>

      {/* Wordmark → home (landing) */}
      <Link
        href="/"
        aria-label="GraphVault home"
        className="truncate text-sm font-semibold tracking-tight text-neutral-100 hover:text-white"
      >
        GraphVault
      </Link>

      {/* Right group: home + search */}
      <div className="flex items-center">
        <Link
          href="/"
          aria-label="Home"
          title="Home"
          className="flex h-10 w-10 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          <NavIcon glyph="home" className="h-5 w-5" />
        </Link>
        <button
          type="button"
          onClick={open}
          aria-label="Open command palette"
          className="flex h-10 w-10 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 focus-visible:ring-2 focus-visible:ring-sky-500"
        >
          <SearchIcon />
        </button>
      </div>
    </header>
  );
}

function HamburgerIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M3 5h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2zm0 4h14a1 1 0 010 2H3a1 1 0 010-2z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function BackIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M12.7 4.3a1 1 0 010 1.4L8.4 10l4.3 4.3a1 1 0 01-1.4 1.4l-5-5a1 1 0 010-1.4l5-5a1 1 0 011.4 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <circle cx="8.5" cy="8.5" r="5" />
      <path strokeLinecap="round" d="M12.5 12.5l4 4" />
    </svg>
  );
}
