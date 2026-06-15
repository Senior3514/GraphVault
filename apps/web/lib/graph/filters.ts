/**
 * Pure filter state for the graph view and its translation into the engine's
 * `FilterCriteria`. Kept framework-free and unit-tested so the UI layer is a
 * thin shell of controls over this state.
 */

import type { FilterCriteria } from '@graphvault/engine';

/** The graph's two viewing modes. */
export type GraphMode = 'global' | 'local';

/** UI-facing filter state. Dates are `YYYY-MM-DD` strings from `<input type=date>`. */
export interface GraphFilters {
  /** Selected tag names (without leading `#`). Empty = no tag filter. */
  tags: string[];
  /** Selected folders (vault-relative). Empty = no folder filter. */
  folders: string[];
  /** Selected link/edge types. Empty = all types. */
  linkTypes: string[];
  /** Inclusive lower bound on `updatedAt`, as a date input value (or ''). */
  updatedFrom: string;
  /** Inclusive upper bound on `updatedAt`, as a date input value (or ''). */
  updatedTo: string;
}

/** The empty filter state: everything visible. */
export const EMPTY_FILTERS: GraphFilters = {
  tags: [],
  folders: [],
  linkTypes: [],
  updatedFrom: '',
  updatedTo: '',
};

/** Actions the filter reducer understands. */
export type FilterAction =
  | { type: 'toggleTag'; tag: string }
  | { type: 'toggleFolder'; folder: string }
  | { type: 'toggleLinkType'; linkType: string }
  | { type: 'setUpdatedFrom'; value: string }
  | { type: 'setUpdatedTo'; value: string }
  | { type: 'reset' };

function toggle(list: string[], value: string): string[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

/** Pure reducer over {@link GraphFilters}. */
export function filtersReducer(state: GraphFilters, action: FilterAction): GraphFilters {
  switch (action.type) {
    case 'toggleTag':
      return { ...state, tags: toggle(state.tags, action.tag) };
    case 'toggleFolder':
      return { ...state, folders: toggle(state.folders, action.folder) };
    case 'toggleLinkType':
      return { ...state, linkTypes: toggle(state.linkTypes, action.linkType) };
    case 'setUpdatedFrom':
      return { ...state, updatedFrom: action.value };
    case 'setUpdatedTo':
      return { ...state, updatedTo: action.value };
    case 'reset':
      return EMPTY_FILTERS;
    default:
      return state;
  }
}

/** True when no filter is active (the global graph would be unconstrained). */
export function filtersAreEmpty(f: GraphFilters): boolean {
  return (
    f.tags.length === 0 &&
    f.folders.length === 0 &&
    f.linkTypes.length === 0 &&
    f.updatedFrom === '' &&
    f.updatedTo === ''
  );
}

/** Parse a `YYYY-MM-DD` date input into epoch ms at the start of that UTC day. */
export function dateInputToMs(value: string): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isNaN(ms) ? undefined : ms;
}

/**
 * Translate UI filter state into engine `FilterCriteria`. The `updatedTo` bound
 * is pushed to the end of its day so a single-day range is inclusive of edits
 * made any time that day.
 */
export function toCriteria(f: GraphFilters, nodeCap?: number): FilterCriteria {
  const from = dateInputToMs(f.updatedFrom);
  const toStart = dateInputToMs(f.updatedTo);
  const to = toStart === undefined ? undefined : toStart + (24 * 60 * 60 * 1000 - 1);

  const criteria: FilterCriteria = {};
  if (f.tags.length > 0) criteria.tags = f.tags;
  if (f.folders.length > 0) criteria.folders = f.folders;
  if (f.linkTypes.length > 0) criteria.linkTypes = f.linkTypes;
  if (from !== undefined) criteria.updatedFrom = from;
  if (to !== undefined) criteria.updatedTo = to;
  if (nodeCap !== undefined) criteria.nodeCap = nodeCap;
  return criteria;
}
