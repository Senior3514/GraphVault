'use client';

/**
 * AddButton - primary "+" fast-capture action for the vault.
 *
 * Renders in two modes depending on the viewport:
 *  - Desktop (>= md): an inline "+ New" button in the note-list header area.
 *  - Mobile  (<  md): a bottom-anchored FAB in the safe-area thumb zone,
 *    ≥ 48 px touch target, positioned above the mobile top bar so it does
 *    not overlap existing chrome.
 *
 * One tap opens a small menu:
 *   • New note   - collision-safe Untitled.md, opened immediately (fast capture)
 *   • Import…    - triggers the folder-picker flow (same as command palette)
 *   • New folder - prompts for a folder name, creates Untitled.md inside it
 *
 * The menu is keyboard-accessible: arrow keys navigate, Enter runs, Esc closes.
 * Animations are gated on `prefers-reduced-motion`. The component is ARIA-labelled
 * and focus-managed so it works with screen readers.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { isFolderPickerSupported, openFolder } from '../lib/vault/openFolder';
import { nextUntitledName } from '../lib/vault/untitled';
import { useVaultContext } from '../lib/vault/VaultProvider';
import type { NotePath } from '../lib/vault/types';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface AddButtonProps {
  /**
   * Called after a note is created so the parent can open it in a tab.
   * Receives the new note's path.
   */
  onNoteCreated(path: NotePath): void;

  /**
   * Visual variant.
   * - `"inline"` (default): small button for the note-list header (desktop).
   * - `"fab"`: floating action button for the mobile bottom thumb zone.
   */
  variant?: 'inline' | 'fab';
}

// ---------------------------------------------------------------------------
// Menu item definitions
// ---------------------------------------------------------------------------

interface MenuItem {
  id: string;
  label: string;
  description: string;
  glyph: string;
}

const MENU_ITEMS: MenuItem[] = [
  {
    id: 'new-note',
    label: 'New note',
    description: 'Create an untitled note',
    glyph: '+',
  },
  {
    id: 'import',
    label: 'Import…',
    description: 'Open a folder of Markdown files',
    glyph: '\u{1F4C2}',
  },
  {
    id: 'new-folder',
    label: 'New folder',
    description: 'Create a note inside a new folder',
    glyph: '\u{1F4C1}',
  },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AddButton({ onNoteCreated, variant = 'inline' }: AddButtonProps) {
  const vault = useVaultContext();
  const [menuOpen, setMenuOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const menuId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // ---- Menu helpers ---------------------------------------------------------

  const openMenu = useCallback(() => {
    setHighlight(0);
    setMenuOpen(true);
  }, []);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    // Return focus to the trigger so keyboard users can continue without
    // navigating back manually.
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!menuOpen) return;

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        closeMenu();
      }
    };
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node | null;
      if (target && !menuRef.current?.contains(target) && !triggerRef.current?.contains(target)) {
        closeMenu();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('pointerdown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('pointerdown', onPointerDown);
    };
  }, [menuOpen, closeMenu]);

  // Focus the first menu item when the menu opens.
  useEffect(() => {
    if (!menuOpen) return;
    const first = menuRef.current?.querySelector<HTMLButtonElement>('[data-menu-item]');
    first?.focus();
  }, [menuOpen]);

  // ---- Action handlers ------------------------------------------------------

  const handleNewNote = useCallback(() => {
    closeMenu();
    const path = nextUntitledName(vault.notes.map((n) => n.path));
    try {
      const created = vault.createNote(path, '');
      onNoteCreated(created.path as NotePath);
    } catch {
      // Path collision is very unlikely (concurrent create), ignore silently.
    }
  }, [vault, onNoteCreated, closeMenu]);

  const handleImport = useCallback(() => {
    closeMenu();
    if (!isFolderPickerSupported()) {
      window.alert(
        'The File System Access API is not available in this browser.\n' +
          'Try Chrome 86+, Edge 86+, or another Chromium-based browser.',
      );
      return;
    }
    void openFolder()
      .then((entries) => {
        if (entries.length === 0) {
          window.alert('No importable Markdown or text files were found in the selected folder.');
          return;
        }
        const summary = vault.importNotes(entries);
        const lines: string[] = [];
        if (summary.added > 0) lines.push(`${summary.added} note(s) added.`);
        if (summary.renamed.length > 0) {
          lines.push(
            `${summary.renamed.length} note(s) kept as copies (path collision with different content).`,
          );
        }
        if (summary.unchanged > 0) {
          lines.push(`${summary.unchanged} note(s) unchanged (already in vault).`);
        }
        window.alert(lines.join('\n') || 'No changes.');
      })
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        const message = err instanceof Error ? err.message : String(err);
        window.alert(`Could not import folder: ${message}`);
      });
  }, [vault, closeMenu]);

  const handleNewFolder = useCallback(() => {
    closeMenu();
    const folderInput = window.prompt('New folder name (e.g. projects):');
    if (!folderInput?.trim()) return;
    const folder = folderInput.trim().replace(/^\/+|\/+$/g, '');
    const path = nextUntitledName(
      vault.notes.map((n) => n.path),
      folder,
    );
    try {
      const created = vault.createNote(path, '');
      onNoteCreated(created.path as NotePath);
    } catch {
      // Unlikely collision.
    }
  }, [vault, onNoteCreated, closeMenu]);

  const runItem = useCallback(
    (id: string) => {
      if (id === 'new-note') handleNewNote();
      else if (id === 'import') handleImport();
      else if (id === 'new-folder') handleNewFolder();
    },
    [handleNewNote, handleImport, handleNewFolder],
  );

  // ---- Keyboard navigation inside the menu ----------------------------------

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (h + 1) % MENU_ITEMS.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (h - 1 + MENU_ITEMS.length) % MENU_ITEMS.length);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = MENU_ITEMS[highlight];
      if (item) runItem(item.id);
    } else if (e.key === 'Tab') {
      // Cycle focus within the menu rather than escaping it.
      e.preventDefault();
      setHighlight((h) =>
        e.shiftKey ? (h - 1 + MENU_ITEMS.length) % MENU_ITEMS.length : (h + 1) % MENU_ITEMS.length,
      );
    }
  };

  // Sync focus with the highlighted index so arrow keys move the real focus.
  useEffect(() => {
    if (!menuOpen) return;
    const items = menuRef.current?.querySelectorAll<HTMLButtonElement>('[data-menu-item]');
    items?.[highlight]?.focus();
  }, [highlight, menuOpen]);

  // ---- Render ---------------------------------------------------------------

  if (variant === 'fab') {
    return (
      <div
        className="fixed bottom-0 right-0 z-30 md:hidden"
        style={{
          // `fixed` positions this relative to the viewport, not the
          // in-document-flow mobile pane-switcher nav bar (WorkspaceLayout.tsx)
          // that sits at the real bottom of the screen - so without clearing
          // its height explicitly, this FAB overlapped the nav bar's rightmost
          // ("Details") tab by ~38px, silently eating its tap target. That nav
          // bar's height is a stable, deliberately-fixed design constant
          // (`min-h-[48px]` per tab + padding ≈ 54px) - measured in a real
          // headless-Chromium check, not assumed. 70px = that ~54px plus the
          // FAB's own original 16px breathing room.
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 70px)',
          paddingRight: '16px',
        }}
      >
        {/* FAB trigger */}
        <button
          ref={triggerRef}
          type="button"
          aria-label="Add"
          aria-haspopup="true"
          aria-expanded={menuOpen}
          aria-controls={menuId}
          onClick={() => (menuOpen ? closeMenu() : openMenu())}
          className={[
            // ≥ 48px touch target, circular, cyan brand accent, thumb-zone accessible.
            'flex h-14 w-14 items-center justify-center rounded-full bg-accent-600 text-white shadow-lg',
            'text-2xl font-light transition-transform focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 focus-visible:ring-offset-2 focus-visible:ring-offset-neutral-950',
            'hover:bg-accent-500 active:scale-95 motion-reduce:active:scale-100',
            menuOpen ? 'rotate-45 motion-reduce:rotate-0' : '',
          ].join(' ')}
        >
          +
        </button>

        {/* Drop-up menu */}
        {menuOpen && (
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label="Add options"
            onKeyDown={onMenuKeyDown}
            className="absolute bottom-full right-0 mb-3 w-52 overflow-hidden rounded-xl border border-neutral-700/80 bg-neutral-900/95 shadow-2xl shadow-black/50 ring-1 ring-white/5 motion-safe:animate-[paletteIn_140ms_ease-out]"
          >
            {MENU_ITEMS.map((item, i) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                data-menu-item
                tabIndex={i === highlight ? 0 : -1}
                onClick={() => runItem(item.id)}
                onMouseMove={() => setHighlight(i)}
                className={[
                  'flex w-full items-center gap-3 px-4 py-3 text-left text-sm transition-colors motion-reduce:transition-none',
                  i === highlight
                    ? 'bg-accent-500/15 text-neutral-100'
                    : 'text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100',
                ].join(' ')}
              >
                <span
                  aria-hidden="true"
                  className={[
                    'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-xs',
                    i === highlight
                      ? 'border-accent-400/40 bg-accent-500/10 text-accent-300'
                      : 'border-neutral-700 bg-neutral-800/60 text-neutral-400',
                  ].join(' ')}
                >
                  {item.glyph}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">{item.label}</span>
                  <span className="block truncate text-xs text-neutral-500">
                    {item.description}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  }

  // Inline variant (desktop note-list header).
  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-label="Add new note or import"
        aria-haspopup="true"
        aria-expanded={menuOpen}
        aria-controls={menuId}
        onClick={() => (menuOpen ? closeMenu() : openMenu())}
        className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200 hover:bg-neutral-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-500"
      >
        + New
      </button>

      {/* Drop-down menu */}
      {menuOpen && (
        <div
          ref={menuRef}
          id={menuId}
          role="menu"
          aria-label="Add options"
          onKeyDown={onMenuKeyDown}
          className="absolute left-0 top-full z-40 mt-1 w-52 overflow-hidden rounded-xl border border-neutral-700/80 bg-neutral-900/95 shadow-2xl shadow-black/50 ring-1 ring-white/5 motion-safe:animate-[paletteIn_140ms_ease-out]"
        >
          {MENU_ITEMS.map((item, i) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              data-menu-item
              tabIndex={i === highlight ? 0 : -1}
              onClick={() => runItem(item.id)}
              onMouseMove={() => setHighlight(i)}
              className={[
                'flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors motion-reduce:transition-none',
                i === highlight
                  ? 'bg-accent-500/15 text-neutral-100'
                  : 'text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100',
              ].join(' ')}
            >
              <span
                aria-hidden="true"
                className={[
                  'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-xs',
                  i === highlight
                    ? 'border-accent-400/40 bg-accent-500/10 text-accent-300'
                    : 'border-neutral-700 bg-neutral-800/60 text-neutral-400',
                ].join(' ')}
              >
                {item.glyph}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{item.label}</span>
                <span className="block truncate text-xs text-neutral-500">{item.description}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
