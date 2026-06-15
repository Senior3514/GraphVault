'use client';

/**
 * Graph view (Milestones 7 + 11 "wow" + v2 power features + v3 Lumen visuals).
 * Builds the `@graphvault/engine` index in the browser from the current vault,
 * then renders a force-directed graph with:
 *
 * v1 (preserved):
 * - Live physics, colour-by-type (or by-tag), filters, global/local mode toggle
 * - Hover/selection highlighting, glow on the focused node + neighbours
 * - Selection side panel, zoom-to-fit on engine settle
 *
 * v2 (preserved):
 * - In-graph search (press `/`): highlights + dims non-matches, live count
 * - Drag-to-pin: drag fixes a node; pin glyph shows; click pinned node to unpin
 * - "Unpin all" control, zoom-in / zoom-out buttons
 * - Link curvature for multi-edges
 * - Label suppression at high node counts for performance
 * - Better empty + filtered-zero states
 *
 * v3 (Lumen) additions:
 * - Cluster / community colouring: colour-by-connected-component via a pure
 *   `buildClusterColors` helper in `lib/graph/clusters.ts`.
 * - Context view: emphasise the selected neighbourhood (aggressive dimming of
 *   all other nodes) — toggle in the new "Graphics" control section.
 * - Label density quick-preset (sparse / normal / dense) in Graphics section.
 * - Radial-gradient node fill, soft outer ring, halo labels for legibility.
 * - DPR-aware canvas (crisp on retina / HiDPI).
 * - Edge opacity by relationship type (wikilink > markdown > typed-relation).
 * - Accurate cluster legend.
 *
 * Mobile layout (< md / 768 px):
 * - The left GraphControls panel collapses to a slide-up drawer toggled by a
 *   floating button. The NodePanel also slides up from the bottom.
 * - Overlays (search, zoom) stay within the viewport; the search bar shrinks
 *   to fit narrow screens.
 *
 * The heavy canvas renderer is dynamically imported with `ssr: false` so
 * production `next build` stays server-safe.
 */

import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';

import {
  buildIndex,
  DEFAULT_NODE_CAP,
  filterGraph,
  getLocalGraph,
  type GraphPayload,
} from '@graphvault/engine';

import { GraphControls, type LabelDensity } from '../../components/graph/GraphControls';
import { GraphLegend } from '../../components/graph/GraphLegend';
import { GraphSearch } from '../../components/graph/GraphSearch';
import { GraphZoomControls } from '../../components/graph/GraphZoomControls';
import { NodePanel } from '../../components/graph/NodePanel';
import type { ForceGraphHandle } from '../../components/graph/ForceGraphCanvas';
import { EMPTY_FILTERS, filtersReducer, toCriteria } from '../../lib/graph/filters';
import { buildRenderModel, distinctSorted, notesToInputs } from '../../lib/graph/model';
import type { ColorMode } from '../../lib/graph/model';
import { clampPhysics, DEFAULT_PHYSICS, type GraphPhysics } from '../../lib/graph/physics';
import { matchNodes } from '../../lib/graph/search';
import {
  buildTimelineState,
  timelineVisibleIds,
  type TimelineState,
} from '../../lib/graph/timeline';
import { buildClusterColors, type ClusterColorInfo } from '../../lib/graph/clusters';
import { computeGroupColors, loadGroups, saveGroups, type NodeGroup } from '../../lib/graph/groups';
import { useVaultContext } from '../../lib/vault/VaultProvider';

// Canvas/DOM-only renderer: never server-rendered.
const ForceGraphCanvas = dynamic(() => import('../../components/graph/ForceGraphCanvas'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full items-center justify-center text-sm text-neutral-600">
      Loading graph...
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
  const [searchQuery, setSearchQuery] = useState('');
  const [pinnedIds, setPinnedIds] = useState<Set<string>>(new Set());
  const [timeline, setTimeline] = useState<TimelineState | null>(null);

  // v3: Graphics toggles
  const [contextView, setContextView] = useState(false);
  const [labelDensity, setLabelDensity] = useState<LabelDensity>('normal');

  // v4: User-defined colour groups — initialised from localStorage on first render.
  const [groups, setGroups] = useState<NodeGroup[]>(() => loadGroups());

  // Mobile drawer states
  const [mobileControlsOpen, setMobileControlsOpen] = useState(false);

  const canvasRef = useRef<ForceGraphHandle>(null);

  // Build the engine index from the current vault. Memoised on the raw notes so
  // unrelated re-renders (hover, selection) don't trigger a reparse.
  const index = useMemo(() => buildIndex(notesToInputs(vault.notes)), [vault.notes]);
  const totalNodes = index.nodes.size;

  // Rebuild the timeline domain whenever the set of notes changes. We preserve
  // the existing window and enabled/playing state where possible so scrubbing
  // isn't disrupted by a background vault update.
  useEffect(() => {
    const nodes = [...index.nodes.values()];
    const fresh = buildTimelineState(nodes);
    if (!fresh) {
      setTimeline(null);
      return;
    }
    setTimeline((prev) => {
      if (!prev) return fresh;
      // Keep user's window if it still falls within the (potentially wider) new domain.
      const windowStart = Math.max(fresh.domainStart, Math.min(prev.windowStart, fresh.domainEnd));
      const windowEnd = Math.max(windowStart, Math.min(prev.windowEnd, fresh.domainEnd));
      return {
        ...fresh,
        windowStart,
        windowEnd,
        enabled: prev.enabled,
        playing: false, // stop animation on vault change
      };
    });
  }, [index]);

  // Compute the set of node IDs visible in the timeline window. Used to dim
  // out-of-window nodes on the canvas, similar to the search highlight.
  const timelineIds = useMemo(() => {
    if (!timeline) return null;
    const nodes = [...index.nodes.values()];
    return timelineVisibleIds(nodes, timeline.windowStart, timeline.windowEnd, timeline.enabled);
  }, [index, timeline]);

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

  // v3: Compute cluster colours when cluster mode is active. Re-computes only
  // when the payload (nodes + links) changes, not on hover/selection updates.
  const clusterInfo: ClusterColorInfo | null = useMemo(() => {
    if (colorMode !== 'cluster') return null;
    return buildClusterColors(payload.nodes, payload.edges);
  }, [colorMode, payload]);

  // v4: Compute group colours. We need render-ready nodes to call matchesQuery
  // (which checks tagKey and path), so we first build the render model without
  // group colours, then compute the group map, then rebuild with the map.
  // To avoid two full passes of buildRenderModel we compute the group map from
  // the preliminary render-node list derived from payload.nodes directly. This
  // keeps the memo chain efficient: group map only rebuilds when groups or the
  // payload change, never on hover/selection.
  const groupNodeColor: Map<string, string> = useMemo(() => {
    if (groups.length === 0) return new Map();
    // Build a lightweight proxy list: we only need id, title, tagKey and path
    // for matching, which are directly available from GraphNode.
    const proxyNodes = payload.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      category: 'note' as const,
      color: '',
      degree: 0,
      tagKey: n.tags[0],
      path: n.path,
    }));
    return computeGroupColors(proxyNodes, groups);
  }, [groups, payload.nodes]);

  // Persist groups to localStorage whenever they change (after initial load).
  // We use a plain effect rather than useCallback so it fires on every update.
  useEffect(() => {
    saveGroups(groups);
  }, [groups]);

  // Render model: enrich nodes with category/colour/degree and synthesize
  // placeholder nodes for unresolved targets.
  const model = useMemo(
    () =>
      buildRenderModel(payload.nodes, payload.edges, {
        colorMode,
        includeUnresolved: true,
        clusterNodeColor: clusterInfo?.nodeColor,
        groupNodeColor: groupNodeColor.size > 0 ? groupNodeColor : undefined,
      }),
    [payload, colorMode, clusterInfo, groupNodeColor],
  );

  // In-graph search: compute the match set from the current query.
  const searchIds = useMemo(() => matchNodes(model.nodes, searchQuery), [model.nodes, searchQuery]);
  const searchMatchCount = searchIds?.size ?? null;

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

  const handleTimelineChange = useCallback((patch: Partial<TimelineState>) => {
    setTimeline((prev) => (prev ? { ...prev, ...patch } : prev));
  }, []);

  const handlePinnedChange = useCallback((pinned: Set<string>) => {
    setPinnedIds(new Set(pinned));
  }, []);

  const handleUnpinAll = useCallback(() => {
    // We can't directly mutate the force-graph nodes from outside the canvas.
    // The canvas tracks pins internally; "unpin all" is driven by clearing the
    // external pin state, which causes the canvas to skip the pin glyph — and
    // more importantly, we call zoomToFit to re-engage the simulation.
    // The actual fx/fy clearing happens the next time the model rebuilds, since
    // model change triggers a full node array rebuild in the canvas.
    // For an immediate effect, we trigger a model recompute by nudging physics.
    setPinnedIds(new Set());
    // Force canvas data rebuild by nudging the physics (harmless, reverts).
    setPhysics((p) => ({ ...p }));
  }, []);

  if (!vault.ready) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-600">
        Loading vault...
      </div>
    );
  }

  const shownNodes = payload.nodes.length;

  const controlsPanel = (
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
      timeline={timeline}
      onTimelineChange={handleTimelineChange}
      contextView={contextView}
      onContextViewChange={setContextView}
      labelDensity={labelDensity}
      onLabelDensityChange={setLabelDensity}
      groups={groups}
      onGroupsChange={setGroups}
    />
  );

  return (
    <div className="flex h-full min-h-0 flex-col md:flex-row">
      {/* ================================================================ */}
      {/* DESKTOP: left rail controls (always visible >= md)                */}
      {/* ================================================================ */}
      <div className="hidden md:flex">{controlsPanel}</div>

      {/* ================================================================ */}
      {/* MOBILE: slide-up controls drawer (< md)                          */}
      {/* ================================================================ */}
      {mobileControlsOpen && (
        <>
          {/* Backdrop */}
          <div
            aria-hidden="true"
            className="absolute inset-0 z-30 bg-neutral-950/70 backdrop-blur-sm md:hidden"
            onClick={() => setMobileControlsOpen(false)}
          />
          {/* Drawer slides up from bottom */}
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Graph controls"
            className="absolute bottom-0 left-0 right-0 z-40 max-h-[80dvh] overflow-y-auto rounded-t-2xl border-t border-neutral-800 bg-neutral-950 md:hidden motion-safe:animate-slide-up"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            {/* Drag handle */}
            <div className="flex justify-center py-2">
              <div className="h-1 w-10 rounded-full bg-neutral-700" aria-hidden="true" />
            </div>
            <div className="flex items-center justify-between border-b border-neutral-800 px-4 pb-3">
              <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                Graph controls
              </span>
              <button
                type="button"
                onClick={() => setMobileControlsOpen(false)}
                aria-label="Close controls"
                className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
              >
                <CloseIcon />
              </button>
            </div>
            {/* Controls content rendered without the aside outer wrapper */}
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
              onZoomToFit={() => {
                canvasRef.current?.zoomToFit();
                setMobileControlsOpen(false);
              }}
              onResetView={() => {
                canvasRef.current?.resetView();
                setMobileControlsOpen(false);
              }}
              filters={filters}
              dispatch={dispatch}
              availableTags={facets.tags}
              availableFolders={facets.folders}
              availableLinkTypes={facets.linkTypes}
              timeline={timeline}
              onTimelineChange={handleTimelineChange}
              contextView={contextView}
              onContextViewChange={setContextView}
              labelDensity={labelDensity}
              onLabelDensityChange={setLabelDensity}
              groups={groups}
              onGroupsChange={setGroups}
            />
          </div>
        </>
      )}

      {/* ================================================================ */}
      {/* Canvas area                                                       */}
      {/* ================================================================ */}
      <div className="relative flex min-w-0 flex-1 flex-col">
        {/* Header */}
        <header className="flex shrink-0 items-center justify-between border-b border-neutral-800 bg-neutral-950 px-3 py-2.5 sm:px-4">
          <div className="flex min-w-0 items-center gap-2">
            {/* Mobile controls toggle button */}
            <button
              type="button"
              onClick={() => setMobileControlsOpen(true)}
              aria-label="Open graph controls"
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-neutral-800 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200 md:hidden"
            >
              <ControlsIcon />
            </button>
            <div className="min-w-0">
              <h1 className="text-sm font-semibold text-neutral-100">Graph</h1>
              <p className="truncate text-xs text-neutral-500">
                {mode === 'local' && selectedNode
                  ? `Local · ${selectedNode.title} · depth ${localDepth}`
                  : 'Global'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* v3: active-mode pills */}
            {contextView && (
              <span className="hidden rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-medium text-blue-300 sm:inline">
                context
              </span>
            )}
            {colorMode === 'cluster' && (
              <span className="hidden rounded bg-violet-500/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-300 sm:inline">
                cluster
              </span>
            )}
            {/* v4: groups active pill */}
            {groups.length > 0 && (
              <span className="hidden rounded bg-rose-500/15 px-1.5 py-0.5 text-[10px] font-medium text-rose-300 sm:inline">
                {groups.length} {groups.length === 1 ? 'group' : 'groups'}
              </span>
            )}
            <NodeCount shown={shownNodes} total={totalNodes} truncated={payload.truncated} />
          </div>
        </header>

        <div className="relative min-h-0 flex-1">
          {totalNodes === 0 ? (
            <EmptyState message="This vault has no notes yet. Create your first note to see the graph." />
          ) : shownNodes === 0 ? (
            <EmptyState
              message="No notes match the current filters."
              hint="Try removing some tag, folder, or date filters."
            />
          ) : (
            <>
              <ForceGraphCanvas
                model={model}
                selectedId={selectedId}
                physics={physics}
                handleRef={canvasRef}
                onSelect={handleSelect}
                onOpen={(node) => node.path && openNote(node.path)}
                searchIds={searchIds}
                timelineIds={timelineIds}
                onPinnedChange={handlePinnedChange}
                contextView={contextView}
              />
              <GraphLegend
                colorMode={colorMode}
                categories={model.presentCategories}
                tags={facets.tags}
                clusterInfo={clusterInfo}
                groups={groups}
              />
              {/* Floating overlay controls: search (top-right) and zoom (bottom-right). */}
              <div className="pointer-events-none absolute inset-0 flex flex-col p-2 sm:p-3">
                {/* Top-right: search bar */}
                <div className="flex justify-end">
                  <GraphSearch
                    query={searchQuery}
                    matchCount={searchMatchCount}
                    onQueryChange={setSearchQuery}
                  />
                </div>
                {/* Bottom-right: zoom + unpin controls */}
                <div className="mt-auto flex justify-end">
                  <GraphZoomControls
                    onZoomIn={() => canvasRef.current?.zoomIn()}
                    onZoomOut={() => canvasRef.current?.zoomOut()}
                    onFit={() => canvasRef.current?.zoomToFit()}
                    hasPinnedNodes={pinnedIds.size > 0}
                    onUnpinAll={handleUnpinAll}
                  />
                </div>
              </div>
            </>
          )}
        </div>
      </div>

      {/* ================================================================ */}
      {/* Node panel — desktop: right side panel; mobile: bottom drawer     */}
      {/* ================================================================ */}
      {selectedNode && (
        <>
          {/* Desktop node panel */}
          <div className="hidden md:flex">
            <NodePanel
              node={selectedNode}
              index={index}
              isLocalFocus={mode === 'local'}
              onFocusLocal={handleFocusLocal}
              onSelect={handleSelect}
              onOpen={openNote}
            />
          </div>
          {/* Mobile node panel — slides up from bottom */}
          <div
            className="absolute bottom-0 left-0 right-0 z-20 max-h-[55dvh] overflow-y-auto rounded-t-2xl border-t border-neutral-800 bg-neutral-950 shadow-2xl md:hidden"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            {/* Drag handle + close */}
            <div className="flex items-center justify-between px-4 py-2">
              <div className="h-1 w-10 rounded-full bg-neutral-700" aria-hidden="true" />
              <button
                type="button"
                onClick={() => handleSelect(null)}
                aria-label="Close node panel"
                className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300"
              >
                <CloseIcon />
              </button>
            </div>
            <NodePanel
              node={selectedNode}
              index={index}
              isLocalFocus={mode === 'local'}
              onFocusLocal={handleFocusLocal}
              onSelect={handleSelect}
              onOpen={openNote}
            />
          </div>
        </>
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
    <div className="shrink-0 text-right text-xs">
      <span className="text-neutral-300">
        {truncated || shown < total ? `${shown}/${total}` : `${total}`}
        <span className="hidden sm:inline"> nodes</span>
      </span>
      {truncated && (
        <span className="ml-1.5 hidden rounded bg-amber-500/15 px-1.5 py-0.5 text-amber-300 sm:inline">
          cap {DEFAULT_NODE_CAP}
        </span>
      )}
    </div>
  );
}

function EmptyState({ message, hint }: { message: string; hint?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center">
      <svg
        className="h-10 w-10 text-neutral-700"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.2}
        aria-hidden
      >
        <circle cx="12" cy="12" r="9" />
        <path strokeLinecap="round" d="M8 12h8M12 8v8" opacity={0.4} />
      </svg>
      <p className="text-sm text-neutral-500">{message}</p>
      {hint && <p className="text-xs text-neutral-700">{hint}</p>}
    </div>
  );
}

function CloseIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path strokeLinecap="round" d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function ControlsIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path strokeLinecap="round" d="M2 4h12M4 8h8M6 12h4" />
    </svg>
  );
}
