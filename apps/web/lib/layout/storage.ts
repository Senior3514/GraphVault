/**
 * Persist/restore workspace layout from localStorage.
 *
 * Only ever runs in the browser. All functions are no-ops in server contexts.
 */

import { DEFAULT_LAYOUT } from './defaults';
import type { WorkspaceLayout } from './types';

const KEY = 'gv-workspace-layout-v1';

/** Persist the layout. Silently ignores errors (private browsing, quota). */
export function saveLayout(layout: WorkspaceLayout): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    /* ignore */
  }
}

/** Load the layout, merging with defaults so newly-added fields have a value. */
export function loadLayout(): WorkspaceLayout {
  if (typeof window === 'undefined') return DEFAULT_LAYOUT;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as Partial<WorkspaceLayout>;
    return merge(DEFAULT_LAYOUT, parsed);
  } catch {
    return DEFAULT_LAYOUT;
  }
}

/** Deep-merge override onto base (one level deep is enough for our shape). */
function merge(base: WorkspaceLayout, override: Partial<WorkspaceLayout>): WorkspaceLayout {
  return {
    ...base,
    ...override,
    panels: { ...base.panels, ...(override.panels ?? {}) },
    widths: { ...base.widths, ...(override.widths ?? {}) },
    // Tabs are replaced wholesale; if missing fall back to empty.
    tabs: override.tabs ?? base.tabs,
    // Older persisted blobs predate focus mode. A missing key would simply be
    // absent from the spread (keeping the default), but an explicit `undefined`
    // WOULD shadow the default — so coalesce defensively to the base value.
    // (See lessons: "Spreading Partial<T> with undefined values overwrites
    // defaults".)
    focusMode: override.focusMode ?? base.focusMode,
  };
}
