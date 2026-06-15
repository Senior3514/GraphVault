'use client';

/**
 * Primary app navigation rail. Dark-first, content-forward per DESIGN.md.
 *
 * Collapsible to an icon rail (state owned by {@link AppFrame}, persisted +
 * toggleable with Cmd/Ctrl+B). Each nav item shows an icon glyph so it stays
 * legible when collapsed; a Cmd-K affordance opens the command palette.
 *
 * Mobile: rendered inside a slide-over drawer managed by AppFrame. When
 * `mobileDrawerClose` is provided, nav-link clicks dismiss the drawer.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { NavIcon, type NavGlyph } from './NavIcon';

interface NavItem {
  href: string;
  label: string;
  hint: string;
  glyph: NavGlyph;
}

const NAV: NavItem[] = [
  { href: '/vault', label: 'Vault', hint: 'Notes & editor', glyph: 'vault' },
  { href: '/graph', label: 'Graph', hint: 'Connections & filters', glyph: 'graph' },
  { href: '/sync-status', label: 'Sync', hint: 'Status & conflicts', glyph: 'sync' },
  { href: '/settings', label: 'Settings', hint: 'Server & vault', glyph: 'settings' },
];

interface SidebarProps {
  collapsed: boolean;
  onToggle(): void;
  /** When provided (mobile drawer context), called after each nav-link tap to close the drawer. */
  mobileDrawerClose?: () => void;
}

export function Sidebar({ collapsed, onToggle, mobileDrawerClose }: SidebarProps) {
  const pathname = usePathname();

  return (
    <nav
      aria-label="Primary"
      data-collapsed={collapsed}
      className={[
        'flex h-full shrink-0 flex-col border-r border-neutral-800/80 bg-neutral-950/95',
        'transition-[width] duration-200 ease-out motion-reduce:transition-none',
        collapsed ? 'w-[60px]' : 'w-56',
      ].join(' ')}
    >
      <div
        className={[
          'flex items-center gap-2 px-3 py-4',
          collapsed ? 'justify-center' : 'justify-between',
        ].join(' ')}
        style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}
      >
        <Link
          href="/vault"
          className="flex min-w-0 items-center gap-2"
          title="GraphVault"
          onClick={mobileDrawerClose}
        >
          <NavIcon glyph="graph" className="h-6 w-6 shrink-0 text-sky-400" />
          {!collapsed && (
            <span className="min-w-0">
              <span className="block truncate text-base font-semibold tracking-tight text-neutral-100">
                GraphVault
              </span>
              <span className="block text-xs text-neutral-500">Local-first notes</span>
            </span>
          )}
        </Link>
        {!collapsed && (
          <button
            type="button"
            onClick={mobileDrawerClose ?? onToggle}
            aria-label={mobileDrawerClose ? 'Close navigation' : 'Collapse sidebar'}
            title={mobileDrawerClose ? 'Close navigation' : 'Collapse sidebar (Cmd/Ctrl+B)'}
            className="rounded-md p-1 text-neutral-500 transition-colors hover:bg-neutral-900 hover:text-neutral-300"
          >
            <ChevronIcon className="h-4 w-4" />
          </button>
        )}
      </div>

      <ul className="flex-1 space-y-1 px-2">
        {NAV.map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href}>
              <Link
                href={item.href}
                title={collapsed ? `${item.label} — ${item.hint}` : undefined}
                aria-current={active ? 'page' : undefined}
                onClick={mobileDrawerClose}
                className={[
                  // min-h ensures ≥ 44px touch target
                  'group flex min-h-[44px] items-center gap-3 rounded-md px-2.5 py-2 text-sm transition-colors motion-reduce:transition-none',
                  collapsed ? 'justify-center' : '',
                  active
                    ? 'bg-neutral-800/80 text-neutral-100'
                    : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200',
                ].join(' ')}
              >
                <NavIcon
                  glyph={item.glyph}
                  className={[
                    'h-5 w-5 shrink-0 transition-colors',
                    active ? 'text-sky-400' : 'text-neutral-500 group-hover:text-neutral-300',
                  ].join(' ')}
                />
                {!collapsed && (
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{item.label}</span>
                    <span className="block truncate text-xs text-neutral-500">{item.hint}</span>
                  </span>
                )}
              </Link>
            </li>
          );
        })}
      </ul>

      <div
        className="space-y-2 border-t border-neutral-800/80 p-2"
        style={{ paddingBottom: 'max(0.5rem, env(safe-area-inset-bottom))' }}
      >
        <CommandHint collapsed={collapsed} />
        {collapsed ? (
          <button
            type="button"
            onClick={onToggle}
            aria-label="Expand sidebar"
            title="Expand sidebar (Cmd/Ctrl+B)"
            className="flex w-full items-center justify-center rounded-md p-2 text-neutral-500 transition-colors hover:bg-neutral-900 hover:text-neutral-300"
          >
            <ChevronIcon className="h-4 w-4 rotate-180" />
          </button>
        ) : (
          <p className="px-1.5 text-[11px] text-neutral-600">v0 · web shell</p>
        )}
      </div>
    </nav>
  );
}

/**
 * Opens the command palette. It dispatches the same synthetic Cmd/Ctrl+K event
 * the palette listens for, so there is a single source of truth for the
 * shortcut and no prop drilling.
 */
function CommandHint({ collapsed }: { collapsed: boolean }) {
  const open = () => {
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'k', metaKey: true, ctrlKey: true, bubbles: true }),
    );
  };
  return (
    <button
      type="button"
      onClick={open}
      title="Command palette (Cmd/Ctrl+K)"
      aria-label="Open command palette"
      className={[
        'flex min-h-[44px] w-full items-center gap-2 rounded-md border border-neutral-800 bg-neutral-900/60 text-sm text-neutral-400 transition-colors hover:border-neutral-700 hover:text-neutral-200',
        collapsed ? 'justify-center px-2 py-2' : 'px-2.5 py-1.5',
      ].join(' ')}
    >
      <span aria-hidden="true">⌕</span>
      {!collapsed && (
        <>
          <span className="flex-1 text-left">Search</span>
          <kbd className="rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-500">
            ⌘K
          </kbd>
        </>
      )}
    </button>
  );
}

function ChevronIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <path
        d="M15 6l-6 6 6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
