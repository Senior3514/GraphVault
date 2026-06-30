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
import { usePathname, useRouter } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';

import { useFocusTrap } from '../lib/a11y/useFocusTrap';
import { AddButton } from './AddButton';
import { BackupHistory } from './BackupHistory';
import { CommandPalette } from './CommandPalette';
import { NavIcon } from './NavIcon';
import { OnboardingHint } from './onboarding/OnboardingHint';
import { PrivateVaultWelcome } from './onboarding/PrivateVaultWelcome';
import { Tour } from './onboarding/Tour';
import { Sidebar } from './Sidebar';
import { useLayout } from '../lib/layout/useLayout';
import { VaultProvider } from '../lib/vault/VaultProvider';
import { AssistantPanel } from './assistant/AssistantPanel';
import { AssistantButton } from './assistant/AssistantButton';

const COLLAPSE_KEY = 'graphvault.sidebar.collapsed';

export function AppFrame({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  // The marketing landing page and the public download page stand alone - they
  // bring their own full-bleed chrome and need no vault sidebar shell.
  if (pathname === '/' || pathname === '/download' || pathname === '/download/') {
    return <>{children}</>;
  }

  return (
    <VaultProvider>
      <AppShell>{children}</AppShell>
    </VaultProvider>
  );
}

function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  // Focus mode (distraction-free editing). Lives in the persisted layout state;
  // this instance drives hiding the rail/sidebar/mobile-chrome at the shell
  // level. The workspace pane layout reacts via its own useLayout instance,
  // kept in sync by the FOCUS_MODE_EVENT broadcast inside the hook.
  const { layout, toggleFocusMode, setFocusMode } = useLayout();
  const focusMode = layout.focusMode;
  // Mobile drawer open state (only relevant on small screens)
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement>(null);
  // Track the element focused before the drawer opened so we can restore it.
  const drawerRestoreFocusRef = useRef<HTMLElement | null>(null);

  // Capture the focused element before opening the drawer.
  const openDrawer = useCallback(() => {
    drawerRestoreFocusRef.current = document.activeElement as HTMLElement | null;
    setDrawerOpen(true);
  }, []);

  // Restore focus to the element that was active before the drawer opened.
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
    // Focus restore is handled by useFocusTrap cleanup, but we keep an
    // explicit fallback here for programmatic closes (e.g. after nav).
    requestAnimationFrame(() => drawerRestoreFocusRef.current?.focus?.());
  }, []);

  // Focus trap for the mobile drawer.
  useFocusTrap(drawerRef, drawerOpen, drawerRestoreFocusRef);

  // Restore the persisted collapse preference after mount (avoids SSR mismatch).
  useEffect(() => {
    try {
      setCollapsed(window.localStorage.getItem(COLLAPSE_KEY) === '1');
    } catch {
      /* storage unavailable - fall back to expanded */
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

  // Cmd/Ctrl+Shift+F toggles focus mode (distraction-free editing). Verified
  // not to collide: Cmd/Ctrl+K (palette), +B (sidebar), +E (preview/split),
  // and Cmd/Ctrl+Shift+A (AI assistant) are the only other global chords.
  // Esc exits focus mode (but only when no overlay - palette/drawer/etc. -
  // is consuming Escape; those mount their own handlers and stopPropagation
  // isn't used, so we guard by checking focusMode is on and let other Esc
  // handlers run first by not preventing default unless we act).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        toggleFocusMode();
        return;
      }
      // Esc leaves focus mode. Ignore when a modal/menu is open (it owns Esc)
      // or when the user is mid-text-entry in an input that isn't the editor.
      if (e.key === 'Escape' && focusMode) {
        const overlayOpen = document.querySelector('[role="dialog"][aria-modal="true"]');
        if (overlayOpen) return;
        e.preventDefault();
        setFocusMode(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleFocusMode, setFocusMode, focusMode]);

  // Close mobile drawer on outside click / Escape.
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDrawer();
    };
    const onClick = (e: MouseEvent) => {
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) {
        closeDrawer();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('mousedown', onClick);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('mousedown', onClick);
    };
  }, [drawerOpen, closeDrawer]);

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
      {/* Hidden in focus mode for distraction-free editing.                  */}
      {/* ------------------------------------------------------------------ */}
      {!focusMode && <MobileTopBar onMenuOpen={openDrawer} />}

      {/* ------------------------------------------------------------------ */}
      {/* Main content row: desktop sidebar + page content                    */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Desktop sidebar - hidden on mobile via `hidden md:flex`, and
            hidden entirely in focus mode. */}
        {!focusMode && (
          <div className="hidden md:flex">
            <Sidebar collapsed={hydrated && collapsed} onToggle={toggleCollapsed} />
          </div>
        )}

        {/* Page content - `id` is the skip-link target from layout.tsx */}
        <div id="main-content" className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </div>
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
            onClick={closeDrawer}
          />
          {/* Drawer panel */}
          <div
            ref={drawerRef}
            role="dialog"
            aria-modal="true"
            aria-label="Navigation menu"
            className="absolute inset-y-0 left-0 z-50 flex w-64 flex-col md:hidden motion-safe:animate-slide-up"
          >
            <Sidebar collapsed={false} onToggle={closeDrawer} mobileDrawerClose={closeDrawer} />
          </div>
        </>
      )}

      {/* Focus-mode exit affordance: a small fixed pill in the top-right so the
          user can always leave distraction-free mode (mouse), in addition to
          Esc and Cmd/Ctrl+Shift+F. Transitions respect reduced motion. */}
      {focusMode && (
        <button
          type="button"
          onClick={() => setFocusMode(false)}
          aria-pressed={true}
          aria-label="Exit focus mode"
          title="Exit focus mode (Esc)"
          className="fixed right-3 top-3 z-50 flex items-center gap-2 rounded-full border border-neutral-700/80 bg-neutral-900/80 px-3 py-1.5 text-xs text-neutral-300 shadow-lg backdrop-blur transition-colors hover:bg-neutral-800 hover:text-neutral-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 motion-reduce:transition-none"
          style={{ top: 'calc(0.75rem + env(safe-area-inset-top))' }}
        >
          <FocusExitIcon />
          <span className="hidden sm:inline">Exit focus</span>
          <kbd className="rounded border border-neutral-700 px-1 text-[10px] text-neutral-500">
            Esc
          </kbd>
        </button>
      )}

      <CommandPalette />
      {/* Version history / backup restore modal - opened via CommandPalette or
          the OPEN_BACKUP_HISTORY_EVENT custom event. Mounted once so the IDB
          load is shared across all triggers. */}
      <BackupHistory />
      {/* First-entry framing: a one-time modal that makes the public-page →
          private-vault transition explicit ("this space lives only on this
          device"). Shown once, before the lighter OnboardingHint tips. */}
      <PrivateVaultWelcome />
      {/* Onboarding hint: shown only on first use, persisted-dismissed in localStorage */}
      <OnboardingHint />
      {/* Guided tour: multi-step coachmark shown on first run, re-openable via
          the graphvault.tour.open custom event. Mounted after the hint so they
          don't compete visually (tour has a higher z-index overlay). */}
      <Tour />
      {/* AI assistant panel - toggleable, off by default, privacy-first.
          Wrapped in Suspense because it reads useSearchParams() (current note),
          which requires a boundary for the static export to prerender. */}
      <Suspense fallback={null}>
        <AssistantPanel />
      </Suspense>
      <AssistantButton />
      {/* Mobile FAB: fast-capture "+ Add" in the thumb zone.
          Mounted only on the vault route where note-creation is meaningful.
          The FAB is hidden on desktop (md:hidden inside AddButton). */}
      {pathname === '/vault' && (
        <AddButton
          variant="fab"
          onNoteCreated={(path) => router.push(`/vault?note=${encodeURIComponent(path)}`)}
        />
      )}
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
          className="flex h-10 w-10 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 focus-visible:ring-2 focus-visible:ring-accent-500"
        >
          <HamburgerIcon />
        </button>
        <button
          type="button"
          onClick={() => window.history.back()}
          aria-label="Go back"
          title="Back"
          className="flex h-10 w-10 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 focus-visible:ring-2 focus-visible:ring-accent-500"
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
          className="flex h-10 w-10 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 focus-visible:ring-2 focus-visible:ring-accent-500"
        >
          <NavIcon glyph="home" className="h-5 w-5" />
        </Link>
        <button
          type="button"
          onClick={open}
          aria-label="Open command palette"
          className="flex h-10 w-10 items-center justify-center rounded-md text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200 focus-visible:ring-2 focus-visible:ring-accent-500"
        >
          <SearchIcon />
        </button>
      </div>
    </header>
  );
}

function FocusExitIcon() {
  // "Collapse / exit fullscreen" glyph - inward-pointing corners.
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M8 3v3a2 2 0 01-2 2H3m14 0h-3a2 2 0 01-2-2V3M3 12h3a2 2 0 012 2v3m9-5h-3a2 2 0 00-2 2v3"
      />
    </svg>
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
