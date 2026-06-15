'use client';

/**
 * The canvas force-directed renderer. This is the only component that touches
 * `react-force-graph-2d` (which depends on the DOM/canvas), so the page loads
 * it via `next/dynamic` with `ssr: false` to keep `next build` server-safe.
 *
 * It is intentionally presentational: it receives an already-computed payload
 * plus styling callbacks and emits hover/select events. All graph logic
 * (index build, filtering, local/global) lives in the page + engine.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';

import { colorForKey, GRAPH_NEUTRAL } from '../../lib/graph/model';
import type { GraphEdge, GraphNode } from '@graphvault/engine';

/** A node enriched for rendering (the force lib mutates x/y/vx/vy at runtime). */
export interface RenderNode {
  id: string;
  title: string;
  /** Category key used to colour the node (e.g. its first tag). */
  colorKey?: string;
  /** Degree, used to scale the node size. */
  degree: number;
}

interface RenderLink {
  source: string;
  target: string;
  type: string;
}

export interface ForceGraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Currently selected node id, if any. */
  selectedId: string | null;
  /** Maps a node to the key used for its colour (tag-based). */
  colorKeyForNode: (node: GraphNode) => string | undefined;
  onSelect: (id: string | null) => void;
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

export default function ForceGraphCanvas({
  nodes,
  edges,
  selectedId,
  colorKeyForNode,
  onSelect,
}: ForceGraphCanvasProps) {
  const [containerRef, size] = useElementSize();
  const [hoverId, setHoverId] = useState<string | null>(null);

  // Build the renderer's data. Keyed by the node/edge identity so the force
  // simulation is only rebuilt when the underlying graph actually changes,
  // not on hover/selection re-renders (which would thrash the layout).
  const graphData = useMemo(() => {
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const rNodes: RenderNode[] = nodes.map((n) => ({
      id: n.id,
      title: n.title,
      colorKey: colorKeyForNode(n),
      degree: degree.get(n.id) ?? 0,
    }));
    const rLinks: RenderLink[] = edges.map((e) => ({
      source: e.source,
      target: e.target,
      type: e.type,
    }));
    return { nodes: rNodes, links: rLinks };
    // colorKeyForNode is derived from filters; identity changes only with them.
  }, [nodes, edges, colorKeyForNode]);

  // Neighbours of the hovered/selected node, for highlight emphasis.
  const neighbours = useMemo(() => {
    const focus = hoverId ?? selectedId;
    if (!focus) return null;
    const set = new Set<string>([focus]);
    for (const e of edges) {
      if (e.source === focus) set.add(e.target);
      else if (e.target === focus) set.add(e.source);
    }
    return { focus, set };
  }, [hoverId, selectedId, edges]);

  if (size.w === 0 || size.h === 0) {
    // First paint: container measured on the next tick.
    return <div ref={containerRef} className="h-full w-full" />;
  }

  return (
    <div ref={containerRef} className="h-full w-full">
      <ForceGraph2D
        width={size.w}
        height={size.h}
        graphData={graphData}
        backgroundColor="#0a0a0a"
        cooldownTicks={120}
        warmupTicks={20}
        nodeRelSize={4}
        linkColor={(link) => {
          const l = link as unknown as RenderLink;
          if (!neighbours) return 'rgba(120,120,130,0.25)';
          const lit =
            (typeof l.source === 'object' ? (l.source as RenderNode).id : (l.source as string)) ===
              neighbours.focus ||
            (typeof l.target === 'object' ? (l.target as RenderNode).id : (l.target as string)) ===
              neighbours.focus;
          return lit ? 'rgba(160,170,190,0.7)' : 'rgba(120,120,130,0.08)';
        }}
        linkDirectionalArrowLength={3}
        linkDirectionalArrowRelPos={1}
        onNodeHover={(node) => setHoverId(node ? (node as RenderNode).id : null)}
        onNodeClick={(node) => onSelect(node ? (node as RenderNode).id : null)}
        onBackgroundClick={() => onSelect(null)}
        nodeCanvasObject={(node, ctx, globalScale) => {
          const n = node as RenderNode & { x?: number; y?: number };
          if (n.x === undefined || n.y === undefined) return;
          const base = 3 + Math.min(6, Math.sqrt(n.degree));
          const isSelected = n.id === selectedId;
          const dimmed = neighbours !== null && !neighbours.set.has(n.id);
          const color = n.colorKey ? colorForKey(n.colorKey) : GRAPH_NEUTRAL;

          ctx.globalAlpha = dimmed ? 0.25 : 1;
          ctx.beginPath();
          ctx.arc(n.x, n.y, base, 0, 2 * Math.PI, false);
          ctx.fillStyle = color;
          ctx.fill();
          if (isSelected) {
            ctx.lineWidth = 2 / globalScale;
            ctx.strokeStyle = '#f4f4f5';
            ctx.stroke();
          }

          // Label only when zoomed in enough, or when focused, to stay legible.
          const focused = neighbours !== null && neighbours.set.has(n.id);
          if (globalScale > 1.6 || isSelected || focused) {
            const fontSize = Math.max(10 / globalScale, 2);
            ctx.font = `${fontSize}px ui-sans-serif, system-ui, sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'top';
            ctx.fillStyle = dimmed ? '#52525b' : '#d4d4d8';
            ctx.fillText(n.title, n.x, n.y + base + 1);
          }
          ctx.globalAlpha = 1;
        }}
        nodePointerAreaPaint={(node, color, ctx) => {
          const n = node as RenderNode & { x?: number; y?: number };
          if (n.x === undefined || n.y === undefined) return;
          const base = 3 + Math.min(6, Math.sqrt(n.degree));
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.arc(n.x, n.y, base + 2, 0, 2 * Math.PI, false);
          ctx.fill();
        }}
      />
    </div>
  );
}
