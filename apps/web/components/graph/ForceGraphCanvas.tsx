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
 * v3 (Lumen) additions — all additive, no v1/v2 regression:
 * - Radial-gradient node fill: rich centre → transparent edge, giving a soft
 *   3-D "glow dot" appearance without canvas shadow overhead.
 * - Soft outer ring: a faint outline ring at `radius * 1.45` that gives hubs
 *   extra visual mass without dominating small nodes.
 * - Halo labels: white text drawn twice (once slightly offset in a "shadow"
 *   colour) for legibility on any background, replacing the old flat label.
 * - DPR-aware drawing: all pixel-level measurements (line widths, font sizes,
 *   pin glyphs) are divided by `globalScale` so they remain visually consistent
 *   at any zoom level on retina / HiDPI screens. The force-graph library
 *   handles the canvas backing-store scaling automatically.
 * - Edge opacity by relationship type: wikilink ≥ markdown > typed-relation
 *   edges; unresolved links stay dashed at a lower opacity.
 * - Context view: when a node is selected, distant nodes (non-neighbours) fade
 *   to near-invisible so the selected neighbourhood reads as a distinct "island".
 *   The effect stacks correctly with timeline dimming and search dimming.
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
import { makePositioningForce, type PositioningForce } from '../../lib/graph/forces';
import type { RenderLink, RenderModel, RenderNode } from '../../lib/graph/model';

/** Imperative handle the page can use to drive the view (zoom-to-fit, reset, zoom in/out). */
export interface ForceGraphHandle {
  zoomToFit: () => void;
  resetView: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  /**
   * Unpin every node: clears `fx`/`fy` on all nodes and reheats the simulation
   * so the freed nodes settle back into the layout. Returns the previously
   * pinned node ids so the caller can keep external state in sync.
   */
  unpinAll: () => void;
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
   * Set of node IDs visible in the current timeline window. When non-null,
   * nodes not in this set are faded to indicate they are outside the selected
   * time range. Null = timeline not active.
   */
  timelineIds?: Set<string> | null;
  /**
   * Called when the set of pinned node IDs changes. The page uses this to show
   * the "Unpin all" control and to expose the pin state to the imperative handle.
   */
  onPinnedChange?: (pinned: Set<string>) => void;
  /**
   * v3: When true, non-neighbour nodes are faded to near-invisible when a node
   * is hovered or selected, creating a focused "context view" of the
   * neighbourhood. Does not affect layout. Default false.
   */
  contextView?: boolean;
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

/**
 * Alpha level for nodes that are "in context" (non-focused, no search active,
 * context view on). They are visible but subordinate.
 */
const CONTEXT_DIM_ALPHA = 0.08;

/**
 * Alpha for nodes dimmed by the standard hover/search/timeline mechanism (still
 * readable but clearly de-emphasised).
 */
const DIM_ALPHA = 0.12;

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

/**
 * Parse a hex colour (#rrggbb) into {r,g,b} integers. Returns {r:156,g:163,b:175}
 * (neutral grey) as a safe fallback for any unrecognised string.
 */
function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return { r: 156, g: 163, b: 175 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

/**
 * Draw a node using a radial gradient fill (rich centre → transparent edge)
 * plus a faint outer ring for structural weight. Returns the canvas state
 * restored to what it was before the call.
 */
function drawNodeGradient(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
  color: string,
  isPlaceholder: boolean,
  isSelected: boolean,
  globalScale: number,
) {
  const { r, g, b } = hexToRgb(color);

  if (isPlaceholder) {
    // Faint, outlined disc for attachments / missing notes.
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI, false);
    ctx.fillStyle = '#0a0a0a';
    ctx.fill();
    ctx.lineWidth = 1.4 / globalScale;
    ctx.strokeStyle = color;
    ctx.stroke();
  } else {
    // Radial gradient: opaque centre, fading toward the edge.
    const grad = ctx.createRadialGradient(
      x - radius * 0.25,
      y - radius * 0.25,
      radius * 0.05,
      x,
      y,
      radius,
    );
    grad.addColorStop(0, `rgba(${r},${g},${b},1)`);
    grad.addColorStop(0.55, `rgba(${r},${g},${b},0.92)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0.55)`);

    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI, false);
    ctx.fillStyle = grad;
    ctx.fill();

    // Soft outer ring: visible halo at 1.45× radius.
    const ringRadius = radius * 1.45;
    ctx.beginPath();
    ctx.arc(x, y, ringRadius, 0, 2 * Math.PI, false);
    ctx.strokeStyle = `rgba(${r},${g},${b},0.18)`;
    ctx.lineWidth = 1.2 / globalScale;
    ctx.stroke();
  }

  // Selected: crisp white ring directly over the node.
  if (isSelected) {
    ctx.beginPath();
    ctx.arc(x, y, radius + 1.5 / globalScale, 0, 2 * Math.PI, false);
    ctx.lineWidth = 2 / globalScale;
    ctx.strokeStyle = '#f4f4f5';
    ctx.stroke();
  }
}

/**
 * Draw a label with a "halo" (white shadow pass then solid text pass) so it
 * reads cleanly on any background colour.
 */
function drawHaloLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  isDimmed: boolean,
  isPlaceholder: boolean,
) {
  const textColor = isDimmed ? '#52525b' : isPlaceholder ? '#9ca3af' : '#d4d4d8';

  ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  if (!isDimmed) {
    // Halo pass: slightly thicker, near-black, drawn offset to simulate a shadow.
    ctx.fillStyle = 'rgba(10,10,10,0.85)';
    for (const [dx, dy] of [
      [-0.8, 0],
      [0.8, 0],
      [0, -0.8],
      [0, 0.8],
    ] as [number, number][]) {
      ctx.fillText(text, x + dx, y + dy);
    }
  }

  // Foreground text pass.
  ctx.fillStyle = textColor;
  ctx.fillText(text, x, y);
}

export default function ForceGraphCanvas({
  model,
  selectedId,
  physics,
  handleRef,
  onSelect,
  onOpen,
  searchIds,
  timelineIds,
  onPinnedChange,
  contextView = false,
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

  // Keep a live ref to the current graph data so imperative handlers (e.g.
  // unpinAll) can reach the exact node objects the force lib mutates in place.
  const graphDataRef = useRef(graphData);
  graphDataRef.current = graphData;

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

    // Centre gravity via x/y positioning forces toward the origin. force-graph
    // does not register these by default, so we lazily register our own
    // dependency-free positioning forces the first time and just retune their
    // strength on subsequent updates. This makes the "Centre gravity" slider a
    // real, layout-affecting control rather than a no-op.
    let fx = fg.d3Force('x') as PositioningForce | undefined;
    if (!fx || typeof fx.strength !== 'function') {
      fx = makePositioningForce('x', 0);
      fg.d3Force('x', fx);
    }
    fx.strength(physics.centerGravity);
    let fy = fg.d3Force('y') as PositioningForce | undefined;
    if (!fy || typeof fy.strength !== 'function') {
      fy = makePositioningForce('y', 0);
      fg.d3Force('y', fy);
    }
    fy.strength(physics.centerGravity);

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
      unpinAll: () => {
        const fg = fgRef.current;
        if (!fg) return;
        // Delete fx/fy on every node so the simulation can move them again. The
        // force lib mutates these exact node objects in place, so clearing them
        // on our `graphData.nodes` reference unpins the live simulation.
        for (const node of graphDataRef.current.nodes as LiveNode[]) {
          delete node.fx;
          delete node.fy;
        }
        // Clear internal pin state and notify the page so the glyphs/control update.
        if (pinnedRef.current.size > 0) {
          pinnedRef.current = new Set();
          onPinnedChange?.(new Set());
        }
        // Reheat so the freed nodes settle back into the layout.
        fg.d3ReheatSimulation();
      },
    }),
    [reducedMotion, onPinnedChange],
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
  const timelineIdsRef = useRef(timelineIds);
  timelineIdsRef.current = timelineIds;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const contextViewRef = useRef(contextView);
  contextViewRef.current = contextView;

  const nodeCanvasObject = useCallback(
    (node: object, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const n = node as LiveNode;
      if (n.x === undefined || n.y === undefined) return;
      const radius = radiusForDegree(n.degree);
      const currentFocus = focusRef.current;
      const currentSearchIds = searchIdsRef.current;
      const currentSelectedId = selectedIdRef.current;
      const currentContextView = contextViewRef.current;

      const isSelected = n.id === currentSelectedId;
      const isFocused = currentFocus !== null && currentFocus.set.has(n.id);
      const isPinned = pinnedRef.current.has(n.id);
      const isPlaceholder = n.category !== 'note';
      const currentTimelineIds = timelineIdsRef.current;

      // Dimming logic:
      // 1. Timeline: if active, nodes outside the window are faded first.
      // 2. Search: if active, overrides hover dimming (non-matches dim).
      // 3. Hover/focus: non-neighbours dim when a node is hovered/selected.
      // 4. Context view: when no hover but a node is selected, non-neighbours
      //    fade more aggressively to isolate the focused island.
      // Focus (hover/selected neighbours) always overrides timeline dimming so
      // the user can still explore by clicking even with the slider on.
      const timelineDimmed =
        currentTimelineIds !== null &&
        currentTimelineIds !== undefined &&
        !currentTimelineIds.has(n.id) &&
        !isFocused;

      let dimmed: boolean;
      let dimAlpha = DIM_ALPHA;

      if (currentSearchIds !== null && currentSearchIds !== undefined) {
        dimmed = (!currentSearchIds.has(n.id) && !isFocused) || timelineDimmed;
      } else if (currentContextView && currentFocus !== null && !isFocused) {
        // Context view: all non-neighbours fade very aggressively.
        dimmed = true;
        dimAlpha = CONTEXT_DIM_ALPHA;
      } else {
        dimmed = (currentFocus !== null && !isFocused) || timelineDimmed;
      }

      // Performance: suppress label rendering in dense graphs unless important.
      const isSearchMatch = currentSearchIds?.has(n.id) ?? false;
      const forceLabel = isFocused || isSelected || isSearchMatch;
      const showLabelDense = !denseGraph || forceLabel;

      ctx.globalAlpha = dimmed ? dimAlpha : 1;

      // v1 preserved: Hover/selection glow around the focused node + neighbours.
      if (isFocused && !reducedMotion) {
        ctx.save();
        ctx.shadowColor = n.color;
        ctx.shadowBlur = (n.id === currentFocus?.id ? 22 : 12) / globalScale;
        ctx.beginPath();
        ctx.arc(n.x, n.y, radius, 0, 2 * Math.PI, false);
        ctx.fillStyle = n.color;
        ctx.fill();
        ctx.restore();
      }

      // v2 preserved: Search-match highlight ring.
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

      // v3: Radial gradient node body + soft outer ring.
      ctx.save();
      drawNodeGradient(ctx, n.x, n.y, radius, n.color, isPlaceholder, isSelected, globalScale);
      ctx.restore();

      // v2 preserved: Pin glyph — a small dot drawn above the node.
      if (isPinned) {
        const pinSize = Math.max(4 / globalScale, 1.5);
        ctx.save();
        ctx.globalAlpha = dimmed ? dimAlpha : 0.9;
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
        ctx.save();
        ctx.globalAlpha = dimmed ? dimAlpha : 1;
        // v3: Halo label for legibility on any background.
        drawHaloLabel(ctx, n.title, n.x, n.y + radius + 1, fontSize, dimmed, isPlaceholder);
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    },
    // focusRef, searchIdsRef, timelineIdsRef, selectedIdRef, contextViewRef and
    // pinnedRef are intentionally read via refs so this callback can be stable —
    // it only needs to rebuild when the label threshold, density flag, or
    // reduced-motion preference changes.
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

          // v3: opacity by relationship type.
          // wikilink: most opaque; markdown: slightly less; typed relations: more subtle.
          let baseOpacity: number;
          if (!l.resolved) {
            baseOpacity = 0.15;
          } else if (l.type === 'wikilink') {
            baseOpacity = 0.32;
          } else if (l.type === 'markdown') {
            baseOpacity = 0.26;
          } else {
            // typed relation (references, refutes, etc.)
            baseOpacity = 0.22;
          }

          if (!focus)
            return dashed
              ? `rgba(120,120,130,${baseOpacity * 0.6})`
              : `rgba(120,120,130,${baseOpacity})`;
          const lit = endpointId(l.source) === focus.id || endpointId(l.target) === focus.id;
          if (lit) return dashed ? 'rgba(190,160,120,0.75)' : 'rgba(170,185,215,0.9)';
          return `rgba(120,120,130,${baseOpacity * 0.22})`;
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
