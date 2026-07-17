/**
 * Pure helpers for the graph view: mapping the web vault's notes into the
 * engine's `NoteInput` shape, and turning an engine `GraphPayload` into a
 * render-ready model (nodes + links enriched with category, colour and degree).
 *
 * These are deliberately framework-free (no React, no DOM) so they can be unit
 * tested with `node:test` and reused. The actual index build + queries live in
 * `@graphvault/engine`; this module is only the thin glue the web client needs.
 */

import type { GraphEdge, GraphNode, NoteInput } from '@graphvault/engine';

/** The minimal shape this module needs from a vault note. */
export interface VaultNoteLike {
  path: string;
  content: string;
  /** Epoch ms of last local modification. */
  mtime: number;
  /** Epoch ms the note was created. */
  ctime: number;
}

/**
 * Map the web vault's `Note[]` onto the engine's `NoteInput[]`.
 *
 * The vault tracks `ctime`/`mtime`; the engine speaks `createdAt`/`updatedAt`
 * (epoch ms). The note `path` is already a vault-relative POSIX path, which is
 * exactly what the engine expects for `NoteInput.path`.
 */
export function notesToInputs(notes: readonly VaultNoteLike[]): NoteInput[] {
  return notes.map((n) => ({
    path: n.path,
    content: n.content,
    createdAt: n.ctime,
    updatedAt: n.mtime,
  }));
}

/**
 * A restrained, dark-first categorical palette. Used to encode a node's tag
 * (in "colour by tag" mode) or an edge's link type - meaning, not decoration
 * (see DESIGN.md).
 */
export const GRAPH_PALETTE = [
  '#7aa2f7', // blue
  '#9ece6a', // green
  '#e0af68', // amber
  '#bb9af7', // violet
  '#f7768e', // rose
  '#7dcfff', // cyan
  '#ff9e64', // orange
  '#73daca', // teal
] as const;

/** Neutral fallback for nodes with no tag / unknown category. */
export const GRAPH_NEUTRAL = '#9ca3af';

/**
 * Deterministically pick a palette colour for a category key (e.g. a tag or a
 * link type). Stable across renders for a given key, so the legend matches the
 * canvas. An empty/undefined key yields the neutral colour.
 */
export function colorForKey(key: string | undefined): string {
  if (!key) return GRAPH_NEUTRAL;
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    hash = (hash * 31 + key.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % GRAPH_PALETTE.length;
  return GRAPH_PALETTE[idx];
}

/** Collect the distinct, sorted tags present across a set of notes' tag lists. */
export function distinctSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Node categories - the primary, default colour encoding.
// ---------------------------------------------------------------------------

/**
 * The kind of a rendered node, derived from the engine index:
 * - `note`        - a real `.md` note in the vault.
 * - `attachment`  - a non-`.md` file (image, pdf, …) referenced by a note but
 *   not itself a note in the index.
 * - `unresolved`  - a link whose target does not resolve to any known note
 *   (a "missing note" placeholder).
 */
export type NodeCategory = 'note' | 'attachment' | 'unresolved';

/** The way nodes are coloured on the canvas. */
export type ColorMode = 'type' | 'tag' | 'cluster' | 'folder';

/**
 * Colour + label for each node category. The legend renders straight from this
 * table so it can never drift from what the canvas draws.
 */
export const CATEGORY_STYLE: Record<NodeCategory, { color: string; label: string }> = {
  // Brand CYAN (matches `--accent-400`) so the primary "note" node reads as
  // GraphVault rather than a generic blue dot. The canvas re-resolves this from
  // the live `--accent-400` token at runtime so notes stay on-brand in the
  // light theme too; this hex is the dark-theme fallback + legend swatch.
  note: { color: '#1fafc6', label: 'Note' },
  attachment: { color: '#e0af68', label: 'Attachment' },
  unresolved: { color: '#6b7280', label: 'Missing note' },
};

/** Colour for a node category (primary "colour by type" mode). */
export function colorForCategory(category: NodeCategory): string {
  return CATEGORY_STYLE[category].color;
}

const MARKDOWN_RE = /\.(md|markdown)$/i;

/**
 * Classify an *unresolved* edge target as either a missing note or an
 * attachment. Engine edges to non-`.md` paths (e.g. `assets/diagram.png`) are
 * surfaced as `attachment` placeholders; everything else is a missing note.
 */
export function categorizeUnresolvedTarget(target: string): NodeCategory {
  // A target carrying a non-markdown file extension is treated as an
  // attachment; a bare basename or a `.md`/`.markdown` path is a missing note.
  const hasExt = /\.[a-z0-9]+$/i.test(target);
  if (hasExt && !MARKDOWN_RE.test(target)) return 'attachment';
  return 'unresolved';
}

/** A node enriched for rendering. The force lib mutates `x/y/vx/vy` at runtime. */
export interface RenderNode {
  id: string;
  title: string;
  category: NodeCategory;
  /** Resolved fill colour, honouring the active colour mode. */
  color: string;
  /** Number of incident edges, used to scale the node radius. */
  degree: number;
  /** Tag used in "colour by tag" mode (the node's first tag), if any. */
  tagKey?: string;
  /** Real notes carry their vault path so a double-click can deep-link to it. */
  path?: string;
  /**
   * Pre-computed cluster colour for "cluster" colour mode. Set when
   * `buildRenderModel` is called with `colorMode: 'cluster'` and a
   * `clusterNodeColor` map. Undefined otherwise.
   */
  clusterColor?: string;
}

/** A link enriched for rendering. */
export interface RenderLink {
  source: string;
  target: string;
  type: string;
  resolved: boolean;
}

/** The render-ready graph the canvas consumes. */
export interface RenderModel {
  nodes: RenderNode[];
  links: RenderLink[];
  /** Categories actually present, for a legend that mirrors the canvas. */
  presentCategories: NodeCategory[];
}

export interface BuildRenderModelOptions {
  /** Primary colour encoding. Defaults to `'type'`. */
  colorMode?: ColorMode;
  /**
   * Whether to synthesize attachment / missing-note placeholder nodes from
   * unresolved edges. When true, those edges become visible with a distinct
   * faint node at their target. Defaults to `true`.
   */
  includeUnresolved?: boolean;
  /**
   * Pre-computed node-id → hex colour map for cluster colouring. Required
   * when `colorMode === 'cluster'`. Nodes absent from the map receive
   * `GRAPH_NEUTRAL`.
   */
  clusterNodeColor?: Map<string, string>;
  /**
   * Pre-computed node-id → hex colour map from user-defined Groups. When a
   * node appears in this map its colour overrides the base `colorMode` colour
   * (first-matching-group-wins semantics applied upstream). Placeholder nodes
   * (attachments / unresolved) are never overridden by groups.
   */
  groupNodeColor?: Map<string, string>;
}

const CATEGORY_ORDER: NodeCategory[] = ['note', 'attachment', 'unresolved'];

/**
 * Turn an engine payload (real note nodes + edges, some unresolved) into a
 * render model. Real notes become `note` nodes; unresolved edge targets are
 * synthesized into distinct `attachment` / `unresolved` placeholder nodes so
 * the canvas can draw "missing note" affordances. Degree counts every incident
 * edge so hubs read clearly.
 *
 * Pure and deterministic - unit tested in `model.test.ts`.
 */
export function buildRenderModel(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  options: BuildRenderModelOptions = {},
): RenderModel {
  const colorMode = options.colorMode ?? 'type';
  const includeUnresolved = options.includeUnresolved ?? true;
  const clusterNodeColor = options.clusterNodeColor;
  const groupNodeColor = options.groupNodeColor;

  const noteIds = new Set(nodes.map((n) => n.id));

  // Synthesize placeholder nodes for unresolved targets, keyed by raw target so
  // many notes pointing at the same missing target collapse onto one node.
  const placeholders = new Map<string, { id: string; category: NodeCategory; title: string }>();
  const renderLinks: RenderLink[] = [];

  for (const e of edges) {
    if (e.resolved) {
      renderLinks.push({ source: e.source, target: e.target, type: e.type, resolved: true });
      continue;
    }
    if (!includeUnresolved) continue;
    // Only draw unresolved edges whose *source* is a real note in the payload.
    if (!noteIds.has(e.source)) continue;
    const category = categorizeUnresolvedTarget(e.target);
    const placeholderId = `${category}:${e.target}`;
    if (!placeholders.has(placeholderId)) {
      placeholders.set(placeholderId, {
        id: placeholderId,
        category,
        title: e.alias ?? basenameLabel(e.target),
      });
    }
    renderLinks.push({ source: e.source, target: placeholderId, type: e.type, resolved: false });
  }

  // Degree over the final link set (notes + placeholders).
  const degree = new Map<string, number>();
  for (const l of renderLinks) {
    degree.set(l.source, (degree.get(l.source) ?? 0) + 1);
    degree.set(l.target, (degree.get(l.target) ?? 0) + 1);
  }

  const renderNodes: RenderNode[] = nodes.map((n) => {
    const tagKey = n.tags[0];
    let color: string;
    if (colorMode === 'tag') {
      color = colorForKey(tagKey);
    } else if (colorMode === 'cluster') {
      color = clusterNodeColor?.get(n.id) ?? GRAPH_NEUTRAL;
    } else if (colorMode === 'folder') {
      // `n.folder` is `''` for vault-root notes - colorForKey treats an empty
      // key as "no key" and returns the neutral swatch, matching how tag mode
      // treats untagged notes. Every other distinct folder path gets its own
      // stable hash colour, same mechanism as tag colouring.
      color = colorForKey(n.folder);
    } else {
      color = colorForCategory('note');
    }
    // Groups override the base colour mode (first-matching-group-wins,
    // computed upstream in computeGroupColors).
    const groupColor = groupNodeColor?.get(n.id);
    if (groupColor) color = groupColor;
    return {
      id: n.id,
      title: n.title,
      category: 'note',
      color,
      degree: degree.get(n.id) ?? 0,
      tagKey,
      path: n.path,
      clusterColor: clusterNodeColor?.get(n.id),
    };
  });

  for (const p of placeholders.values()) {
    renderNodes.push({
      id: p.id,
      title: p.title,
      category: p.category,
      // Placeholders always read by their type, even in tag mode.
      color: colorForCategory(p.category),
      degree: degree.get(p.id) ?? 0,
    });
  }

  const present = new Set(renderNodes.map((n) => n.category));
  const presentCategories = CATEGORY_ORDER.filter((c) => present.has(c));

  return { nodes: renderNodes, links: renderLinks, presentCategories };
}

/** A short, human label for an unresolved target path or basename. */
function basenameLabel(target: string): string {
  const noAnchor = target.split('#')[0] ?? target;
  const parts = noAnchor.split('/');
  const last = parts[parts.length - 1] || noAnchor;
  return last.replace(MARKDOWN_RE, '');
}
