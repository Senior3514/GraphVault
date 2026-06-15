'use client';

/**
 * Global command palette (Cmd/Ctrl+K).
 *
 * Mounted once in {@link AppFrame} so it is available on every non-landing
 * route. It blends two result kinds, both ranked and filtered by the live
 * query:
 *
 *  - **Actions** — a small fixed set ("Create new note", "Go to Graph", …),
 *    matched with the dependency-free {@link fuzzyMatch} subsequence scorer.
 *  - **Notes** — quick-open by title/body via the vault's MiniSearch index.
 *
 * It is fully keyboard-driven (↑/↓ to move, Enter to run, Esc to close), traps
 * focus while open, restores focus to the previously active element on close,
 * and is labelled for assistive tech. Animations respect
 * `prefers-reduced-motion` via the `motion-reduce:*` utilities.
 */

import { useRouter } from 'next/navigation';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';

import { fuzzyMatch } from '../lib/vault/fuzzy';
import { useVaultContext } from '../lib/vault/VaultProvider';
import type { NotePath } from '../lib/vault/types';

/** Custom event the vault page listens for to toggle its preview pane. */
export const TOGGLE_PREVIEW_EVENT = 'graphvault:toggle-preview';

interface PaletteAction {
  id: string;
  label: string;
  hint: string;
  /** Glyph rendered in the leading badge. */
  glyph: string;
  keywords?: string;
  run(): void;
}

interface Item {
  key: string;
  label: string;
  hint: string;
  glyph: string;
  score: number;
  run(): void;
}

const MAX_NOTE_RESULTS = 6;

export function CommandPalette() {
  const router = useRouter();
  const vault = useVaultContext();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setHighlight(0);
  }, []);

  // Global Cmd/Ctrl+K toggles the palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((wasOpen) => {
          if (wasOpen) {
            setQuery('');
            setHighlight(0);
            return false;
          }
          restoreFocusRef.current = document.activeElement as HTMLElement | null;
          setQuery('');
          setHighlight(0);
          return true;
        });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Focus the input when opening; restore focus when closing.
  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    } else {
      restoreFocusRef.current?.focus?.();
    }
  }, [open]);

  const go = useCallback(
    (href: string) => {
      router.push(href);
    },
    [router],
  );

  const openNote = useCallback(
    (path: NotePath) => {
      go(`/vault?note=${encodeURIComponent(path)}`);
    },
    [go],
  );

  const actions = useMemo<PaletteAction[]>(() => {
    const list: PaletteAction[] = [
      {
        id: 'new-note',
        label: 'Create new note',
        hint: 'Add a note to the vault',
        glyph: '+',
        keywords: 'add create new note',
        run: () => {
          const name = window.prompt('New note path (e.g. notes/idea):');
          if (!name) return;
          try {
            const created = vault.createNote(name);
            openNote(created.path);
          } catch {
            /* duplicate or invalid path — surfaced on the vault page instead */
          }
        },
      },
      {
        id: 'goto-vault',
        label: 'Go to Vault',
        hint: 'Notes & editor',
        glyph: '◇',
        keywords: 'vault notes editor home',
        run: () => go('/vault'),
      },
      {
        id: 'goto-graph',
        label: 'Go to Graph',
        hint: 'Connections & filters',
        glyph: '⬡',
        keywords: 'graph connections links view',
        run: () => go('/graph'),
      },
      {
        id: 'goto-sync',
        label: 'Go to Sync',
        hint: 'Status & conflicts',
        glyph: '⇅',
        keywords: 'sync status conflicts server',
        run: () => go('/sync-status'),
      },
      {
        id: 'goto-settings',
        label: 'Go to Settings',
        hint: 'Server & vault',
        glyph: '⚙',
        keywords: 'settings preferences server config',
        run: () => go('/settings'),
      },
      {
        id: 'toggle-preview',
        label: 'Toggle preview',
        hint: 'Switch the editor preview pane',
        glyph: '⌘E',
        keywords: 'toggle preview markdown render edit',
        run: () => window.dispatchEvent(new Event(TOGGLE_PREVIEW_EVENT)),
      },
    ];
    return list;
  }, [vault, go, openNote]);

  const items = useMemo<Item[]>(() => {
    const q = query.trim();

    const actionItems: Item[] = actions
      .map((a) => {
        const m = fuzzyMatch(`${a.label} ${a.keywords ?? ''}`, q);
        if (!m) return null;
        return {
          key: `action:${a.id}`,
          label: a.label,
          hint: a.hint,
          glyph: a.glyph,
          score: m.score,
          run: a.run,
        } satisfies Item;
      })
      .filter((x): x is Item => x !== null)
      .sort((a, b) => b.score - a.score);

    let noteItems: Item[] = [];
    if (q !== '') {
      noteItems = vault
        .search(q)
        .slice(0, MAX_NOTE_RESULTS)
        .map((r) => ({
          key: `note:${r.path}`,
          label: r.title,
          hint: r.path,
          glyph: '↳',
          score: r.score,
          run: () => openNote(r.path),
        }));
    }

    return [...actionItems, ...noteItems];
  }, [actions, query, vault, openNote]);

  // Keep the highlighted index in range as results change.
  useEffect(() => {
    setHighlight((h) => (items.length === 0 ? 0 : Math.min(h, items.length - 1)));
  }, [items.length]);

  // Keep the active option scrolled into view.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${highlight}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [highlight, open]);

  const runItem = useCallback(
    (item: Item | undefined) => {
      if (!item) return;
      close();
      // Defer so focus restoration in the close effect lands before navigation
      // or a prompt steals focus.
      requestAnimationFrame(() => item.run());
    },
    [close],
  );

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (items.length === 0 ? 0 : (h + 1) % items.length));
      return;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (items.length === 0 ? 0 : (h - 1 + items.length) % items.length));
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      runItem(items[highlight]);
      return;
    }
    // Simple focus trap: Tab moves the highlight rather than escaping the modal.
    if (e.key === 'Tab') {
      e.preventDefault();
      setHighlight((h) => {
        if (items.length === 0) return 0;
        return e.shiftKey ? (h - 1 + items.length) % items.length : (h + 1) % items.length;
      });
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]"
      role="presentation"
      onKeyDown={onKeyDown}
    >
      {/* Scrim */}
      <button
        type="button"
        aria-label="Close command palette"
        tabIndex={-1}
        onClick={close}
        className="absolute inset-0 cursor-default bg-neutral-950/70 backdrop-blur-sm motion-safe:animate-[fadeIn_120ms_ease-out]"
      />

      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="relative w-full max-w-xl overflow-hidden rounded-xl border border-neutral-700/80 bg-neutral-900/95 shadow-2xl shadow-black/50 ring-1 ring-white/5 motion-safe:animate-[paletteIn_140ms_ease-out]"
      >
        <div className="flex items-center gap-3 border-b border-neutral-800 px-4">
          <span aria-hidden="true" className="text-neutral-500">
            ⌕
          </span>
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls="command-palette-list"
            aria-activedescendant={items[highlight] ? `cmd-${highlight}` : undefined}
            aria-autocomplete="list"
            value={query}
            spellCheck={false}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            placeholder="Search notes or run a command…"
            className="w-full bg-transparent py-3.5 text-sm text-neutral-100 outline-none placeholder:text-neutral-500"
          />
          <kbd className="hidden shrink-0 rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-500 sm:block">
            Esc
          </kbd>
        </div>

        <ul
          ref={listRef}
          id="command-palette-list"
          role="listbox"
          aria-label="Results"
          className="max-h-80 overflow-auto p-1.5"
        >
          {items.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-neutral-500">No matches</li>
          ) : (
            items.map((item, i) => {
              const active = i === highlight;
              return (
                <li key={item.key}>
                  <button
                    type="button"
                    id={`cmd-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={active}
                    onMouseMove={() => setHighlight(i)}
                    onClick={() => runItem(item)}
                    className={[
                      'flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors motion-reduce:transition-none',
                      active ? 'bg-sky-500/15 text-neutral-100' : 'text-neutral-300',
                    ].join(' ')}
                  >
                    <span
                      aria-hidden="true"
                      className={[
                        'flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-xs',
                        active
                          ? 'border-sky-400/40 bg-sky-500/10 text-sky-300'
                          : 'border-neutral-700 bg-neutral-800/60 text-neutral-400',
                      ].join(' ')}
                    >
                      {item.glyph}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{item.label}</span>
                      <span className="block truncate text-xs text-neutral-500">{item.hint}</span>
                    </span>
                    {active && (
                      <kbd className="hidden shrink-0 rounded border border-neutral-700 px-1.5 py-0.5 text-[10px] text-neutral-500 sm:block">
                        ↵
                      </kbd>
                    )}
                  </button>
                </li>
              );
            })
          )}
        </ul>

        <div className="flex items-center justify-between border-t border-neutral-800 px-4 py-2 text-[11px] text-neutral-600">
          <span className="flex items-center gap-3">
            <span>
              <Key>↑</Key>
              <Key>↓</Key> navigate
            </span>
            <span>
              <Key>↵</Key> open
            </span>
          </span>
          <span>GraphVault</span>
        </div>
      </div>
    </div>
  );
}

function Key({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="mx-0.5 inline-block rounded border border-neutral-700 px-1 text-[10px] text-neutral-500">
      {children}
    </kbd>
  );
}
