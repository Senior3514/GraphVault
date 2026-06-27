/**
 * Workspace layout types.
 *
 * Describes the multi-pane, multi-tab workspace state that is persisted to
 * localStorage. All values are pure data (no DOM references) so the state can
 * be serialised/deserialised without ceremony.
 */

/** Which side panels are visible. */
export interface PanelVisibility {
  sidebar: boolean;
  noteList: boolean;
  details: boolean;
}

/** Per-pane collapse / maximise state. */
export type PaneState = 'normal' | 'collapsed' | 'maximized';

/** Which pane is currently maximised (at most one at a time). */
export type MaximizedPane = 'noteList' | 'editor' | 'details' | null;

/** Cached widths of resizable dividers (px). */
export interface PaneWidths {
  /** Width of the in-vault note-list column (default 256). */
  noteList: number;
  /** Width of the right details / backlinks column (default 288). */
  details: number;
}

/** A single open tab in the editor. */
export interface EditorTab {
  /** Stable unique id (random string, assigned at creation). */
  id: string;
  /** Vault-relative note path (`notes/foo.md`) or null for a blank tab. */
  notePath: string | null;
  /** Display title (filled in from parsed note). */
  title: string;
  /** Whether the tab has unsaved-since-last-flush changes. */
  dirty: boolean;
}

/** Split view: show two panels side-by-side inside the editor column. */
export type SplitMode = 'none' | 'editor-preview' | 'two-notes';

/** The complete persisted workspace layout. */
export interface WorkspaceLayout {
  /** Sidebar (nav rail) visibility. */
  panels: PanelVisibility;
  /** Which pane is maximised, or null for normal layout. */
  maximized: MaximizedPane;
  /** Pixel widths of resizable panels. */
  widths: PaneWidths;
  /** Open editor tabs. */
  tabs: EditorTab[];
  /** Id of the active tab. */
  activeTabId: string | null;
  /** Split-view mode. */
  splitMode: SplitMode;
  /** Id of the secondary tab when splitMode is 'two-notes'. */
  secondaryTabId: string | null;
  /**
   * Distraction-free "focus mode". When `true` the surrounding app chrome
   * (icon rail, sidebar, note-list + details panes, resize dividers, bottom
   * nav) is hidden and the editor column is centred to a comfortable reading
   * width. Purely presentational - it never destroys the stored pane sizes or
   * panel-visibility flags, so exiting restores the previous layout exactly.
   */
  focusMode: boolean;
}
