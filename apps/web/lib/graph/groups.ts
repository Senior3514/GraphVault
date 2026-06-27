/**
 * Pure, framework-free helpers for user-defined graph "Groups".
 *
 * A Group is a named, colour-coded overlay that the user defines by writing a
 * simple query. Nodes matching a group are painted in that group's colour
 * (first-matching-group-wins). The canvas reads a precomputed
 * `Map<nodeId, color>` so group changes never rebuild the force layout -
 * they only affect the alpha value fed into `nodeCanvasObject`, exactly like
 * search, timeline, and cluster dimming.
 *
 * Query syntax (simple, first-class-citizen, extensible):
 *   #tag        - matches any node whose tagKey starts with "tag"
 *   path:foo/   - matches nodes whose `path` starts with "foo/"
 *   <anything>  - title substring match (case-insensitive)
 *
 * The syntax is deliberately minimal. Future expansions (regex, multiple
 * predicates, AND/OR) can be added here without touching the UI or canvas.
 *
 * Groups are persisted to localStorage under the key `gv:graph:groups`.
 * The serialisation format is plain JSON so it is auditable and portable.
 */

import type { RenderNode } from './model';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single user-defined group entry.
 * `id` is a stable opaque key (caller assigns, e.g. a UUID or counter string).
 */
export interface NodeGroup {
  id: string;
  name: string;
  query: string;
  color: string;
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Test whether a single render node matches a group query string.
 *
 * Matching rules (evaluated in order):
 *   1. `#<tag>` - the node's `tagKey` includes the tag text after `#`
 *      (case-insensitive).
 *   2. `path:<prefix>` - the node's `path` starts with `<prefix>`
 *      (case-insensitive).
 *   3. Bare string - the node's `title` contains the string
 *      (case-insensitive substring).
 *
 * An empty query never matches anything (returns `false`).
 */
export function matchesQuery(node: RenderNode, query: string): boolean {
  const q = query.trim();
  if (!q) return false;

  // Rule 1: tag query (#tag)
  if (q.startsWith('#')) {
    const tag = q.slice(1).toLowerCase();
    if (!tag) return false;
    return node.tagKey?.toLowerCase().includes(tag) ?? false;
  }

  // Rule 2: path prefix (path:some/folder/)
  if (q.toLowerCase().startsWith('path:')) {
    const prefix = q.slice('path:'.length).toLowerCase();
    if (!prefix) return false;
    return node.path?.toLowerCase().startsWith(prefix) ?? false;
  }

  // Rule 3: title substring (default)
  return node.title.toLowerCase().includes(q.toLowerCase());
}

/**
 * Return the colour of the first group in `groups` that matches `node`, or
 * `undefined` when no group matches. "First-matching-group-wins" semantics
 * means the order of `groups` is meaningful - the caller controls priority.
 */
export function matchGroup(node: RenderNode, groups: readonly NodeGroup[]): string | undefined {
  for (const group of groups) {
    if (matchesQuery(node, group.query)) {
      return group.color;
    }
  }
  return undefined;
}

/**
 * Build a `Map<nodeId, color>` for all nodes that match at least one group.
 * Nodes not matching any group are absent from the map (caller uses the base
 * colour mode for those).
 *
 * This is the hot-path used inside `buildRenderModel` via `useMemo`; it is
 * intentionally O(nodes × groups) and free of any framework dependencies.
 */
export function computeGroupColors(
  nodes: readonly RenderNode[],
  groups: readonly NodeGroup[],
): Map<string, string> {
  const map = new Map<string, string>();
  if (groups.length === 0) return map;

  for (const node of nodes) {
    const color = matchGroup(node, groups);
    if (color !== undefined) {
      map.set(node.id, color);
    }
  }
  return map;
}

// ---------------------------------------------------------------------------
// Default palette for new groups
// ---------------------------------------------------------------------------

/**
 * A set of vivid colours suggested when the user adds a new group. Distinct
 * from `GRAPH_PALETTE` so groups stand out visually against the base colour
 * modes (type / tag / cluster).
 */
export const GROUP_COLOR_PRESETS = [
  '#f43f5e', // rose-500
  '#f97316', // orange-500
  '#eab308', // yellow-500
  '#22c55e', // green-500
  '#06b6d4', // cyan-500
  '#8b5cf6', // violet-500
  '#ec4899', // pink-500
  '#14b8a6', // teal-500
] as const;

/**
 * Pick the next suggested colour for a new group, cycling through the preset
 * palette based on how many groups already exist.
 */
export function nextGroupColor(existingCount: number): string {
  return GROUP_COLOR_PRESETS[existingCount % GROUP_COLOR_PRESETS.length];
}

// ---------------------------------------------------------------------------
// Persistence (localStorage)
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'gv:graph:groups';

/**
 * Load groups from localStorage. Returns an empty array when nothing is stored
 * or the stored value is invalid JSON / wrong shape (fail-safe: never throws).
 */
export function loadGroups(): NodeGroup[] {
  if (typeof localStorage === 'undefined') return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Validate each entry has the required shape.
    const valid: NodeGroup[] = [];
    for (const item of parsed) {
      if (
        item !== null &&
        typeof item === 'object' &&
        typeof (item as Record<string, unknown>).id === 'string' &&
        typeof (item as Record<string, unknown>).name === 'string' &&
        typeof (item as Record<string, unknown>).query === 'string' &&
        typeof (item as Record<string, unknown>).color === 'string'
      ) {
        valid.push(item as NodeGroup);
      }
    }
    return valid;
  } catch {
    return [];
  }
}

/**
 * Persist groups to localStorage. Never throws - storage errors (quota, etc.)
 * are silently swallowed so the UI remains functional.
 */
export function saveGroups(groups: readonly NodeGroup[]): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(groups));
  } catch {
    // Storage quota or access error - silently ignore.
  }
}

// ---------------------------------------------------------------------------
// Legend helper
// ---------------------------------------------------------------------------

/**
 * Build legend entries for the active groups. Returns one entry per group (in
 * order), used by `GraphLegend` when groups are present. Groups with empty
 * names fall back to the query string as the label.
 */
export function groupLegendEntries(groups: readonly NodeGroup[]): Array<{
  label: string;
  color: string;
}> {
  return groups.map((g) => ({
    label: g.name.trim() || g.query || 'Group',
    color: g.color,
  }));
}
