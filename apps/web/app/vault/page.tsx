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
import { BacklinksPanel } from '../../components/BacklinksPanel';
import { MarkdownEditor } from '../../components/MarkdownEditor';
import { MarkdownPreview } from '../../components/MarkdownPreview';
import { NoteTree } from '../../components/NoteTree';
import { SearchBox } from '../../components/SearchBox';
import { TabBar } from '../../components/workspace/TabBar';
import { PaneHeader, WorkspaceLayout } from '../../components/workspace/WorkspaceLayout';
import { useLayout } from '../../lib/layout/useLayout';
import { registerFlushOnExit } from '../../lib/vault/flushOnExit';
import { VaultError } from '../../lib/vault/vault';
import { useVaultContext } from '../../lib/vault/VaultProvider';
import type { NotePath } from '../../lib/vault/types';

const AUTOSAVE_MS = 400;

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
    // Open a blank note (or the first note we find as default).
    const firstNote = vault.notes[0];
    if (firstNote) openPath(firstNote.path);
  }, [vault.notes, openPath]);

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

  // ---- Keyboard shortcut (Cmd/Ctrl+E) ---------------------------------------
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'e') {
        e.preventDefault();
        actions.setSplitMode(layout.splitMode === 'editor-preview' ? 'none' : 'editor-preview');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
      <div className="flex items-center justify-between px-3 py-2">
        <span className="text-xs text-neutral-500">
          {vault.notes.length} {vault.notes.length === 1 ? 'note' : 'notes'}
        </span>
        <AddButton variant="inline" onNoteCreated={openPath} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-3">
        <NoteTree
          notes={vault.notes}
          activePath={(activeTab?.notePath as NotePath) ?? null}
          onSelect={openPath}
        />
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
      resolveLink={vault.resolveLink}
      onOpen={openPath}
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
