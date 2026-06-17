/**
 * Public exports for the layout library.
 */

export { useLayout, FOCUS_MODE_EVENT } from './useLayout';
export { loadLayout, saveLayout } from './storage';
export { DEFAULT_LAYOUT } from './defaults';
export type {
  WorkspaceLayout,
  EditorTab,
  PanelVisibility,
  PaneWidths,
  MaximizedPane,
  SplitMode,
} from './types';
