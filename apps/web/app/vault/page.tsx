'use client';

/**
 * The vault workspace: note tree (left), editor + preview (center), backlinks
 * (right). Autosaves edits to the local store, supports `[[wikilink]]`
 * navigation/creation, and a keyboard shortcut (Cmd/Ctrl+E) to toggle preview.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { BacklinksPanel } from '../../components/BacklinksPanel';
import { MarkdownEditor } from '../../components/MarkdownEditor';
import { MarkdownPreview } from '../../components/MarkdownPreview';
import { NoteTree } from '../../components/NoteTree';
import { SearchBox } from '../../components/SearchBox';
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
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedPath = useRef<NotePath | null>(null);

  const activeNote = activePath ? vault.getNote(activePath) : undefined;

  // Honor a `?note=<path>` deep link (e.g. "Open note" from the graph view)
  // once, on first load, before falling back to the first note.
  const appliedQueryNote = useRef(false);

  // Pick the initial note once the vault loads.
  useEffect(() => {
    if (!vault.ready) return;
    if (!appliedQueryNote.current) {
      appliedQueryNote.current = true;
      const requested = new URLSearchParams(window.location.search).get('note');
      if (requested && vault.getNote(requested as NotePath)) {
        setActivePath(requested as NotePath);
        return;
      }
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

  // Cmd/Ctrl+E toggles between edit and preview.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        setView((v) => (v === 'preview' ? 'edit' : 'preview'));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
      {/* Note list */}
      <div className="flex w-64 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950">
        <div className="flex items-center justify-between px-3 py-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Notes ({vault.notes.length})
          </span>
          <button
            type="button"
            onClick={handleNew}
            className="rounded bg-neutral-800 px-2 py-0.5 text-xs text-neutral-200 hover:bg-neutral-700"
          >
            + New
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-1 pb-3">
          <NoteTree notes={vault.notes} activePath={activePath} onSelect={openPath} />
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
                <MarkdownEditor value={draft} notes={vault.notes} onChange={onDraftChange} />
              </div>
            )}
            {(view === 'preview' || view === 'split') && (
              <div className="min-w-0 flex-1">
                <MarkdownPreview
                  markdown={draft}
                  resolve={vault.resolveLink}
                  onNavigate={onNavigate}
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

      {activeNote && (
        <BacklinksPanel
          note={activeNote}
          backlinks={backlinks}
          resolveLink={vault.resolveLink}
          onOpen={openPath}
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
