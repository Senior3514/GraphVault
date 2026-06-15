'use client';

/** A small colour legend mapping the active tag colours shown on the canvas. */

import { colorForKey, GRAPH_NEUTRAL } from '../../lib/graph/model';

export function GraphLegend({ tags }: { tags: string[] }) {
  if (tags.length === 0) return null;
  // Keep the legend compact; the long tail collapses into "untagged/other".
  const shown = tags.slice(0, 8);
  return (
    <div className="pointer-events-none absolute bottom-3 left-3 rounded-md border border-neutral-800 bg-neutral-950/85 px-3 py-2 text-xs backdrop-blur">
      <p className="mb-1 font-semibold uppercase tracking-wide text-neutral-500">Tags</p>
      <ul className="space-y-0.5">
        {shown.map((tag) => (
          <li key={tag} className="flex items-center gap-2 text-neutral-300">
            <span
              className="h-2.5 w-2.5 rounded-full"
              style={{ backgroundColor: colorForKey(tag) }}
              aria-hidden
            />
            {tag}
          </li>
        ))}
        <li className="flex items-center gap-2 text-neutral-500">
          <span
            className="h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: GRAPH_NEUTRAL }}
            aria-hidden
          />
          untagged
        </li>
      </ul>
    </div>
  );
}
