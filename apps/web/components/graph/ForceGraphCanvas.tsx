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
 * Interaction:
 * - single click  → select (side panel)
 * - double click  → open the note (deep link, handled by the page)
 * - hover         → glow the node + neighbours, smoothly dim the rest
 */

import { useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import ForceGraph2D, { type ForceGraphMethods } from 'react-force-graph-2d';

import { type GraphPhysics, radiusForDegree, shouldShowLabel } from '../../lib/graph/physics';
import type { RenderLink, RenderModel, RenderNode } from '../../lib/graph/model';

/** Imperative handle the page can use to drive the view (zoom-to-fit, reset). */
export interface ForceGraphHandle {
  zoomToFit: () => void;
  resetView: () => void;
}

export interface ForceGraphCanvasProps {
  model: RenderModel;
  /** Currently selected node id, if any. */
  selectedId: string | null;
  /** Live simulation + label tunables. */
  physics: GraphPhysics;
  /** Imperative handle for zoom-to-fit / reset buttons. */
  handleRef?: React.Ref<ForceGraphHandle>;
  /** Single click → select (or null on background). */
  onSelect: (id: string | null) => void;
  /** Double click / explicit open → navigate to the note (only for real notes). */
  onOpen: (node: RenderNode) => void;
}

/** Internal: the link object after the force lib resolves source/target. */
type LiveLink = RenderLink & {
  source: string | RenderNode;
  target: string | RenderNode;
};

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
}: ForceGraphCanvasProps) {
  const [containerRef, size] = useElementSize();
  const [hoverId, setHoverId] = useState<string | null>(null);
  const reducedMotion = usePrefersReducedMotion();

  const fgRef = useRef<ForceGraphMethods<RenderNode, LiveLink> | undefined>(undefined);

  // Distinguish single from double click: a double-click fires two `onNodeClick`
  // events, so defer the single-click select and cancel it if a second arrives.
  const clickTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (clickTimer.current) clearTimeout(clickTimer.current);
    };
  }, []);

  // Build the renderer's data once per model identity. The force lib mutates
  // x/y/vx/vy in place, so we must not rebuild on hover/selection re-renders
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
    }),
    [reducedMotion],
  );

  const handleNodeClick = (node: RenderNode | null) => {
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
  };

  if (size.w === 0 || size.h === 0) {
    // First paint: container measured on the next tick.
    return <div ref={containerRef} className="h-full w-full" />;
  }

  return (
    <div ref={containerRef} className="h-full w-full">
      <ForceGraph2D<RenderNode, LiveLink>
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
        linkDirectionalArrowLength={(link) => ((link as LiveLink).resolved ? 3 : 0)}
        linkDirectionalArrowRelPos={1}
        onNodeHover={(node) => setHoverId(node ? (node as RenderNode).id : null)}
        onNodeClick={(node) => handleNodeClick(node as RenderNode | null)}
        onBackgroundClick={() => onSelect(null)}
        nodeCanvasObject={(node, ctx, globalScale) => {
          const n = node as RenderNode & { x?: number; y?: number };
          if (n.x === undefined || n.y === undefined) return;
          const radius = radiusForDegree(n.degree);
          const isSelected = n.id === selectedId;
          const isFocused = focus !== null && focus.set.has(n.id);
          const dimmed = focus !== null && !isFocused;
          const isPlaceholder = n.category !== 'note';

          ctx.globalAlpha = dimmed ? 0.18 : 1;

          // Hover/selection glow around the focused node + neighbours.
          if (isFocused && !reducedMotion) {
            ctx.save();
            ctx.shadowColor = n.color;
            ctx.shadowBlur = (n.id === focus?.id ? 18 : 10) / globalScale;
            ctx.beginPath();
            ctx.arc(n.x, n.y, radius, 0, 2 * Math.PI, false);
            ctx.fillStyle = n.color;
            ctx.fill();
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

          if (shouldShowLabel({ globalScale, threshold: physics.labelThreshold, isFocused })) {
            const fontSize = Math.max(10 / globalScale, 2);
            ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillStyle = dimmed ? '#52525b' : isPlaceholder ? '#9ca3af' : '#d4d4d8';
            ctx.fillText(n.title, n.x, n.y + radius + 1);
          }
          ctx.globalAlpha = 1;
        }}
        nodePointerAreaPaint={(node, color, ctx) => {
          const n = node as RenderNode & { x?: number; y?: number };
          if (n.x === undefined || n.y === undefined) return;
          const radius = radiusForDegree(n.degree);
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(n.x, n.y, radius + 2, 0, 2 * Math.PI, false);
          ctx.fill();
        }}
      />
    </div>
  );
}
