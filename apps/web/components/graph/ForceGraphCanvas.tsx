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
 * v3 (Lumen) additions - all additive, no v1/v2 regression:
 * - Radial-gradient node fill: rich centre → transparent edge, giving a soft
 *   3-D "glow dot" appearance without canvas shadow overhead.
 * - Soft outer ring: a faint outline ring at `radius * 1.45` that gives hubs
 *   extra visual mass without dominating small nodes.
 * - Halo labels: text drawn with a single crisp stroked outline (see v4 below
 *   for why this replaced the original stacked-copy technique) for legibility
 *   on any background.
 * - DPR-aware drawing: all pixel-level measurements (line widths, font sizes,
 *   pin glyphs) are divided by `globalScale` so they remain visually consistent
 *   at any zoom level on retina / HiDPI screens. The force-graph library
 *   handles the canvas backing-store scaling automatically (verified: canvas
 *   backing `width`/`height` == CSS size × `devicePixelRatio` at 1x/2x/3x).
 * - Edge opacity by relationship type: wikilink ≥ markdown > typed-relation
 *   edges; unresolved links stay dashed at a lower opacity.
 * - Context view: when a node is selected, distant nodes (non-neighbours) fade
 *   to near-invisible so the selected neighbourhood reads as a distinct "island".
 *   The effect stacks correctly with timeline dimming and search dimming.
 *
 * v4 (graph-fix-2) - label declutter + halo cleanup. Screenshotting the app
 * (dark/light, HiDPI, a busy 45-note vault) showed two real problems: dense
 * neighbourhoods produced totally illegible stacks of overlapping labels, and
 * every label rendered with a smeared "double text" ghost. DPR/node-body
 * rendering were re-checked and found already correct (see above) - not
 * touched.
 * - Real label collision avoidance: `onRenderFramePre` runs a greedy placement
 *   pass once per frame (`lib/graph/labelLayout.ts`) so labels never stack on
 *   top of each other. Selected/hovered/focused/search-matched nodes always
 *   keep their label and are placed first; everything else is placed by
 *   degree (highest first), skipped if it would collide with an already-
 *   placed label's bounding box. `nodeCanvasObject` just reads the precomputed
 *   per-frame result instead of a purely local per-node decision.
 * - `drawHaloLabel` no longer draws 4 offset copies of the shadow colour (that
 *   read as a blurry duplicate "ghost" of the text at most zoom levels); it
 *   strokes a single crisp outline behind the fill text instead.
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
import { selectVisibleLabels, type LabelCandidate } from '../../lib/graph/labelLayout';
import type { RenderLink, RenderModel, RenderNode } from '../../lib/graph/model';
import { useGraphThemeColors, type GraphThemeColors } from '../../lib/graph/useThemeColors';

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
 * Mix two rgb colours by `t` ∈ [0,1] (0 = a, 1 = b). Used to give node cores a
 * brighter highlight than their rim so they read as lit spheres, not flat discs.
 */
function mixRgb(
  a: { r: number; g: number; b: number },
  b: { r: number; g: number; b: number },
  t: number,
): { r: number; g: number; b: number } {
  return {
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  };
}

/**
 * Draw a node as a lit sphere: a soft ambient halo whose strength scales with
 * the node's importance (degree), a radial-gradient body with a bright,
 * off-centre highlight, and a crisp rim that gives it edge definition. Hubs get
 * a noticeably stronger halo so visual weight tracks structural importance.
 *
 * `glow` 0..1 scales the resting halo (driven by degree, gated off under
 * reduced-motion / dense graphs by the caller passing 0).
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
  theme: GraphThemeColors,
  glow: number,
) {
  const base = hexToRgb(color);
  const { r, g, b } = base;

  if (isPlaceholder) {
    // Faint, outlined disc for attachments / missing notes - hollow ring so it
    // reads as "not a real note yet" against either theme's background.
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI, false);
    ctx.fillStyle = theme.placeholderFill;
    ctx.fill();
    ctx.setLineDash([2.4 / globalScale, 2.4 / globalScale]);
    ctx.lineWidth = 1.3 / globalScale;
    ctx.strokeStyle = `rgba(${r},${g},${b},0.75)`;
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  // Resting halo: a soft, wide glow behind hubs so they feel alive at rest.
  if (glow > 0.001) {
    const haloR = radius * (2.0 + glow * 1.6);
    const halo = ctx.createRadialGradient(x, y, radius * 0.6, x, y, haloR);
    halo.addColorStop(0, `rgba(${r},${g},${b},${0.16 * glow})`);
    halo.addColorStop(0.5, `rgba(${r},${g},${b},${0.07 * glow})`);
    halo.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.beginPath();
    ctx.arc(x, y, haloR, 0, 2 * Math.PI, false);
    ctx.fillStyle = halo;
    ctx.fill();
  }

  // Body: lit sphere. Bright off-centre core → base colour → slightly darker
  // rim so the node has dimensionality instead of reading as a flat dot.
  const core = mixRgb(base, { r: 255, g: 255, b: 255 }, 0.45);
  const rim = mixRgb(base, { r: 0, g: 0, b: 0 }, 0.18);
  const grad = ctx.createRadialGradient(
    x - radius * 0.35,
    y - radius * 0.35,
    radius * 0.05,
    x,
    y,
    radius,
  );
  grad.addColorStop(0, `rgb(${core.r | 0},${core.g | 0},${core.b | 0})`);
  grad.addColorStop(0.45, `rgb(${r},${g},${b})`);
  grad.addColorStop(1, `rgb(${rim.r | 0},${rim.g | 0},${rim.b | 0})`);

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI, false);
  ctx.fillStyle = grad;
  ctx.fill();

  // Crisp rim stroke: a hairline of the base colour at higher alpha defines the
  // sphere's edge cleanly at any zoom.
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, 2 * Math.PI, false);
  ctx.strokeStyle = `rgba(${r},${g},${b},0.55)`;
  ctx.lineWidth = 0.8 / globalScale;
  ctx.stroke();

  // Selected: a crisp brand-accent ring with a thin background gap so it reads
  // on any node colour in either theme.
  if (isSelected) {
    const ring = hexToRgb(theme.accentBright);
    ctx.beginPath();
    ctx.arc(x, y, radius + 2.4 / globalScale, 0, 2 * Math.PI, false);
    ctx.lineWidth = 1.6 / globalScale;
    ctx.strokeStyle = theme.background;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, radius + 2.4 / globalScale, 0, 2 * Math.PI, false);
    ctx.lineWidth = 2 / globalScale;
    ctx.strokeStyle = `rgb(${ring.r},${ring.g},${ring.b})`;
    ctx.stroke();
  }
}

/**
 * The label font stack, shared between the draw pass and the per-frame
 * placement pass (`ctx.measureText` must use the exact same font the text
 * will actually be drawn with, or measured widths won't match rendered ones).
 */
const LABEL_FONT_FAMILY = 'ui-sans-serif, system-ui, sans-serif';

/**
 * Draw a label with a "halo" so it reads cleanly on any background colour or
 * edge crossing.
 *
 * This used to draw 4 solid copies of the halo colour offset by a fixed 0.8
 * (world-space, i.e. NOT scaled by zoom) amount before the real text pass. At
 * most zoom levels that offset was either too small to read as a halo or big
 * enough to read as a second, slightly-shifted, smeared copy of the text - a
 * "ghosting" artefact that was a real contributor to the "labels look gross"
 * complaint (confirmed by screenshotting the built app). A single stroked
 * outline behind the fill text is the standard technique for this and has
 * neither problem: it scales cleanly with font size and never looks doubled.
 */
function drawHaloLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fontSize: number,
  isDimmed: boolean,
  isPlaceholder: boolean,
  theme: GraphThemeColors,
) {
  const textColor = isDimmed
    ? theme.labelDimmed
    : isPlaceholder
      ? theme.labelPlaceholder
      : theme.labelText;

  ctx.font = `${fontSize}px ${LABEL_FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  if (!isDimmed) {
    // Halo: a single crisp outline, proportional to the font size so it holds
    // up at any zoom level without turning into a thick blob or vanishing.
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.lineWidth = Math.max(fontSize * 0.3, 1);
    ctx.strokeStyle = theme.labelHalo;
    ctx.strokeText(text, x, y);
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
  const themeColors = useGraphThemeColors();

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

  // Highest degree in the model, used to normalise the resting hub glow so the
  // most-connected node always reads as the brightest regardless of vault size.
  const maxDegree = useMemo(() => {
    let max = 1;
    for (const n of model.nodes) if (n.degree > max) max = n.degree;
    return max;
  }, [model.nodes]);

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

  // Memoised nodeCanvasObject callback - avoid closure recreation on every
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
  const themeRef = useRef(themeColors);
  themeRef.current = themeColors;
  const maxDegreeRef = useRef(maxDegree);
  maxDegreeRef.current = maxDegree;

  // v4: the set of node ids whose label should be drawn THIS frame, decided
  // once up-front (see `onRenderFramePre` below) rather than independently
  // per node - this is what makes real label-collision avoidance possible.
  const labelVisibleRef = useRef<Set<string>>(new Set());

  // Runs once per animation frame, before any node/link is drawn (force-graph
  // calls this with the same transformed `ctx` that `nodeCanvasObject` later
  // draws into, so world-space coordinates line up exactly). Builds the
  // candidate list, greedily declutters it, and stashes the result in
  // `labelVisibleRef` for `nodeCanvasObject` to read per node.
  const onRenderFramePre = useCallback(
    (ctx: CanvasRenderingContext2D, globalScale: number) => {
      const nodes = graphDataRef.current.nodes as LiveNode[];
      const currentFocus = focusRef.current;
      const currentSearchIds = searchIdsRef.current;
      const currentSelectedId = selectedIdRef.current;
      // Non-focused candidates still respect the existing zoom-scaled
      // threshold control; focused/selected/search-matched nodes bypass it.
      const zoomEligible = shouldShowLabel({
        globalScale,
        threshold: physics.labelThreshold,
        isFocused: false,
      });

      const fontSize = Math.max(10 / globalScale, 2);
      // Set the exact font the labels will be drawn with so measureText widths
      // (used for collision boxes) match the real rendered glyphs.
      ctx.font = `${fontSize}px ${LABEL_FONT_FAMILY}`;
      const measureTextWidth = (text: string) => ctx.measureText(text).width;

      const candidates: LabelCandidate[] = [];
      for (const n of nodes) {
        if (n.x === undefined || n.y === undefined) continue;
        const isSelected = n.id === currentSelectedId;
        const isFocused = currentFocus !== null && currentFocus.set.has(n.id);
        const isSearchMatch = currentSearchIds?.has(n.id) ?? false;
        const forced = isFocused || isSelected || isSearchMatch;
        // Performance: in dense graphs, only forced labels are ever
        // candidates (matches the old `denseGraph` suppression); everything
        // else additionally needs the zoom threshold.
        if (!forced && (denseGraph || !zoomEligible)) continue;
        candidates.push({
          id: n.id,
          x: n.x,
          y: n.y,
          radius: radiusForDegree(n.degree),
          text: n.title,
          forced,
          priority: n.degree,
        });
      }

      labelVisibleRef.current = selectVisibleLabels(candidates, fontSize, measureTextWidth);
    },
    [physics.labelThreshold, denseGraph],
  );

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
      const isFocusCentre = currentFocus !== null && currentFocus.id === n.id;
      const isPinned = pinnedRef.current.has(n.id);
      const isPlaceholder = n.category !== 'note';
      const currentTimelineIds = timelineIdsRef.current;
      const theme = themeRef.current;

      // On-brand note colour: in "type" colour mode every note carries the
      // CATEGORY_STYLE cyan, which we re-resolve from the live `--accent-400`
      // token so notes stay correct when the theme flips (the model's static hex
      // is only the dark-theme fallback). Tag / cluster / group colours and
      // placeholder colours are left untouched.
      const fill = n.category === 'note' && n.color === '#1fafc6' ? theme.accent : n.color;

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

      const isSearchMatch = currentSearchIds?.has(n.id) ?? false;

      ctx.globalAlpha = dimmed ? dimAlpha : 1;

      // Resting glow strength: hubs glow more so visual weight tracks structural
      // importance even before any interaction. Suppressed in dense graphs and
      // under reduced-motion (kept calm + cheap). Focused nodes get a strong,
      // unmistakable glow on top.
      let glow = 0;
      if (!isPlaceholder && !reducedMotion && !denseGraph) {
        const norm = Math.min(1, Math.sqrt(n.degree) / Math.sqrt(maxDegreeRef.current));
        glow = 0.18 + norm * 0.5;
      }
      if (isFocused) {
        // Hover/selection: lift the focused node + its neighbours with a clearly
        // stronger glow so the highlighted subgraph reads instantly.
        glow = Math.max(glow, isFocusCentre ? 1 : 0.7);
      }

      // Focused-centre pulse ring: a soft accent ring just outside the node so
      // the actively hovered/selected node is obvious among its lit neighbours.
      if (isFocusCentre && !reducedMotion) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(n.x, n.y, radius + 3 / globalScale, 0, 2 * Math.PI, false);
        ctx.strokeStyle = `rgba(255,255,255,0.5)`;
        ctx.lineWidth = 1 / globalScale;
        ctx.stroke();
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

      // Lit-sphere node body (halo + gradient + rim + selection ring).
      ctx.save();
      drawNodeGradient(
        ctx,
        n.x,
        n.y,
        radius,
        fill,
        isPlaceholder,
        isSelected,
        globalScale,
        theme,
        glow,
      );
      ctx.restore();

      // v2 preserved: Pin glyph - a small dot drawn above the node.
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

      // v4: label visibility is decided once per frame in `onRenderFramePre`
      // (greedy collision avoidance across the whole graph), not locally here.
      if (labelVisibleRef.current.has(n.id)) {
        const fontSize = Math.max(10 / globalScale, 2);
        ctx.save();
        ctx.globalAlpha = dimmed ? dimAlpha : 1;
        // v3: Halo label for legibility on any background.
        drawHaloLabel(
          ctx,
          n.title,
          n.x,
          n.y + radius + 1,
          fontSize,
          dimmed,
          isPlaceholder,
          themeRef.current,
        );
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    },
    // focusRef, searchIdsRef, timelineIdsRef, selectedIdRef, contextViewRef,
    // pinnedRef and labelVisibleRef are intentionally read via refs so this
    // callback can be stable - it only needs to rebuild when the density flag
    // or reduced-motion preference changes (label visibility itself is now
    // decided per-frame in `onRenderFramePre`, not here).
    [denseGraph, reducedMotion],
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
        backgroundColor={themeColors.background}
        cooldownTicks={reducedMotion ? 0 : 160}
        warmupTicks={reducedMotion ? 0 : 40}
        d3AlphaDecay={0.0228}
        d3VelocityDecay={0.42}
        nodeRelSize={4}
        minZoom={0.4}
        maxZoom={8}
        onEngineStop={() => fgRef.current?.zoomToFit(reducedMotion ? 0 : 300, 48)}
        linkColor={(link) => {
          const l = link as LiveLink;
          const dashed = !l.resolved;
          const { r, g, b } = themeColors.edge;

          // Base presence by relationship type so connections actually read at
          // rest (the old values washed out, especially in light theme).
          // wikilink: most opaque; markdown: slightly less; typed relations: subtler.
          let baseOpacity: number;
          if (!l.resolved) {
            baseOpacity = 0.22;
          } else if (l.type === 'wikilink') {
            baseOpacity = 0.42;
          } else if (l.type === 'markdown') {
            baseOpacity = 0.34;
          } else {
            baseOpacity = 0.3;
          }

          if (!focus) {
            return `rgba(${r},${g},${b},${dashed ? baseOpacity * 0.65 : baseOpacity})`;
          }
          // When a node is focused, edges touching it light up in brand accent
          // and everything else recedes so the connected subgraph is obvious.
          const lit = endpointId(l.source) === focus.id || endpointId(l.target) === focus.id;
          if (lit) {
            const a = hexToRgb(themeColors.accentBright);
            return `rgba(${a.r},${a.g},${a.b},${dashed ? 0.65 : 0.95})`;
          }
          return `rgba(${r},${g},${b},${baseOpacity * 0.18})`;
        }}
        linkLineDash={(link) => ((link as LiveLink).resolved ? null : [3, 3])}
        linkWidth={(link) => {
          const l = link as LiveLink;
          if (!focus) return 1.1;
          const lit = endpointId(l.source) === focus.id || endpointId(l.target) === focus.id;
          return lit ? 2.6 : 0.9;
        }}
        linkCurvature={(link) => {
          const l = link as LiveLink;
          const key = [endpointId(l.source), endpointId(l.target)].sort().join('|||');
          // Multi-edges fan apart; single edges get a faint, consistent bow so
          // the layout reads as organic arcs rather than a rigid web.
          return multiEdgePairs.has(key) ? 0.28 : 0.08;
        }}
        linkDirectionalArrowLength={(link) => {
          const l = link as LiveLink;
          if (!l.resolved) return 0;
          if (!focus) return 2.6;
          const lit = endpointId(l.source) === focus.id || endpointId(l.target) === focus.id;
          return lit ? 4.2 : 2;
        }}
        linkDirectionalArrowColor={(link) => {
          const l = link as LiveLink;
          const { r, g, b } = themeColors.edge;
          if (focus) {
            const lit = endpointId(l.source) === focus.id || endpointId(l.target) === focus.id;
            if (lit) {
              const a = hexToRgb(themeColors.accentBright);
              return `rgba(${a.r},${a.g},${a.b},0.95)`;
            }
          }
          return `rgba(${r},${g},${b},0.5)`;
        }}
        linkDirectionalArrowRelPos={0.92}
        linkDirectionalParticles={(link) => {
          // A single particle flows along edges of the focused node so active
          // relationships feel alive. Off under reduced-motion and at rest.
          if (reducedMotion || !focus) return 0;
          const l = link as LiveLink;
          const lit =
            l.resolved && (endpointId(l.source) === focus.id || endpointId(l.target) === focus.id);
          return lit ? 2 : 0;
        }}
        linkDirectionalParticleWidth={2}
        linkDirectionalParticleSpeed={0.006}
        linkDirectionalParticleColor={() => {
          const a = hexToRgb(themeColors.accentBright);
          return `rgba(${a.r},${a.g},${a.b},0.95)`;
        }}
        onNodeHover={(node) => setHoverId(node ? (node as LiveNode).id : null)}
        onNodeClick={(node) => handleNodeClick(node as LiveNode | null)}
        onNodeDragEnd={(node) => handleNodeDragEnd(node as LiveNode)}
        onBackgroundClick={() => onSelect(null)}
        onRenderFramePre={onRenderFramePre}
        nodeCanvasObject={nodeCanvasObject}
        nodePointerAreaPaint={nodePointerAreaPaint}
      />
    </div>
  );
}
