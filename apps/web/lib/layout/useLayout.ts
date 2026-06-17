'use client';

/**
 * useLayout — the single source of truth for workspace layout state.
 *
 * Persists to localStorage on every mutation (debounced slightly to avoid
 * thrashing on drag). Exposes granular action functions so components never
 * touch the raw state object.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  DEFAULT_DETAILS_WIDTH,
  DEFAULT_LAYOUT,
  DEFAULT_NOTE_LIST_WIDTH,
  MAX_DETAILS_WIDTH,
  MAX_NOTE_LIST_WIDTH,
  MIN_DETAILS_WIDTH,
  MIN_NOTE_LIST_WIDTH,
} from './defaults';
import { loadLayout, saveLayout } from './storage';
import type {
  EditorTab,
  MaximizedPane,
  PanelVisibility,
  SplitMode,
  WorkspaceLayout,
} from './types';

function makeTabId(): string {
  return Math.random().toString(36).slice(2, 9);
}

/**
 * Focus mode is consumed by more than one independent `useLayout()` instance
 * (the app shell that hides the rail/sidebar, and the workspace that hides the
 * side panes + centres the editor). React state isn't shared across those
 * instances, so a toggle in one is broadcast on this window event and every
 * mounted hook syncs its local `focusMode` to match. Persistence still flows
 * through the normal localStorage path. SSR-safe: dispatch/listen are guarded.
 */
export const FOCUS_MODE_EVENT = 'graphvault:focus-mode';

interface FocusModeEventDetail {
  focusMode: boolean;
}

export interface LayoutActions {
  /** The current layout snapshot. */
  layout: WorkspaceLayout;

  // --- Panel visibility ---
  togglePanel(panel: keyof PanelVisibility): void;

  // --- Maximise / collapse ---
  maximizePane(pane: MaximizedPane): void;
  restorePane(): void;

  // --- Resizing ---
  setNoteListWidth(px: number): void;
  setDetailsWidth(px: number): void;

  // --- Tabs ---
  openTab(notePath: string, title: string): void;
  closeTab(tabId: string): void;
  activateTab(tabId: string): void;
  reorderTabs(from: number, to: number): void;
  markTabDirty(tabId: string, dirty: boolean): void;
  updateTabTitle(tabId: string, title: string): void;

  // --- Split mode ---
  setSplitMode(mode: SplitMode): void;
  setSecondaryTab(tabId: string | null): void;

  // --- Focus mode (distraction-free editing) ---
  toggleFocusMode(): void;
  setFocusMode(on: boolean): void;
}

/** Clamp a number to [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function useLayout(): LayoutActions {
  // Start with defaults to avoid SSR mismatch; hydrate from localStorage in effect.
  const [layout, setLayout] = useState<WorkspaceLayout>(DEFAULT_LAYOUT);

  // Debounce persistence so rapid drag events don't thrash storage.
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persist = useCallback((next: WorkspaceLayout) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => saveLayout(next), 150);
  }, []);

  // Hydrate from localStorage once on mount (avoids SSR mismatch).
  useEffect(() => {
    const saved = loadLayout();
    setLayout(saved);
  }, []);

  // Keep focus mode in sync across every mounted useLayout instance. A toggle
  // in one component (e.g. the command palette) broadcasts this event; all
  // other instances mirror the new value into their own state so the whole
  // shell reacts together. We only mirror state here — the originating setter
  // already persisted, so listeners must NOT re-persist (avoids feedback).
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const onFocusModeChange = (e: Event) => {
      const detail = (e as CustomEvent<FocusModeEventDetail>).detail;
      if (!detail) return;
      setLayout((prev) =>
        prev.focusMode === detail.focusMode ? prev : { ...prev, focusMode: detail.focusMode },
      );
    };
    window.addEventListener(FOCUS_MODE_EVENT, onFocusModeChange);
    return () => window.removeEventListener(FOCUS_MODE_EVENT, onFocusModeChange);
  }, []);

  const update = useCallback(
    (updater: (prev: WorkspaceLayout) => WorkspaceLayout) => {
      setLayout((prev) => {
        const next = updater(prev);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  // --- Panel visibility ---
  const togglePanel = useCallback(
    (panel: keyof PanelVisibility) => {
      update((prev) => ({
        ...prev,
        panels: { ...prev.panels, [panel]: !prev.panels[panel] },
      }));
    },
    [update],
  );

  // --- Maximise / collapse ---
  const maximizePane = useCallback(
    (pane: MaximizedPane) => {
      update((prev) => ({ ...prev, maximized: pane }));
    },
    [update],
  );

  const restorePane = useCallback(() => {
    update((prev) => ({ ...prev, maximized: null }));
  }, [update]);

  // --- Resizing ---
  const setNoteListWidth = useCallback(
    (px: number) => {
      update((prev) => ({
        ...prev,
        widths: {
          ...prev.widths,
          noteList: clamp(px, MIN_NOTE_LIST_WIDTH, MAX_NOTE_LIST_WIDTH),
        },
      }));
    },
    [update],
  );

  const setDetailsWidth = useCallback(
    (px: number) => {
      update((prev) => ({
        ...prev,
        widths: {
          ...prev.widths,
          details: clamp(px, MIN_DETAILS_WIDTH, MAX_DETAILS_WIDTH),
        },
      }));
    },
    [update],
  );

  // --- Tabs ---
  const openTab = useCallback(
    (notePath: string, title: string) => {
      update((prev) => {
        // If already open, just activate it.
        const existing = prev.tabs.find((t) => t.notePath === notePath);
        if (existing) {
          return { ...prev, activeTabId: existing.id };
        }
        const newTab: EditorTab = {
          id: makeTabId(),
          notePath,
          title,
          dirty: false,
        };
        return {
          ...prev,
          tabs: [...prev.tabs, newTab],
          activeTabId: newTab.id,
        };
      });
    },
    [update],
  );

  const closeTab = useCallback(
    (tabId: string) => {
      update((prev) => {
        const idx = prev.tabs.findIndex((t) => t.id === tabId);
        if (idx === -1) return prev;
        const newTabs = prev.tabs.filter((t) => t.id !== tabId);
        let newActiveId = prev.activeTabId;
        if (prev.activeTabId === tabId) {
          // Activate neighbouring tab or null.
          const neighbour = newTabs[idx] ?? newTabs[idx - 1] ?? null;
          newActiveId = neighbour?.id ?? null;
        }
        // Also clear secondary if it was the closed tab.
        const newSecondary = prev.secondaryTabId === tabId ? null : prev.secondaryTabId;
        return {
          ...prev,
          tabs: newTabs,
          activeTabId: newActiveId,
          secondaryTabId: newSecondary,
        };
      });
    },
    [update],
  );

  const activateTab = useCallback(
    (tabId: string) => {
      update((prev) => ({ ...prev, activeTabId: tabId }));
    },
    [update],
  );

  const reorderTabs = useCallback(
    (from: number, to: number) => {
      update((prev) => {
        if (from === to) return prev;
        const tabs = [...prev.tabs];
        const [moved] = tabs.splice(from, 1);
        tabs.splice(to, 0, moved);
        return { ...prev, tabs };
      });
    },
    [update],
  );

  const markTabDirty = useCallback(
    (tabId: string, dirty: boolean) => {
      update((prev) => ({
        ...prev,
        tabs: prev.tabs.map((t) => (t.id === tabId ? { ...t, dirty } : t)),
      }));
    },
    [update],
  );

  const updateTabTitle = useCallback(
    (tabId: string, title: string) => {
      update((prev) => ({
        ...prev,
        tabs: prev.tabs.map((t) => (t.id === tabId ? { ...t, title } : t)),
      }));
    },
    [update],
  );

  // --- Split mode ---
  const setSplitMode = useCallback(
    (mode: SplitMode) => {
      update((prev) => ({ ...prev, splitMode: mode }));
    },
    [update],
  );

  const setSecondaryTab = useCallback(
    (tabId: string | null) => {
      update((prev) => ({ ...prev, secondaryTabId: tabId }));
    },
    [update],
  );

  // --- Focus mode ---
  // Broadcast after persisting so sibling useLayout instances mirror the new
  // value. Note: focus mode is purely presentational — it never touches
  // `widths`, `panels`, or `tabs`, so toggling it off restores the exact prior
  // layout (stored pane sizes are preserved).
  const broadcastFocusMode = useCallback((on: boolean) => {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(
      new CustomEvent<FocusModeEventDetail>(FOCUS_MODE_EVENT, { detail: { focusMode: on } }),
    );
  }, []);

  const setFocusMode = useCallback(
    (on: boolean) => {
      update((prev) => (prev.focusMode === on ? prev : { ...prev, focusMode: on }));
      broadcastFocusMode(on);
    },
    [update, broadcastFocusMode],
  );

  const toggleFocusMode = useCallback(() => {
    update((prev) => {
      const next = !prev.focusMode;
      broadcastFocusMode(next);
      return { ...prev, focusMode: next };
    });
  }, [update, broadcastFocusMode]);

  return {
    layout,
    togglePanel,
    maximizePane,
    restorePane,
    setNoteListWidth,
    setDetailsWidth,
    openTab,
    closeTab,
    activateTab,
    reorderTabs,
    markTabDirty,
    updateTabTitle,
    setSplitMode,
    setSecondaryTab,
    toggleFocusMode,
    setFocusMode,
  };
}

// Re-export defaults so components can import from one place.
export {
  DEFAULT_NOTE_LIST_WIDTH,
  DEFAULT_DETAILS_WIDTH,
  MIN_NOTE_LIST_WIDTH,
  MAX_NOTE_LIST_WIDTH,
  MIN_DETAILS_WIDTH,
  MAX_DETAILS_WIDTH,
};
