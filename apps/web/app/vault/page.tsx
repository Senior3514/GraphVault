'use client';

/**
 * The vault workspace: note tree + tags (left), editor + preview (center),
 * backlinks/outline (right). Autosaves edits to the local store, supports
 * `[[wikilink]]` navigation/creation and clickable `#tags`, opens a note from a
 * `?note=<encoded-path>` deep link (used by the graph view), and offers a
 * keyboard shortcut (Cmd/Ctrl+E) to toggle the preview pane.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { TOGGLE_PREVIEW_EVENT } from '../../components/CommandPalette';
import { BacklinksPanel } from '../../components/BacklinksPanel';
import { MarkdownEditor } from '../../components/MarkdownEditor';
import { MarkdownPreview } from '../../components/MarkdownPreview';
import { NoteTree } from '../../components/NoteTree';
import { SearchBox } from '../../components/SearchBox';
import { TagList } from '../../components/TagList';
import { VaultError } from '../../lib/vault/vault';
import { useVaultContext } from '../../lib/vault/VaultProvider';
import type { NotePath } from '../../lib/vault/types';

type ViewMode = 'edit' | 'preview' | 'split';

const AUTOSAVE_MS = 400;

export default function VaultPage() {
  const vault = useVaultContext();
  const [activePath, setActivePath] = useState<NotePath | null>(null);
  const [draft, setDraft] = useState('');
  const [view, setView] = useState<ViewMode>('split');
  const [error, setError] = useState<string | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [showPanel, setShowPanel] = useState(true);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedPath = useRef<NotePath | null>(null);

  const activeNote = activePath ? vault.getNote(activePath) : undefined;

  // Honor a `?note=<encodeURIComponent(path)>` deep link (e.g. the graph view's
  // "Open note") once, on first load, before falling back to the first note.
  const appliedQueryNote = useRef(false);

  // Tag names (no leading `#`) for the editor's `#` autocomplete.
  const tagNames = useMemo(() => vault.tags.map((t) => t.tag), [vault.tags]);

  // The note list, narrowed to the active tag filter when one is set.
  const visibleNotes = useMemo(() => {
    if (!tagFilter) return vault.notes;
    const paths = new Set(vault.notesWithTag(tagFilter));
    return vault.notes.filter((n) => paths.has(n.path));
  }, [vault, tagFilter]);

  // Pick the initial note once the vault loads.
  useEffect(() => {
    if (!vault.ready) return;
    if (!appliedQueryNote.current) {
      appliedQueryNote.current = true;
      // The graph view links to `/vault?note=${encodeURIComponent(node.path)}`,
      // so the param is URI-component-encoded; URLSearchParams decodes it.
      const requested = new URLSearchParams(window.location.search).get('note');
      if (requested && vault.getNote(requested as NotePath)) {
        setActivePath(requested as NotePath);
        return;
      }
      // Unknown / missing target falls through to the default selection below —
      // no crash, graceful fallback.
    }
    if (activePath && vault.getNote(activePath)) return;
    setActivePath(vault.notes[0]?.path ?? null);
  }, [vault.ready, vault.notes, activePath, vault]);

  // Load the active note's content into the editor draft only when the selected
  // note actually changes. Tracking the loaded path via a ref means autosave
  // re-renders (which keep the same path) don't clobber in-flight keystrokes.
  useEffect(() => {
    if (activePath !== loadedPath.current) {
      loadedPath.current = activePath;
      setDraft(activeNote?.content ?? '');
    }
  }, [activePath, activeNote]);

  // Debounced autosave of the draft back into the vault.
  const flushSave = useCallback(
    (path: NotePath, content: string) => {
      try {
        vault.updateContent(path, content);
      } catch {
        /* note may have been deleted mid-edit; ignore */
      }
    },
    [vault],
  );

  const onDraftChange = useCallback(
    (next: string) => {
      setDraft(next);
      if (!activePath) return;
      if (saveTimer.current) clearTimeout(saveTimer.current);
      const path = activePath;
      saveTimer.current = setTimeout(() => flushSave(path, next), AUTOSAVE_MS);
    },
    [activePath, flushSave],
  );

  // Flush pending save on note switch / unmount to avoid losing keystrokes.
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const openPath = useCallback(
    (path: NotePath) => {
      if (activePath && saveTimer.current) {
        clearTimeout(saveTimer.current);
        flushSave(activePath, draft);
      }
      setActivePath(path);
      setError(null);
    },
    [activePath, draft, flushSave],
  );

  // Wikilink navigation: open the target, or create it if it doesn't exist.
  const onNavigate = useCallback(
    (target: string) => {
      const resolved = vault.resolveLink(target);
      if (resolved) {
        openPath(resolved);
        return;
      }
      try {
        const created = vault.createNote(target, `# ${target}\n`);
        openPath(created.path);
      } catch (err) {
        setError(err instanceof VaultError ? err.message : 'Could not create note.');
      }
    },
    [vault, openPath],
  );

  // Clicking a tag in the preview filters the note list by that tag.
  const onTag = useCallback((tag: string) => {
    setTagFilter((prev) => (prev === tag ? null : tag));
  }, []);

  const toggleTagFilter = useCallback((tag: string) => {
    setTagFilter((prev) => (prev === tag ? null : tag));
  }, []);

  // Cmd/Ctrl+E (and the palette's "Toggle preview") flip between edit/preview.
  useEffect(() => {
    const togglePreview = () => setView((v) => (v === 'preview' ? 'edit' : 'preview'));
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        togglePreview();
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(TOGGLE_PREVIEW_EVENT, togglePreview);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(TOGGLE_PREVIEW_EVENT, togglePreview);
    };
  }, []);

  const backlinks = useMemo(
    () => (activePath ? vault.backlinksFor(activePath) : []),
    [activePath, vault],
  );

  const handleNew = () => {
    const name = window.prompt('New note path (e.g. notes/idea):');
    if (!name) return;
    try {
      const created = vault.createNote(name);
      openPath(created.path);
    } catch (err) {
      setError(err instanceof VaultError ? err.message : 'Could not create note.');
    }
  };

  const handleRename = () => {
    if (!activePath) return;
    const next = window.prompt('Rename / move note to:', activePath.replace(/\.md$/i, ''));
    if (!next) return;
    try {
      const newPath = vault.renameNote(activePath, next);
      setActivePath(newPath);
    } catch (err) {
      setError(err instanceof VaultError ? err.message : 'Could not rename note.');
    }
  };

  const handleDelete = () => {
    if (!activePath) return;
    if (!window.confirm(`Delete "${activePath}"? This cannot be undone here.`)) return;
    vault.deleteNote(activePath);
    setActivePath(null);
  };

  if (!vault.ready) {
    return <div className="p-8 text-sm text-neutral-500">Loading vault…</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-1">
      {/* Note list + tags */}
      <div className="flex w-64 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950">
        <div className="flex items-center justify-between px-3 py-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Notes ({visibleNotes.length})
          </span>
          <button
            type="button"
            onClick={handleNew}
            className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200 hover:bg-neutral-700"
          >
            + New
          </button>
        </div>

        {vault.tags.length > 0 && (
          <div className="border-b border-neutral-900 pb-2">
            <div className="flex items-center justify-between px-3 pb-1 pt-1">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-neutral-600">
                Tags
              </span>
              {tagFilter && (
                <button
                  type="button"
                  onClick={() => setTagFilter(null)}
                  className="text-[11px] text-sky-400 hover:text-sky-300"
                >
                  Clear
                </button>
              )}
            </div>
            <div className="max-h-32 overflow-auto">
              <TagList tags={vault.tags} activeTag={tagFilter} onToggle={toggleTagFilter} />
            </div>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto px-1 py-2">
          {tagFilter && visibleNotes.length === 0 ? (
            <p className="px-3 py-4 text-xs text-neutral-600">
              No notes tagged <span className="text-neutral-400">#{tagFilter}</span>.
            </p>
          ) : (
            <NoteTree notes={visibleNotes} activePath={activePath} onSelect={openPath} />
          )}
        </div>
      </div>

      {/* Editor column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-neutral-800 px-4 py-2">
          <div className="min-w-0">
            <h1 className="truncate text-sm font-medium text-neutral-100">
              {activeNote?.parsed.title ?? 'No note selected'}
            </h1>
            {activePath && <p className="truncate text-xs text-neutral-600">{activePath}</p>}
          </div>
          <div className="flex items-center gap-3">
            <SearchBox search={vault.search} onOpen={openPath} />
            <ViewToggle view={view} setView={setView} />
            {activePath && (
              <div className="flex items-center gap-1">
                <ToolbarButton onClick={handleRename}>Rename</ToolbarButton>
                <ToolbarButton onClick={handleDelete}>Delete</ToolbarButton>
              </div>
            )}
            <button
              type="button"
              onClick={() => setShowPanel((s) => !s)}
              aria-pressed={showPanel}
              title={showPanel ? 'Hide details panel' : 'Show details panel'}
              className={[
                'rounded p-1.5 transition-colors',
                showPanel
                  ? 'text-sky-400 hover:bg-neutral-800'
                  : 'text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300',
              ].join(' ')}
            >
              <PanelIcon className="h-4 w-4" />
            </button>
          </div>
        </header>

        {error && (
          <div className="border-b border-red-900/50 bg-red-950/40 px-4 py-2 text-xs text-red-300">
            {error}
          </div>
        )}

        {activeNote ? (
          <div className="flex min-h-0 flex-1">
            {(view === 'edit' || view === 'split') && (
              <div
                className={
                  view === 'split' ? 'min-w-0 flex-1 border-r border-neutral-800' : 'min-w-0 flex-1'
                }
              >
                <MarkdownEditor
                  value={draft}
                  notes={vault.notes}
                  tags={tagNames}
                  onChange={onDraftChange}
                />
              </div>
            )}
            {(view === 'preview' || view === 'split') && (
              <div className="min-w-0 flex-1">
                <MarkdownPreview
                  markdown={draft}
                  resolve={vault.resolveLink}
                  onNavigate={onNavigate}
                  onTag={onTag}
                />
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-neutral-600">
            Select a note or create a new one.
          </div>
        )}
      </div>

      {activeNote && showPanel && (
        <BacklinksPanel
          note={activeNote}
          backlinks={backlinks}
          resolveLink={vault.resolveLink}
          onOpen={openPath}
          onTag={onTag}
        />
      )}
    </div>
  );
}

function ViewToggle({ view, setView }: { view: ViewMode; setView(v: ViewMode): void }) {
  const opts: ViewMode[] = ['edit', 'split', 'preview'];
  return (
    <div className="flex overflow-hidden rounded-md border border-neutral-800">
      {opts.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => setView(opt)}
          title={opt === 'preview' ? 'Preview (Cmd/Ctrl+E)' : opt}
          className={[
            'px-2.5 py-1 text-xs capitalize transition-colors',
            view === opt
              ? 'bg-neutral-700 text-neutral-100'
              : 'bg-neutral-900 text-neutral-400 hover:text-neutral-200',
          ].join(' ')}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function ToolbarButton({ onClick, children }: { onClick(): void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-200"
    >
      {children}
    </button>
  );
}

function PanelIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2" stroke="currentColor" strokeWidth="1.7" />
      <path d="M15 4v16" stroke="currentColor" strokeWidth="1.7" />
    </svg>
  );
}
