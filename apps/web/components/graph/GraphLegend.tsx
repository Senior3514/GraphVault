'use client';

/**
 * The canvas colour legend. It mirrors exactly what the renderer draws:
 * - "type" mode: lists the node categories actually present (note / attachment
 *   / missing note).
 * - "tag" mode: lists the active tag colours.
 * - "cluster" mode: lists the discovered connected-component clusters, largest
 *   first, with a grey "Isolated" row for singleton nodes.
 *
 * The legend is driven straight from `CATEGORY_STYLE` / `colorForKey` /
 * `clusterLegendEntries` so it can never drift from the canvas.
 */

import { CATEGORY_STYLE, colorForKey, GRAPH_NEUTRAL } from '../../lib/graph/model';
import type { ColorMode, NodeCategory } from '../../lib/graph/model';
import type { ClusterColorInfo } from '../../lib/graph/clusters';
import { clusterLegendEntries } from '../../lib/graph/clusters';

export interface GraphLegendProps {
  colorMode: ColorMode;
  /** Categories actually present in the rendered model (type mode). */
  categories: NodeCategory[];
  /** Tags available for the legend (tag mode). */
  tags: string[];
  /** Cluster info for the legend (cluster mode). */
  clusterInfo?: ClusterColorInfo | null;
}

export function GraphLegend({ colorMode, categories, tags, clusterInfo }: GraphLegendProps) {
  const entries =
    colorMode === 'type'
      ? legendForType(categories)
      : colorMode === 'cluster'
        ? legendForClusters(clusterInfo)
        : legendForTags(tags);

  if (entries.items.length === 0) return null;

  return (
    <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-neutral-800 bg-neutral-950/85 px-3 py-2 text-xs backdrop-blur">
      <p className="mb-1 font-semibold uppercase tracking-wide text-neutral-500">{entries.title}</p>
      <ul className="space-y-0.5">
        {entries.items.map((item) => (
          <li key={item.key} className="flex items-center gap-2 text-neutral-300">
            <Swatch color={item.color} outlined={item.outlined} />
            {item.label}
          </li>
        ))}
      </ul>
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

function legendForClusters(info: ClusterColorInfo | null | undefined): {
  title: string;
  items: LegendItem[];
} {
  if (!info) return { title: 'Clusters', items: [] };
  const entries = clusterLegendEntries(info.result, info.colorMap, 7);
  const items: LegendItem[] = entries.map((e, i) => ({
    key: `cluster-${i}`,
    label: e.label,
    color: e.color,
  }));
  return { title: 'Clusters', items };
}

function Swatch({ color, outlined }: { color: string; outlined?: boolean }) {
  return (
    <span
      className="h-2.5 w-2.5 rounded-full"
      style={
        outlined
          ? { backgroundColor: '#0a0a0a', boxShadow: `inset 0 0 0 1.5px ${color}` }
          : { backgroundColor: color }
      }
      aria-hidden
    />
  );
}
