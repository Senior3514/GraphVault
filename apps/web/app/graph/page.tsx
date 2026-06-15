'use client';

/**
 * Graph view (Milestones 7 + 11 "wow"). Builds the `@graphvault/engine` index
 * in the browser from the current vault, then renders a force-directed graph
 * with live physics, colour-by-type (or by-tag), filters, a global/local mode
 * toggle, hover/selection highlighting, and a selection side panel.
 *
 * The engine index is memoised over the vault notes so we don't re-parse on
 * every interaction; the render model (engine payload → nodes/links with
 * category, colour and degree) is also memoised. The heavy canvas renderer is
 * dynamically imported with `ssr: false` so production `next build` stays
 * server-safe.
 */

import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useCallback, useMemo, useReducer, useRef, useState } from 'react';

import {
  buildIndex,
  DEFAULT_NODE_CAP,
  filterGraph,
  getLocalGraph,
  type GraphPayload,
} from '@graphvault/engine';

import { GraphControls } from '../../components/graph/GraphControls';
import { GraphLegend } from '../../components/graph/GraphLegend';
import { NodePanel } from '../../components/graph/NodePanel';
import type { ForceGraphHandle } from '../../components/graph/ForceGraphCanvas';
import { EMPTY_FILTERS, filtersReducer, toCriteria } from '../../lib/graph/filters';
import { buildRenderModel, distinctSorted, notesToInputs } from '../../lib/graph/model';
import type { ColorMode } from '../../lib/graph/model';
import { clampPhysics, DEFAULT_PHYSICS, type GraphPhysics } from '../../lib/graph/physics';
import { useVaultContext } from '../../lib/vault/VaultProvider';

// Canvas/DOM-only renderer: never server-rendered.
const ForceGraphCanvas = dynamic(() => import('../../components/graph/ForceGraphCanvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-sm text-neutral-600">
      Loading graph…
    </div>
  ),
});

export default function GraphPage() {
  const vault = useVaultContext();
  const router = useRouter();
  const [filters, dispatch] = useReducer(filtersReducer, EMPTY_FILTERS);
  const [mode, setMode] = useState<'global' | 'local'>('global');
  const [localDepth, setLocalDepth] = useState(2);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [colorMode, setColorMode] = useState<ColorMode>('type');
  const [physics, setPhysics] = useState<GraphPhysics>(DEFAULT_PHYSICS);

  const canvasRef = useRef<ForceGraphHandle>(null);

  // Build the engine index from the current vault. Memoised on the raw notes so
  // unrelated re-renders (hover, selection) don't trigger a reparse.
  const index = useMemo(() => buildIndex(notesToInputs(vault.notes)), [vault.notes]);
  const totalNodes = index.nodes.size;

  // Facets available for the filter controls, derived from the full index.
  const facets = useMemo(() => {
    const tags = new Set<string>();
    const folders = new Set<string>();
    const linkTypes = new Set<string>();
    for (const node of index.nodes.values()) {
      node.tags.forEach((t) => tags.add(t));
      folders.add(node.folder);
    }
    for (const edge of index.edges) {
      if (edge.resolved) linkTypes.add(edge.type);
    }
    return {
      tags: distinctSorted(tags),
      folders: distinctSorted(folders),
      linkTypes: distinctSorted(linkTypes),
    };
  }, [index]);

  // The payload to render: filtered global graph, or a local neighbourhood
  // around the selected note. Local mode also honours the active filters by
  // intersecting the two node sets. Unresolved edges are included so the render
  // model can surface attachment / missing-note placeholders.
  const payload: GraphPayload = useMemo(() => {
    const criteria = toCriteria(filters, DEFAULT_NODE_CAP);
    criteria.includeUnresolved = true;
    const filtered = filterGraph(index, criteria);
    if (mode === 'local' && selectedId) {
      const local = getLocalGraph(index, selectedId, localDepth, {
        includeUnresolved: true,
      });
      const allowed = new Set(filtered.nodes.map((n) => n.id));
      const nodes = local.nodes.filter((n) => n.id === selectedId || allowed.has(n.id));
      const present = new Set(nodes.map((n) => n.id));
      const edges = local.edges.filter(
        (e) => present.has(e.source) && (!e.resolved || present.has(e.target)),
      );
      return { nodes, edges, truncated: local.truncated };
    }
    return filtered;
  }, [index, filters, mode, selectedId, localDepth]);

  // Render model: enrich nodes with category/colour/degree and synthesize
  // placeholder nodes for unresolved targets.
  const model = useMemo(
    () => buildRenderModel(payload.nodes, payload.edges, { colorMode, includeUnresolved: true }),
    [payload, colorMode],
  );

  const selectedNode = selectedId ? index.nodes.get(selectedId) : undefined;

  const handleModeChange = (next: 'global' | 'local') => {
    if (next === 'local' && !selectedId) return;
    setMode(next);
  };

  const handleFocusLocal = (id: string) => {
    setSelectedId(id);
    setMode('local');
  };

  const handleSelect = (id: string | null) => {
    setSelectedId(id);
    if (!id && mode === 'local') setMode('global');
  };

  // Deep-link a note into the vault editor (single source of the URL shape).
  const openNote = useCallback(
    (path: string) => {
      router.push(`/vault?note=${encodeURIComponent(path)}`);
    },
    [router],
  );

  const handlePhysicsChange = (patch: Partial<GraphPhysics>) => {
    setPhysics((prev) => clampPhysics(prev, patch));
  };

  if (!vault.ready) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-600">
        Loading vault…
      </div>
    );
  }

  const shownNodes = payload.nodes.length;

  return (
    <div className="flex h-full min-h-0">
      <GraphControls
        mode={mode}
        onModeChange={handleModeChange}
        localDepth={localDepth}
        onLocalDepthChange={setLocalDepth}
        canFocusLocal={selectedId !== null}
        colorMode={colorMode}
        onColorModeChange={setColorMode}
        physics={physics}
        onPhysicsChange={handlePhysicsChange}
        onResetPhysics={() => setPhysics(DEFAULT_PHYSICS)}
        onZoomToFit={() => canvasRef.current?.zoomToFit()}
        onResetView={() => canvasRef.current?.resetView()}
        filters={filters}
        dispatch={dispatch}
        availableTags={facets.tags}
        availableFolders={facets.folders}
        availableLinkTypes={facets.linkTypes}
      />

      <div className="relative flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between border-b border-neutral-800 bg-neutral-950 px-4 py-2.5">
          <div>
            <h1 className="text-sm font-semibold text-neutral-100">Graph</h1>
            <p className="text-xs text-neutral-500">
              {mode === 'local' && selectedNode
                ? `Local · ${selectedNode.title} · depth ${localDepth}`
                : 'Global'}
            </p>
          </div>
          <NodeCount shown={shownNodes} total={totalNodes} truncated={payload.truncated} />
        </header>

        <div className="relative min-h-0 flex-1">
          {totalNodes === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-neutral-600">
              This vault has no notes yet.
            </div>
          ) : shownNodes === 0 ? (
            <div className="flex h-full items-center justify-center px-6 text-center text-sm text-neutral-600">
              No notes match the current filters.
            </div>
          ) : (
            <>
              <ForceGraphCanvas
                model={model}
                selectedId={selectedId}
                physics={physics}
                handleRef={canvasRef}
                onSelect={handleSelect}
                onOpen={(node) => node.path && openNote(node.path)}
              />
              <GraphLegend
                colorMode={colorMode}
                categories={model.presentCategories}
                tags={facets.tags}
              />
            </>
          )}
        </div>
      </div>

      {selectedNode && (
        <NodePanel
          node={selectedNode}
          index={index}
          isLocalFocus={mode === 'local'}
          onFocusLocal={handleFocusLocal}
          onSelect={handleSelect}
          onOpen={openNote}
        />
      )}
    </div>
  );
}

function NodeCount({
  shown,
  total,
  truncated,
}: {
  shown: number;
  total: number;
  truncated: boolean;
}) {
  return (
    <div className="text-right text-xs">
      <span className="text-neutral-300">
        {truncated || shown < total ? `Showing ${shown} of ${total}` : `${total}`} nodes
      </span>
      {truncated && (
        <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300">
          capped at {DEFAULT_NODE_CAP}
        </span>
      )}
    </div>
  );
}
