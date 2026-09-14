'use client';

/**
 * The vault workspace with the full Obsidian-grade multi-pane layout.
 *
 * Layout:
 *   [Note list pane] | [Editor pane with tabs + split] | [Details/Backlinks pane]
 *
 * Each pane is resizable (drag dividers), collapsible, and maximizable.
 * Open tabs are remembered across page reloads via localStorage.
 * Autosave is per-tab and flushes before any tab switch or unmount.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AddButton } from '../../components/AddButton';
import { TOGGLE_PREVIEW_EVENT } from '../../components/CommandPalette';
import { BacklinksPanel } from '../../components/BacklinksPanel';
import { MarkdownEditor } from '../../components/MarkdownEditor';
import { MarkdownPreview } from '../../components/MarkdownPreview';
import { NoteHierarchyTree } from '../../components/NoteHierarchyTree';
import { NoteTree } from '../../components/NoteTree';
import { SearchBox } from '../../components/SearchBox';
import { TabBar } from '../../components/workspace/TabBar';
import {
  PaneHeader,
  WorkspaceLayout,
  type MobilePane,
} from '../../components/workspace/WorkspaceLayout';
import { useLayout } from '../../lib/layout/useLayout';
import { registerFlushOnExit } from '../../lib/vault/flushOnExit';
import { VaultError } from '../../lib/vault/vault';
import { nextUntitledName } from '../../lib/vault/untitled';
import { setFrontmatterField } from '../../lib/vault/parse';
import { useVaultContext } from '../../lib/vault/VaultProvider';
import type { NotePath } from '../../lib/vault/types';

const AUTOSAVE_MS = 400;

/** Persisted choice between the folder-based tree and the CherryTree-style
 *  parent/child note hierarchy in the sidebar's note list pane. */
const NOTE_LIST_VIEW_KEY = 'graphvault.noteListView';
type NoteListView = 'folders' | 'hierarchy';

// ---- Per-tab draft store (kept outside React to avoid re-renders) -----------

/** Holds the unsaved draft text keyed by tab ID. */
const draftStore = new Map<string, string>();

function getDraft(tabId: string): string {
  return draftStore.get(tabId) ?? '';
}
function setDraftStore(tabId: string, text: string): void {
  draftStore.set(tabId, text);
}

// ---- Main page --------------------------------------------------------------

export default function VaultPage() {
  const vault = useVaultContext();
  const actions = useLayout();
  const { layout } = actions;

  // Error banner
  const [error, setError] = useState<string | null>(null);

  // Which pane is visible on mobile (<md). Lifted out of WorkspaceLayout so
  // opening a note (from the list, search, a wikilink, ...) can jump straight
  // to the editor pane - otherwise selecting a note on a phone silently did
  // nothing visible, since the note list pane stayed on screen underneath it.
  const [mobilePane, setMobilePane] = useState<MobilePane>('editor');

  // Note list pane: folder tree (default) vs. CherryTree-style note hierarchy.
  // Starts at the SSR-stable default and reads the persisted preference in an
  // effect (not the useState initializer) - matching the app's established
  // pattern for anything localStorage-derived, since resolving it during
  // render would render different markup on the server (no window) vs the
  // client's first paint and cause a React hydration mismatch.
  const [noteListView, setNoteListView] = useState<NoteListView>('folders');
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(NOTE_LIST_VIEW_KEY);
      if (stored === 'hierarchy') setNoteListView('hierarchy');
    } catch {
      /* storage unavailable - keep the folders default */
    }
  }, []);
  const setNoteListViewPersisted = useCallback((view: NoteListView) => {
    setNoteListView(view);
    try {
      window.localStorage.setItem(NOTE_LIST_VIEW_KEY, view);
    } catch {
      /* best-effort persistence only */
    }
  }, []);

  // Active tab draft (what's in the editor right now).
  const [draft, setDraftState] = useState('');
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const loadedTabId = useRef<string | null>(null);

  // Flush all pending saves (call before tab switch / unmount).
  // Uses vault.updateContent - safe for in-session flushes where React's
  // async effect pipeline is still running (tab switch, unmount, etc.).
  const flushAll = useCallback(() => {
    for (const [tabId, timer] of Object.entries(saveTimers.current)) {
      clearTimeout(timer);
      delete saveTimers.current[tabId];
      const tab = layout.tabs.find((t) => t.id === tabId);
      if (tab?.notePath) {
        try {
          vault.updateContent(tab.notePath as NotePath, getDraft(tabId));
        } catch {
          /* note may have been deleted */
        }
      }
    }
  }, [layout.tabs, vault]);

  // Flush all pending saves directly to storage - used by beforeunload and
  // visibilitychange=hidden where React's useEffect may not fire before the
  // page unloads.  vault.directFlush bypasses the setRawNotes→useEffect chain
  // and writes synchronously to the adapter.
  const flushAllDirect = useCallback(() => {
    const updates: Array<{ path: NotePath; content: string }> = [];
    for (const [tabId, timer] of Object.entries(saveTimers.current)) {
      clearTimeout(timer);
      delete saveTimers.current[tabId];
      const tab = layout.tabs.find((t) => t.id === tabId);
      if (tab?.notePath) {
        updates.push({ path: tab.notePath as NotePath, content: getDraft(tabId) });
      }
    }
    // directFlush returns a Promise but localStorage.setItem (the underlying
    // adapter write) is synchronous, so the write completes before unload.
    void vault.directFlush(updates);
  }, [layout.tabs, vault]);

  // ---- Initial tab bootstrap ------------------------------------------------
  // When the vault first loads, if there are persisted tabs rehydrate their
  // draft content from the vault store; if no tabs exist, open the first note.
  const bootstrapped = useRef(false);
  useEffect(() => {
    if (!vault.ready || bootstrapped.current) return;
    bootstrapped.current = true;

    // ?new= deep-link (e.g. from the browser extension's "Send to GraphVault"):
    // create a note from the clipped Markdown and open it. Content is rendered
    // through the DOMPurify-sanitised markdown path, so it is safe to store.
    const clipped = new URLSearchParams(window.location.search).get('new');
    if (clipped) {
      try {
        const content = decodeURIComponent(clipped);
        const h1 = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
        const base = (h1 || `Clipping ${new Date().toISOString().slice(0, 10)}`)
          .replace(/[\\/:*?"<>|]+/g, '-')
          .slice(0, 80)
          .trim();
        let path = `${base}.md`;
        for (let i = 2; vault.getNote(path as NotePath); i++) path = `${base} (${i}).md`;
        const created = vault.createNote(path, content);
        actions.openTab(created.path, h1 || base);
        window.history.replaceState({}, '', '/vault');
        return;
      } catch {
        // Fall through to normal bootstrap if the clip can't be created.
      }
    }

    if (layout.tabs.length > 0) {
      // Rehydrate drafts from vault for each persisted tab.
      for (const tab of layout.tabs) {
        if (tab.notePath) {
          const note = vault.getNote(tab.notePath as NotePath);
          setDraftStore(tab.id, note?.content ?? '');
          // Also sync the title in case the note was renamed while the app was closed.
          if (note && note.parsed.title !== tab.title) {
            actions.updateTabTitle(tab.id, note.parsed.title);
          }
        }
      }
      // Load the active tab's draft into the editor.
      const active = layout.activeTabId
        ? layout.tabs.find((t) => t.id === layout.activeTabId)
        : null;
      if (active) setDraftState(getDraft(active.id));
      return;
    }

    // No tabs yet: check for ?note= deep-link or open the first note.
    const requested = new URLSearchParams(window.location.search).get('note');
    const firstPath =
      requested && vault.getNote(requested as NotePath) ? requested : vault.notes[0]?.path;
    if (firstPath) {
      const note = vault.getNote(firstPath as NotePath);
      actions.openTab(firstPath, note?.parsed.title ?? firstPath);
    }
  }, [vault.ready, vault.notes, vault, layout.tabs, layout.activeTabId, actions]);

  // ---- Load active tab's draft into editor when tab changes -----------------
  const activeTab = layout.tabs.find((t) => t.id === layout.activeTabId) ?? null;
  useEffect(() => {
    if (!activeTab) return;
    if (activeTab.id === loadedTabId.current) return;
    loadedTabId.current = activeTab.id;
    setDraftState(getDraft(activeTab.id));
  }, [activeTab]);

  // ---- Autosave -------------------------------------------------------------
  const flushSave = useCallback(
    (tabId: string) => {
      const tab = layout.tabs.find((t) => t.id === tabId);
      if (!tab?.notePath) return;
      try {
        vault.updateContent(tab.notePath as NotePath, getDraft(tabId));
      } catch {
        /* deleted note */
      }
      actions.markTabDirty(tabId, false);
    },
    [layout.tabs, vault, actions],
  );

  const onDraftChange = useCallback(
    (next: string) => {
      setDraftState(next);
      if (!activeTab) return;
      setDraftStore(activeTab.id, next);
      actions.markTabDirty(activeTab.id, true);
      const tabId = activeTab.id;
      if (saveTimers.current[tabId]) clearTimeout(saveTimers.current[tabId]);
      saveTimers.current[tabId] = setTimeout(() => {
        flushSave(tabId);
      }, AUTOSAVE_MS);
    },
    [activeTab, actions, flushSave],
  );

  // Flush on unmount.
  useEffect(() => {
    return () => flushAll();
  }, [flushAll]);

  // Flush on hard tab close / navigation away and on the tab being backgrounded
  // (mobile). Uses flushAllDirect (not flushAll) because beforeunload /
  // visibilitychange handlers must write to storage NOW - React's useEffect
  // pipeline is async and may not fire before the browser unloads the page.
  // vault.directFlush writes directly to the adapter, bypassing setRawNotes.
  useEffect(() => registerFlushOnExit(flushAllDirect), [flushAllDirect]);

  // ---- Tab actions ----------------------------------------------------------
  const switchTab = useCallback(
    (tabId: string) => {
      // Flush pending save for current tab before switching.
      if (activeTab && saveTimers.current[activeTab.id]) {
        clearTimeout(saveTimers.current[activeTab.id]);
        delete saveTimers.current[activeTab.id];
        flushSave(activeTab.id);
      }
      actions.activateTab(tabId);
    },
    [activeTab, actions, flushSave],
  );

  const openPath = useCallback(
    (path: NotePath) => {
      // On mobile, opening a note should always bring the editor into view -
      // a no-op on desktop, which ignores `mobilePane` entirely.
      setMobilePane('editor');
      const note = vault.getNote(path);
      const title = note?.parsed.title ?? path;
      // If tab already exists, switch; otherwise flush + open.
      const existing = layout.tabs.find((t) => t.notePath === path);
      if (existing) {
        switchTab(existing.id);
        return;
      }
      if (activeTab && saveTimers.current[activeTab.id]) {
        clearTimeout(saveTimers.current[activeTab.id]);
        delete saveTimers.current[activeTab.id];
        flushSave(activeTab.id);
      }
      // Pre-load the draft from vault.
      const content = note?.content ?? '';
      actions.openTab(path, title);
      // The tab id isn't available yet; we'll load the draft in the useEffect
      // that fires when activeTabId changes.
      // We need to set the draft in draftStore by path for the next tab - but
      // we don't have the id yet. We store by path and pick up in bootstrap effect.
      // Simpler: store draft immediately under a temp key matched by path.
      // Instead: scan for the new tab after the update.
      requestAnimationFrame(() => {
        // At this point the state has updated. Find the new tab by path.
        // This is a best-effort; the useEffect above also handles it.
        setDraftState(content);
      });
      setDraftStore('__pending__', content);
      setError(null);
    },
    [vault, layout.tabs, activeTab, actions, flushSave, switchTab],
  );

  // Set or clear a note's CherryTree-style hierarchy parent (a `parent:`
  // frontmatter field) from the details panel's picker. Rewrites only that
  // one field via setFrontmatterField, preserving everything else - then
  // persists through the normal updateContent path, same as any other edit,
  // so autosave/sync/backups all see it consistently.
  //
  // The details panel only ever shows this picker for the currently active
  // note, so `path` here is always `activeTab.notePath` in practice - which
  // means the basis content MUST be the live `draft` state (possibly unsaved
  // keystrokes the user just typed), never `vault.getNote(path).content` (the
  // last-PERSISTED version). Using the persisted version would silently
  // discard any in-progress edit the moment the parent picker is used - the
  // exact class of data loss this project never allows.
  const setNoteParent = useCallback(
    (path: NotePath, value: string | null) => {
      const isActiveNote = activeTab?.notePath === path;
      const baseContent = isActiveNote ? draft : vault.getNote(path)?.content;
      if (baseContent === undefined) return;
      const nextContent = setFrontmatterField(baseContent, 'parent', value);
      vault.updateContent(path, nextContent);
      if (isActiveNote) {
        setDraftState(nextContent);
        setDraftStore(activeTab!.id, nextContent);
      }
    },
    [vault, activeTab, draft],
  );

  // When a new tab is created (activeTabId changes to an id not yet in loadedTabId),
  // load its draft.
  const prevTabsLength = useRef(layout.tabs.length);
  useEffect(() => {
    if (layout.tabs.length > prevTabsLength.current) {
      prevTabsLength.current = layout.tabs.length;
      // New tab just added - find it and load draft.
      const newTab = layout.tabs.find((t) => t.id === layout.activeTabId);
      if (newTab && newTab.notePath) {
        // Check if we have a pending draft (set by openPath before the tab id was known).
        const pending = draftStore.get('__pending__');
        if (pending !== undefined) {
          setDraftStore(newTab.id, pending);
          draftStore.delete('__pending__');
          setDraftState(pending);
        } else {
          const content = vault.getNote(newTab.notePath as NotePath)?.content ?? '';
          setDraftStore(newTab.id, content);
          setDraftState(content);
        }
        loadedTabId.current = newTab.id;
      }
    }
    prevTabsLength.current = layout.tabs.length;
  }, [layout.tabs, layout.activeTabId, vault]);

  const closeTab = useCallback(
    (tabId: string) => {
      // Flush before closing.
      if (saveTimers.current[tabId]) {
        clearTimeout(saveTimers.current[tabId]);
        delete saveTimers.current[tabId];
      }
      const tab = layout.tabs.find((t) => t.id === tabId);
      if (tab?.notePath) {
        try {
          vault.updateContent(tab.notePath as NotePath, getDraft(tabId));
        } catch {
          /* deleted */
        }
      }
      draftStore.delete(tabId);
      actions.closeTab(tabId);
    },
    [layout.tabs, vault, actions],
  );

  const openNewTab = useCallback(() => {
    // The "+" must ALWAYS add a working tab. Create a fresh, collision-safe
    // untitled note and open it - never a no-op, even when the vault is empty
    // or the first note is already open. (Previously this opened the first
    // existing note, which did nothing when that tab was already active or when
    // there were no notes yet.)
    try {
      const path = nextUntitledName(vault.notes.map((n) => n.path));
      const created = vault.createNote(path, '');
      openPath(created.path as NotePath);
      setError(null);
    } catch (err) {
      setError(err instanceof VaultError ? err.message : 'Could not create note.');
    }
  }, [vault, openPath]);

  // ---- Wikilink navigation --------------------------------------------------
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

  // ---- Toolbar actions ------------------------------------------------------
  const handleRename = () => {
    if (!activeTab?.notePath) return;
    const next = window.prompt('Rename / move note to:', activeTab.notePath.replace(/\.md$/i, ''));
    if (!next) return;
    try {
      const newPath = vault.renameNote(activeTab.notePath as NotePath, next);
      const note = vault.getNote(newPath);
      actions.updateTabTitle(activeTab.id, note?.parsed.title ?? newPath);
    } catch (err) {
      setError(err instanceof VaultError ? err.message : 'Could not rename note.');
    }
  };

  const handleDelete = () => {
    if (!activeTab?.notePath) return;
    if (!window.confirm(`Delete "${activeTab.notePath}"? This cannot be undone here.`)) return;
    vault.deleteNote(activeTab.notePath as NotePath);
    closeTab(activeTab.id);
  };

  // ---- Toggle preview (Cmd/Ctrl+E and the command palette) -------------------
  // Both the keyboard shortcut and the "Toggle preview" command-palette action
  // (which broadcasts TOGGLE_PREVIEW_EVENT) flip the editor-preview split. The
  // palette path previously had no listener, so the command was a silent no-op.
  useEffect(() => {
    const togglePreview = () => {
      actions.setSplitMode(layout.splitMode === 'editor-preview' ? 'none' : 'editor-preview');
    };
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
  }, [layout.splitMode, actions]);

  // ---- Derived values -------------------------------------------------------
  const activeNote = activeTab?.notePath
    ? vault.getNote(activeTab.notePath as NotePath)
    : undefined;

  const backlinks = useMemo(
    () => (activeTab?.notePath ? vault.backlinksFor(activeTab.notePath as NotePath) : []),
    [activeTab, vault],
  );

  // Known tag names (no leading `#`) for the editor's `#tag` autocomplete.
  const tagNames = useMemo(() => vault.tags.map((t) => t.tag), [vault.tags]);

  // Secondary tab for two-notes split.
  const secondaryTab = layout.tabs.find((t) => t.id === layout.secondaryTabId) ?? null;
  const secondaryNote = secondaryTab?.notePath
    ? vault.getNote(secondaryTab.notePath as NotePath)
    : undefined;
  const secondaryDraft = secondaryTab ? getDraft(secondaryTab.id) : '';

  if (!vault.ready) {
    return <div className="p-8 text-sm text-neutral-500">Loading vault…</div>;
  }

  // ---- Render ---------------------------------------------------------------

  const noteListSlot = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="text-xs text-neutral-500">
          {vault.notes.length} {vault.notes.length === 1 ? 'note' : 'notes'}
        </span>
        <div className="flex items-center gap-1">
          {/* Folders vs. CherryTree-style note hierarchy (a `parent:`
              frontmatter field, independent of the folder a note lives in). */}
          <div
            role="group"
            aria-label="Note list view"
            className="flex rounded-md border border-neutral-800 bg-neutral-900/60 p-0.5 text-xs"
          >
            <button
              type="button"
              onClick={() => setNoteListViewPersisted('folders')}
              aria-pressed={noteListView === 'folders'}
              className={[
                'rounded px-2 py-0.5 transition-colors',
                noteListView === 'folders'
                  ? 'bg-neutral-700 text-neutral-100'
                  : 'text-neutral-500 hover:text-neutral-300',
              ].join(' ')}
            >
              Folders
            </button>
            <button
              type="button"
              onClick={() => setNoteListViewPersisted('hierarchy')}
              aria-pressed={noteListView === 'hierarchy'}
              title="Nest notes under a parent note via a `parent:` frontmatter field, independent of folders"
              className={[
                'rounded px-2 py-0.5 transition-colors',
                noteListView === 'hierarchy'
                  ? 'bg-neutral-700 text-neutral-100'
                  : 'text-neutral-500 hover:text-neutral-300',
              ].join(' ')}
            >
              Hierarchy
            </button>
          </div>
          <AddButton variant="inline" onNoteCreated={openPath} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-3">
        {noteListView === 'hierarchy' ? (
          <NoteHierarchyTree
            notes={vault.notes}
            activePath={(activeTab?.notePath as NotePath) ?? null}
            onSelect={openPath}
          />
        ) : (
          <NoteTree
            notes={vault.notes}
            activePath={(activeTab?.notePath as NotePath) ?? null}
            onSelect={openPath}
          />
        )}
      </div>
    </div>
  );

  const editorSlot = (
    <div className="flex h-full flex-col">
      {/* Tab bar */}
      {layout.tabs.length > 0 && (
        <TabBar
          tabs={layout.tabs}
          activeTabId={layout.activeTabId}
          splitMode={layout.splitMode}
          secondaryTabId={layout.secondaryTabId}
          onActivate={switchTab}
          onClose={closeTab}
          onNew={openNewTab}
          onReorder={actions.reorderTabs}
          onSplitMode={actions.setSplitMode}
          onSetSecondary={actions.setSecondaryTab}
        />
      )}

      {/* Editor header - wraps on very narrow screens to avoid overflow */}
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-neutral-800 px-3 py-2">
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-medium text-neutral-100">
            {activeNote?.parsed.title ?? 'No note selected'}
          </h1>
          {activeTab?.notePath && (
            <p className="truncate text-xs text-neutral-600">{activeTab.notePath}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <SearchBox search={vault.search} onOpen={openPath} />
          <PaneHeader
            title=""
            paneId="editor"
            maximized={layout.maximized}
            onMaximize={() => actions.maximizePane('editor')}
            onRestore={actions.restorePane}
          >
            {activeTab?.notePath && (
              <div className="flex items-center gap-1">
                <ToolbarButton onClick={handleRename}>Rename</ToolbarButton>
                <ToolbarButton onClick={handleDelete}>Delete</ToolbarButton>
              </div>
            )}
          </PaneHeader>
        </div>
      </header>

      {error && (
        <div className="shrink-0 border-b border-red-900/50 bg-red-950/40 px-4 py-2 text-xs text-red-300">
          {error}
        </div>
      )}

      {/* Editor body */}
      {activeNote ? (
        <EditorBody
          draft={draft}
          splitMode={layout.splitMode}
          activeNote={activeNote}
          secondaryNote={secondaryNote}
          secondaryDraft={secondaryDraft}
          notes={vault.notes}
          tags={tagNames}
          resolveLink={vault.resolveLink}
          onDraftChange={onDraftChange}
          onNavigate={onNavigate}
        />
      ) : (
        <div className="flex flex-1 items-center justify-center text-sm text-neutral-600">
          Select a note or create a new one.
        </div>
      )}
    </div>
  );

  const detailsSlot = activeNote ? (
    <BacklinksPanel
      note={activeNote}
      backlinks={backlinks}
      allNotes={vault.notes}
      resolveLink={vault.resolveLink}
      onOpen={openPath}
      onSetParent={setNoteParent}
    />
  ) : (
    <div className="p-4 text-xs text-neutral-600">Open a note to see details.</div>
  );

  return (
    <WorkspaceLayout
      actions={actions}
      noteListSlot={noteListSlot}
      editorSlot={editorSlot}
      detailsSlot={detailsSlot}
      mobilePane={mobilePane}
      onMobilePaneChange={setMobilePane}
    />
  );
}

// ---- EditorBody -------------------------------------------------------------

interface EditorBodyProps {
  draft: string;
  splitMode: 'none' | 'editor-preview' | 'two-notes';
  activeNote: { parsed: { title: string } };
  secondaryNote?: { content: string; parsed: { title: string } };
  secondaryDraft: string;
  notes: import('../../lib/vault/types').IndexedNote[];
  tags: string[];
  resolveLink(target: string): NotePath | null;
  onDraftChange(v: string): void;
  onNavigate(target: string): void;
}

function EditorBody({
  draft,
  splitMode,
  activeNote: _activeNote,
  secondaryNote,
  secondaryDraft,
  notes,
  tags,
  resolveLink,
  onDraftChange,
  onNavigate,
}: EditorBodyProps) {
  // On narrow viewports (< md) split view collapses to single editor.
  // We detect this with a media query so we don't break SSR.
  // The split pane controls are already hidden in TabBar on mobile, so users
  // won't inadvertently trigger split mode; this is a belt-and-suspenders guard.

  if (splitMode === 'editor-preview') {
    return (
      <div className="flex min-h-0 flex-1">
        {/* Editor - takes full width on mobile (split collapses) */}
        <div className="min-w-0 flex-1 md:border-r md:border-neutral-800">
          <MarkdownEditor value={draft} notes={notes} tags={tags} onChange={onDraftChange} />
        </div>
        {/* Preview - hidden on mobile in split mode */}
        <div className="hidden min-w-0 flex-1 overflow-auto md:block">
          <MarkdownPreview markdown={draft} resolve={resolveLink} onNavigate={onNavigate} />
        </div>
      </div>
    );
  }

  if (splitMode === 'two-notes' && secondaryNote) {
    return (
      <div className="flex min-h-0 flex-1">
        {/* Primary editor - takes full width on mobile */}
        <div className="min-w-0 flex-1 md:border-r md:border-neutral-800">
          <MarkdownEditor value={draft} notes={notes} tags={tags} onChange={onDraftChange} />
        </div>
        {/* Secondary note - hidden on mobile in split mode */}
        <div className="hidden min-w-0 flex-1 overflow-auto md:block">
          <MarkdownPreview
            markdown={secondaryDraft || secondaryNote.content}
            resolve={resolveLink}
            onNavigate={onNavigate}
          />
        </div>
      </div>
    );
  }

  // Default: single editor.
  return (
    <div className="min-h-0 flex-1">
      <MarkdownEditor value={draft} notes={notes} tags={tags} onChange={onDraftChange} />
    </div>
  );
}

// ---- ToolbarButton ----------------------------------------------------------

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
