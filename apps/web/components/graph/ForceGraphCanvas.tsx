'use client';

/**
 * The canvas force-directed renderer. This is the only component that touches
 * `react-force-graph-2d` (which depends on the DOM/canvas), so the page loads
 * it via `next/dynamic` with `ssr: false` to keep `next build` server-safe.
 *
 * It is intentionally presentational: it receives an already-computed render
 * model (nodes + links with category/colour/degree from `lib/graph/model`)
 * plus live physics tunables, and emits select / open events. All graph logic
 * (index build, filtering, local/global, categorisation) lives upstream.
 *
 * v1 features (preserved):
 * - colour-by-kind via `colorForKind` mapping on the node's `color` field
 * - hover → glow the node + neighbours, smoothly dim the rest
 * - live physics, zoom-to-fit, double-click-open
 *
 * v2 additions:
 * - Drag-to-pin: dragging a node sets `fx`/`fy`; a pin glyph is drawn; clicking
 *   a pinned node unpins it.
 * - Search highlight: a `searchIds` set dims non-matching nodes.
 * - Zoom in/out via the imperative handle.
 * - Link curvature for multi-edges between the same pair.
 * - Performance: labels suppressed when node count exceeds `LABEL_NODE_CAP`.
 *
 * Interaction:
 * - single click  → select (side panel); click a pinned node → unpin
 * - double click  → open the note (deep link, handled by the page)
 * - hover         → glow the node + neighbours, smoothly dim the rest
 * - drag          → fix the node position (pin); the simulation still runs
 */

import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d';

import { type GraphPhysics, radiusForDegree, shouldShowLabel } from '../../lib/graph/physics';
import type { RenderLink, RenderModel, RenderNode } from '../../lib/graph/model';

/** Imperative handle the page can use to drive the view (zoom-to-fit, reset, zoom in/out). */
export interface ForceGraphHandle {
  zoomToFit: () => void;
  resetView: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

export interface ForceGraphCanvasProps {
  model: RenderModel;
  /** Currently selected node id, if any. */
  selectedId: string | null;
  /** Live simulation + label tunables. */
  physics: GraphPhysics;
  /** Imperative handle for zoom-to-fit / reset / zoom-in / zoom-out buttons. */
  handleRef?: React.Ref<ForceGraphHandle>;
  /** Single click → select (or null on background). */
  onSelect: (id: string | null) => void;
  /** Double click / explicit open → navigate to the note (only for real notes). */
  onOpen: (node: RenderNode) => void;
  /**
   * Set of node IDs that match the current search query. When non-null, nodes
   * not in this set are dimmed. Null = no search active.
   */
  searchIds?: Set<string> | null;
  /**
   * Called when the set of pinned node IDs changes. The page uses this to show
   * the "Unpin all" control and to expose the pin state to the imperative handle.
   */
  onPinnedChange?: (pinned: Set<string>) => void;
}

/** Internal: the link object after the force lib resolves source/target. */
type LiveLink = RenderLink & {
  source: string | RenderNode;
  target: string | RenderNode;
};

/** Internal node with runtime position + pin fields mutated by the force lib. */
type LiveNode = RenderNode & {
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number;
  fy?: number;
};

/**
 * Suppress labels when the node count is very high to keep canvas rendering
 * fast. Focused/searched/selected nodes are always labelled regardless.
 */
const LABEL_NODE_CAP = 200;

/** Zoom step multiplier for the +/- buttons. */
const ZOOM_STEP = 1.4;

function endpointId(end: string | RenderNode): string {
  return typeof end === 'object' ? end.id : end;
}

/** Observe a container's size so the canvas fills it responsively. */
function useElementSize(): [React.RefObject<HTMLDivElement | null>, { w: number; h: number }] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) setSize({ w: Math.floor(rect.width), h: Math.floor(rect.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, size];
}

/** Respect the user's reduced-motion preference (no warmup, no glow churn). */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setReduced(mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  }, []);
  return reduced;
}

export default function ForceGraphCanvas({
  model,
  selectedId,
  physics,
  handleRef,
  onSelect,
  onOpen,
  searchIds,
  onPinnedChange,
}: ForceGraphCanvasProps) {
  const [containerRef, size] = useElementSize();
  const [hoverId, setHoverId] = useState<string | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  const fgRef = useRef<ForceGraphMethods<LiveNode, LiveLink> | undefined>(undefined);

  // Track pinned nodes (those with fx/fy set). Stored as a Set<string> so the
  // page can react to changes (show "Unpin all", etc.).
  const pinnedRef = useRef<Set<string>>(new Set());

  // Distinguish single from double click: a double-click fires two `onNodeClick`
  // events, so defer the single-click select and cancel it if a second arrives.
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (clickTimer.current) clearTimeout(clickTimer.current);
    };
  }, []);

  // Build the renderer's data once per model identity. The force lib mutates
  // x/y/vx/vy/fx/fy in place, so we must not rebuild on hover/selection re-renders
  // (that would thrash the layout). We shallow-copy each node/link so React's
  // referential reuse of the model array doesn't carry stale positions across
  // graph changes.
  const graphData = useMemo(
    () => ({
      nodes: model.nodes.map((n) => ({ ...n })),
      links: model.links.map((l) => ({ ...l })),
    }),
    [model],
  );

  // Clear pin state when the model changes (new filter / mode switch).
  useEffect(() => {
    pinnedRef.current = new Set();
    onPinnedChange?.(new Set());
  }, [model, onPinnedChange]);

  // Adjacency for the highlight set, derived from the same links.
  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      let set = map.get(a);
      if (!set) {
        set = new Set();
        map.set(a, set);
      }
      set.add(b);
    };
    for (const l of model.links) {
      add(l.source, l.target);
      add(l.target, l.source);
    }
    return map;
  }, [model.links]);

  // Detect multi-edges between the same pair (for curvature).
  const multiEdgePairs = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of model.links) {
      const key = [l.source, l.target].sort().join('|||');
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const pairs = new Set<string>();
    for (const [key, count] of counts) {
      if (count > 1) pairs.add(key);
    }
    return pairs;
  }, [model.links]);

  // The focus + neighbour set (hover takes precedence over selection).
  const focus = useMemo(() => {
    const id = hoverId ?? selectedId;
    if (!id) return null;
    const set = new Set<string>([id]);
    for (const nb of adjacency.get(id) ?? []) set.add(nb);
    return { id, set };
  }, [hoverId, selectedId, adjacency]);

  // Apply live physics to the d3 forces whenever the tunables change.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    const link = fg.d3Force('link');
    if (link && typeof link.distance === 'function') link.distance(physics.linkDistance);
    const charge = fg.d3Force('charge');
    if (charge && typeof charge.strength === 'function') charge.strength(physics.chargeStrength);
    // Centre gravity via x/y positioning forces toward the origin.
    const fx = fg.d3Force('x');
    if (fx && typeof fx.strength === 'function') fx.strength(physics.centerGravity);
    const fy = fg.d3Force('y');
    if (fy && typeof fy.strength === 'function') fy.strength(physics.centerGravity);
    fg.d3ReheatSimulation();
  }, [physics.linkDistance, physics.chargeStrength, physics.centerGravity, graphData]);

  // Expose imperative view controls to the page.
  useImperativeHandle(
    handleRef,
    () => ({
      zoomToFit: () => fgRef.current?.zoomToFit(reducedMotion ? 0 : 400, 48),
      resetView: () => {
        const fg = fgRef.current;
        if (!fg) return;
        fg.centerAt(0, 0, reducedMotion ? 0 : 400);
        fg.zoom(1, reducedMotion ? 0 : 400);
      },
      zoomIn: () => {
        const fg = fgRef.current;
        if (!fg) return;
        const current: number = (fg.zoom() as number | undefined) ?? 1;
        fg.zoom(current * ZOOM_STEP, reducedMotion ? 0 : 200);
      },
      zoomOut: () => {
        const fg = fgRef.current;
        if (!fg) return;
        const current: number = (fg.zoom() as number | undefined) ?? 1;
        fg.zoom(current / ZOOM_STEP, reducedMotion ? 0 : 200);
      },
    }),
    [reducedMotion],
  );

  // Whether labels should be globally suppressed for performance.
  const denseGraph = model.nodes.length > LABEL_NODE_CAP;

  const handleNodeClick = useCallback(
    (node: LiveNode | null) => {
      // If the clicked node is pinned, unpin it first and cancel any navigation.
      if (node && pinnedRef.current.has(node.id)) {
        delete node.fx;
        delete node.fy;
        const next = new Set(pinnedRef.current);
        next.delete(node.id);
        pinnedRef.current = next;
        onPinnedChange?.(new Set(next));
        fgRef.current?.d3ReheatSimulation();
        // Also select the node so the panel shows (without opening it).
        onSelect(node.id);
        return;
      }
      if (clickTimer.current) {
        // Second click within the window → treat as double-click → open.
        clearTimeout(clickTimer.current);
        clickTimer.current = null;
        if (node && node.category === 'note') onOpen(node);
        return;
      }
      clickTimer.current = setTimeout(() => {
        clickTimer.current = null;
        onSelect(node ? node.id : null);
      }, 220);
    },
    [onSelect, onOpen, onPinnedChange],
  );

  const handleNodeDragEnd = useCallback(
    (node: LiveNode) => {
      // Fix the node's position to freeze it after a drag.
      node.fx = node.x;
      node.fy = node.y;
      const next = new Set(pinnedRef.current);
      next.add(node.id);
      pinnedRef.current = next;
      onPinnedChange?.(new Set(next));
    },
    [onPinnedChange],
  );

  // Memoised nodeCanvasObject callback — avoid closure recreation on every
  // hover/selection change by reading refs for the transient state.
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const searchIdsRef = useRef(searchIds);
  searchIdsRef.current = searchIds;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;

  const nodeCanvasObject = useCallback(
    (node: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const n = node as LiveNode;
      if (n.x === undefined || n.y === undefined) return;
      const radius = radiusForDegree(n.degree);
      const currentFocus = focusRef.current;
      const currentSearchIds = searchIdsRef.current;
      const currentSelectedId = selectedIdRef.current;

      const isSelected = n.id === currentSelectedId;
      const isFocused = currentFocus !== null && currentFocus.set.has(n.id);
      const isPinned = pinnedRef.current.has(n.id);
      const isPlaceholder = n.category !== 'note';

      // Dimming logic: search overrides hover/focus dimming when active.
      let dimmed: boolean;
      if (currentSearchIds !== null && currentSearchIds !== undefined) {
        dimmed = !currentSearchIds.has(n.id) && !isFocused;
      } else {
        dimmed = currentFocus !== null && !isFocused;
      }

      // Performance: suppress label rendering in dense graphs unless important.
      const isSearchMatch = currentSearchIds?.has(n.id) ?? false;
      const forceLabel = isFocused || isSelected || isSearchMatch;
      const showLabelDense = !denseGraph || forceLabel;

      ctx.globalAlpha = dimmed ? 0.12 : 1;

      // v1: Hover/selection glow around the focused node + neighbours.
      if (isFocused && !reducedMotion) {
        ctx.save();
        ctx.shadowColor = n.color;
        ctx.shadowBlur = (n.id === currentFocus?.id ? 18 : 10) / globalScale;
        ctx.beginPath();
        ctx.arc(n.x, n.y, radius, 0, 2 * Math.PI, false);
        ctx.fillStyle = n.color;
        ctx.fill();
        ctx.restore();
      }

      // v2: Search-match highlight ring.
      if (isSearchMatch && currentSearchIds !== null && !isFocused && !reducedMotion) {
        ctx.save();
        ctx.shadowColor = '#f4d03f';
        ctx.shadowBlur = 14 / globalScale;
        ctx.beginPath();
        ctx.arc(n.x, n.y, radius + 1.5 / globalScale, 0, 2 * Math.PI, false);
        ctx.strokeStyle = '#f4d03f';
        ctx.lineWidth = 1.5 / globalScale;
        ctx.stroke();
        ctx.restore();
      }

      ctx.beginPath();
      ctx.arc(n.x, n.y, radius, 0, 2 * Math.PI, false);
      if (isPlaceholder) {
        // Faint, outlined disc for attachments / missing notes.
        ctx.fillStyle = '#0a0a0a';
        ctx.fill();
        ctx.lineWidth = 1.4 / globalScale;
        ctx.strokeStyle = n.color;
        ctx.stroke();
      } else {
        ctx.fillStyle = n.color;
        ctx.fill();
      }

      if (isSelected) {
        ctx.lineWidth = 2 / globalScale;
        ctx.strokeStyle = '#f4f4f5';
        ctx.stroke();
      }

      // v2: Pin glyph — a small pushpin drawn above the node.
      if (isPinned) {
        const pinSize = Math.max(4 / globalScale, 1.5);
        ctx.save();
        ctx.globalAlpha = dimmed ? 0.12 : 0.9;
        ctx.fillStyle = '#fbbf24'; // amber-400
        ctx.beginPath();
        ctx.arc(n.x, n.y - radius - pinSize * 0.7, pinSize * 0.55, 0, 2 * Math.PI);
        ctx.fill();
        ctx.strokeStyle = '#78350f';
        ctx.lineWidth = 0.8 / globalScale;
        ctx.stroke();
        ctx.restore();
      }

      if (
        showLabelDense &&
        shouldShowLabel({ globalScale, threshold: physics.labelThreshold, isFocused: forceLabel })
      ) {
        const fontSize = Math.max(10 / globalScale, 2);
        ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = dimmed ? '#52525b' : isPlaceholder ? '#9ca3af' : '#d4d4d8';
        ctx.fillText(n.title, n.x, n.y + radius + 1);
      }
      ctx.globalAlpha = 1;
    },
    // focusRef, searchIdsRef, selectedIdRef and pinnedRef are intentionally
    // read via refs so this callback can be stable — it only needs to rebuild
    // when the label threshold, density flag, or reduced-motion preference changes.
    [physics.labelThreshold, denseGraph, reducedMotion],
  );

  const nodePointerAreaPaint = useCallback(
    (node: object, color: string, ctx: CanvasRenderingContext2D) => {
      const n = node as LiveNode;
      if (n.x === undefined || n.y === undefined) return;
      const radius = radiusForDegree(n.degree);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(n.x, n.y, radius + 2, 0, 2 * Math.PI, false);
      ctx.fill();
    },
    [],
  );

  if (size.w === 0 || size.h === 0) {
    // First paint: container measured on the next tick.
    return <div ref={containerRef} className="h-full w-full" />;
  }

  return (
    <div ref={containerRef} className="h-full w-full">
      <ForceGraph2D<LiveNode, LiveLink>
        ref={fgRef}
        width={size.w}
        height={size.h}
        graphData={graphData}
        backgroundColor="#0a0a0a"
        cooldownTicks={reducedMotion ? 0 : 140}
        warmupTicks={reducedMotion ? 0 : 24}
        d3AlphaDecay={0.022}
        d3VelocityDecay={0.32}
        nodeRelSize={4}
        minZoom={0.4}
        maxZoom={8}
        onEngineStop={() => fgRef.current?.zoomToFit(reducedMotion ? 0 : 300, 48)}
        linkColor={(link) => {
          const l = link as LiveLink;
          const dashed = !l.resolved;
          if (!focus) return dashed ? 'rgba(120,120,130,0.18)' : 'rgba(120,120,130,0.28)';
          const lit = endpointId(l.source) === focus.id || endpointId(l.target) === focus.id;
          if (lit) return dashed ? 'rgba(190,160,120,0.75)' : 'rgba(170,185,215,0.85)';
          return 'rgba(120,120,130,0.06)';
        }}
        linkLineDash={(link) => ((link as LiveLink).resolved ? null : [3, 3])}
        linkWidth={(link) => {
          const l = link as LiveLink;
          if (!focus) return 1;
          const lit = endpointId(l.source) === focus.id || endpointId(l.target) === focus.id;
          return lit ? 2 : 1;
        }}
        linkCurvature={(link) => {
          const l = link as LiveLink;
          const key = [endpointId(l.source), endpointId(l.target)].sort().join('|||');
          return multiEdgePairs.has(key) ? 0.25 : 0;
        }}
        linkDirectionalArrowLength={(link) => ((link as LiveLink).resolved ? 3 : 0)}
        linkDirectionalArrowRelPos={1}
        onNodeHover={(node) => setHoverId(node ? (node as LiveNode).id : null)}
        onNodeClick={(node) => handleNodeClick(node as LiveNode | null)}
        onNodeDragEnd={(node) => handleNodeDragEnd(node as LiveNode)}
        onBackgroundClick={() => onSelect(null)}
        nodeCanvasObject={nodeCanvasObject}
        nodePointerAreaPaint={nodePointerAreaPaint}
      />
    </div>
  );
}
