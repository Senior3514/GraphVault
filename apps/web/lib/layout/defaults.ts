/**
 * Default workspace layout values.
 */

import type { WorkspaceLayout } from './types';

export const MIN_NOTE_LIST_WIDTH = 160;
export const MAX_NOTE_LIST_WIDTH = 480;
export const DEFAULT_NOTE_LIST_WIDTH = 256;

export const MIN_DETAILS_WIDTH = 200;
export const MAX_DETAILS_WIDTH = 480;
export const DEFAULT_DETAILS_WIDTH = 288;

export const DEFAULT_LAYOUT: WorkspaceLayout = {
  panels: {
    sidebar: true,
    noteList: true,
    details: true,
  },
  maximized: null,
  widths: {
    noteList: DEFAULT_NOTE_LIST_WIDTH,
    details: DEFAULT_DETAILS_WIDTH,
  },
  tabs: [],
  activeTabId: null,
  splitMode: 'none',
  secondaryTabId: null,
  focusMode: false,
};
