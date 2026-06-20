'use client';

/**
 * The canvas colour legend. It mirrors exactly what the renderer draws:
 * - "type" mode: lists the node categories actually present (note / attachment
 *   / missing note).
 * - "tag" mode: lists the active tag colours.
 * - "cluster" mode: lists the discovered connected-component clusters, largest
 *   first, with a grey "Isolated" row for singleton nodes.
 * - "groups" overlay: when user-defined groups are active, an additional
 *   "Groups" section is appended above the base-mode legend so the canvas
 *   colour meaning is always visible regardless of mode.
 *
 * The legend is driven straight from `CATEGORY_STYLE` / `colorForKey` /
 * `clusterLegendEntries` / `groupLegendEntries` so it can never drift from
 * the canvas.
 */

import { CATEGORY_STYLE, colorForKey, GRAPH_NEUTRAL } from '../../lib/graph/model';
import type { ColorMode, NodeCategory } from '../../lib/graph/model';
import type { ClusterColorInfo } from '../../lib/graph/clusters';
import { clusterLegendEntries } from '../../lib/graph/clusters';
import type { NodeGroup } from '../../lib/graph/groups';
import { groupLegendEntries } from '../../lib/graph/groups';

export interface GraphLegendProps {
  colorMode: ColorMode;
  /** Categories actually present in the rendered model (type mode). */
  categories: NodeCategory[];
  /** Tags available for the legend (tag mode). */
  tags: string[];
  /** Cluster info for the legend (cluster mode). */
  clusterInfo?: ClusterColorInfo | null;
  /** Active user-defined groups (shown as an overlay legend section). */
  groups?: readonly NodeGroup[];
  /**
   * M21 AI: AI-generated cluster names, keyed by the 0-based visual cluster
   * index (same order as `clusterLegendEntries`). When present and colorMode
   * is 'cluster', replaces the default "Cluster N (size)" labels with the
   * AI-generated names.
   */
  aiClusterNames?: string[];
}

export function GraphLegend({
  colorMode,
  categories,
  tags,
  clusterInfo,
  groups = [],
  aiClusterNames,
}: GraphLegendProps) {
  const baseEntries =
    colorMode === 'type'
      ? legendForType(categories)
      : colorMode === 'cluster'
        ? legendForClusters(clusterInfo, aiClusterNames)
        : legendForTags(tags);

  const groupItems = groupLegendEntries(groups);

  // Hide the legend entirely only if there is nothing to show.
  if (baseEntries.items.length === 0 && groupItems.length === 0) return null;

  return (
    <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-neutral-800 bg-neutral-950/85 px-3 py-2 text-xs backdrop-blur">
      {/* Groups overlay section — shown first when groups are active */}
      {groupItems.length > 0 && (
        <>
          <p className="mb-1 font-semibold uppercase tracking-wide text-neutral-500">Groups</p>
          <ul className="space-y-0.5">
            {groupItems.map((item, i) => (
              <li key={`group-${i}`} className="flex items-center gap-2 text-neutral-300">
                <Swatch color={item.color} />
                {item.label}
              </li>
            ))}
          </ul>
          {baseEntries.items.length > 0 && <hr className="my-1.5 border-neutral-800/70" />}
        </>
      )}
      {/* Base colour-mode section */}
      {baseEntries.items.length > 0 && (
        <>
          <p className="mb-1 font-semibold uppercase tracking-wide text-neutral-500">
            {baseEntries.title}
          </p>
          <ul className="space-y-0.5">
            {baseEntries.items.map((item) => (
              <li key={item.key} className="flex items-center gap-2 text-neutral-300">
                <Swatch color={item.color} outlined={item.outlined} />
                {item.label}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

interface LegendItem {
  key: string;
  label: string;
  color: string;
  /** Drawn as an outline (matches placeholder nodes on the canvas). */
  outlined?: boolean;
}

function legendForType(categories: NodeCategory[]): { title: string; items: LegendItem[] } {
  const items: LegendItem[] = categories.map((c) => ({
    key: c,
    label: CATEGORY_STYLE[c].label,
    color: CATEGORY_STYLE[c].color,
    outlined: c !== 'note',
  }));
  return { title: 'Node type', items };
}

function legendForTags(tags: string[]): { title: string; items: LegendItem[] } {
  // Keep the legend compact; the long tail collapses into "untagged/other".
  const shown = tags.slice(0, 8);
  const items: LegendItem[] = shown.map((tag) => ({
    key: tag,
    label: tag,
    color: colorForKey(tag),
  }));
  items.push({ key: '__untagged__', label: 'untagged', color: GRAPH_NEUTRAL });
  return { title: 'Tags', items };
}

function legendForClusters(
  info: ClusterColorInfo | null | undefined,
  aiNames?: string[],
): {
  title: string;
  items: LegendItem[];
} {
  if (!info) return { title: 'Clusters', items: [] };
  const entries = clusterLegendEntries(info.result, info.colorMap, 7);
  const items: LegendItem[] = entries.map((e, i) => ({
    key: `cluster-${i}`,
    // Prefer the AI-generated name when available; fall back to structural label.
    label: aiNames?.[i] ?? e.label,
    color: e.color,
  }));
  return {
    title: aiNames && aiNames.length > 0 ? 'Clusters (AI-named)' : 'Clusters',
    items,
  };
}

function Swatch({ color, outlined }: { color: string; outlined?: boolean }) {
  return (
    <span
      className="h-2.5 w-2.5 rounded-full"
      style={
        outlined
          ? {
              // Match the page background in either theme so the hollow swatch
              // reads correctly (was hard-coded dark `#0a0a0a`).
              backgroundColor: 'rgb(var(--n-950))',
              boxShadow: `inset 0 0 0 1.5px ${color}`,
            }
          : { backgroundColor: color }
      }
      aria-hidden
    />
  );
}
