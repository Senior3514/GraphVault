'use client';

/**
 * /embed - Shareable, read-only, chromeless graph view.
 *
 * Purpose (Roadmap M20):
 *   A user copies a `/embed?s=<snapshot>` URL (or pastes the accompanying
 *   <iframe> snippet) to share a static view of their knowledge graph.
 *   No note bodies are ever included - only titles and link topology.
 *
 * How it works:
 *   1. The URL carries a compact, base64url-encoded snapshot (see
 *      `apps/web/lib/embed/snapshot.ts`). The embed page decodes it on load.
 *   2. Alternatively a SHORT, server-backed link `?id=<id>&srv=<serverOrigin>`
 *      (Wave 18) fetches the same opaque payload from the server's opt-in
 *      snapshot store, then decodes it through the same path. The `srv` origin
 *      is validated as http(s) before any fetch (see `lib/embed/shareLink.ts`).
 *   3. If neither `s=` nor `id=`+`srv=` is present, it falls back to reading the
 *      user's current local vault (so you can preview the embed before sharing).
 *   3. The snapshot is converted to a `RenderModel` and handed to a dynamically
 *      loaded `ForceGraphCanvas` (canvas stays `ssr: false`).
 *
 * Interaction:
 *   - Pan, zoom, and hover labels are enabled.
 *   - No editing, no sidebar, no AI, no sync - this is purely a visual read.
 *   - Node click selects and shows a minimal tooltip; double-click does nothing.
 *
 * CSP / framing note:
 *   The current vercel.json sets `frame-ancestors 'none'`, which prevents
 *   third-party sites from embedding this page in an <iframe>. To allow
 *   embedding on external sites, the site operator must relax that directive
 *   (e.g. `frame-ancestors *` or specific origins). The snapshot URL itself
 *   is unconditionally shareable - anyone with the link can open it directly.
 *   See `apps/web/vercel.json` and `apps/web/app/layout.tsx` for CSP config.
 *
 * The page uses `position: fixed; inset: 0; z-index: 9999` to cover the app
 * shell (sidebar, header) so it appears full-bleed - suitable for an iframe.
 * This avoids editing any shared layout component.
 */

import dynamic from 'next/dynamic';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import { buildIndex, filterGraph, type GraphNode, type GraphEdge } from '@graphvault/engine';

import type { ForceGraphHandle } from '../../components/graph/ForceGraphCanvas';
import { GraphLoadingSkeleton } from '../../components/graph/GraphLoadingSkeleton';
import { buildRenderModel } from '../../lib/graph/model';
import type { RenderModel } from '../../lib/graph/model';
import { DEFAULT_PHYSICS } from '../../lib/graph/physics';
import {
  decodeSnapshot,
  SnapshotDecodeError,
  SnapshotTooLargeError,
  type EmbedSnapshot,
} from '../../lib/embed/snapshot';
import { fetchSnapshot, ShareLinkError } from '../../lib/embed/shareLink';
import { useVaultContext } from '../../lib/vault/VaultProvider';
import { notesToInputs } from '../../lib/graph/model';

// Canvas/DOM-only renderer: never server-rendered. The heavy
// `react-force-graph-2d` library loads in its own chunk only when the embed
// graph mounts; until then we show the shared themed, motion-safe skeleton.
const ForceGraphCanvas = dynamic(() => import('../../components/graph/ForceGraphCanvas'), {
  ssr: false,
  loading: () => <GraphLoadingSkeleton />,
});

// ---------------------------------------------------------------------------
// Snapshot → engine shapes
// ---------------------------------------------------------------------------

/**
 * Convert a decoded `EmbedSnapshot` back to the GraphNode/GraphEdge arrays
 * that `buildRenderModel` consumes. Nodes have no tags, folder, or timestamps -
 * only id, path (same as id) and title.
 */
function snapshotToGraphShapes(snapshot: EmbedSnapshot): {
  nodes: GraphNode[];
  edges: GraphEdge[];
} {
  const nodes: GraphNode[] = snapshot.n.map((sn) => ({
    id: sn.i,
    path: sn.i,
    title: sn.t,
    tags: [],
    folder: '',
  }));

  const kindToType: Record<'w' | 'm' | 'r', string> = {
    w: 'wikilink',
    m: 'markdown',
    r: 'relation',
  };

  const edges: GraphEdge[] = snapshot.e.map((se) => ({
    source: se.s,
    target: se.t,
    type: kindToType[se.k],
    resolved: true,
  }));

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Inner page (needs Suspense boundary for useSearchParams in static export)
// ---------------------------------------------------------------------------

function EmbedInner() {
  const searchParams = useSearchParams();
  const encoded = searchParams.get('s');
  // Short server-backed link: `?id=<id>&srv=<serverOrigin>`. The `srv` origin is
  // validated as http(s) inside `fetchSnapshot` (SSRF/junk guard) before any
  // request is made. The long `s=` link takes precedence when both are present.
  const shortId = searchParams.get('id');
  const shortSrv = searchParams.get('srv');

  const vault = useVaultContext();

  // State: either loading, or a model + optional error.
  const [model, setModel] = useState<RenderModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const canvasRef = useRef<ForceGraphHandle>(null);

  // Build the render model: either from the URL snapshot or from the local vault.
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);

      try {
        let nodes: GraphNode[];
        let edges: GraphEdge[];

        if (encoded) {
          // Long URL snapshot path: decode the self-contained `s=` payload.
          const snapshot = await decodeSnapshot(encoded);
          const shapes = snapshotToGraphShapes(snapshot);
          nodes = shapes.nodes;
          edges = shapes.edges;
        } else if (shortId && shortSrv) {
          // Short server-backed path: fetch the opaque payload from the snapshot
          // store, then decode it through the SAME path as the `s=` case.
          const data = await fetchSnapshot(shortSrv, shortId);
          const snapshot = await decodeSnapshot(data);
          const shapes = snapshotToGraphShapes(snapshot);
          nodes = shapes.nodes;
          edges = shapes.edges;
        } else {
          // Fallback: current local vault (preview mode for the owner).
          if (!vault.ready) {
            // Vault not yet loaded - wait.
            setLoading(true);
            return;
          }
          const index = buildIndex(notesToInputs(vault.notes));
          const payload = filterGraph(index, { includeUnresolved: false });
          nodes = payload.nodes;
          edges = payload.edges;
        }

        if (cancelled) return;

        const built = buildRenderModel(nodes, edges, {
          colorMode: 'type',
          includeUnresolved: false,
        });
        setModel(built);
      } catch (err) {
        if (cancelled) return;
        if (
          err instanceof SnapshotTooLargeError ||
          err instanceof SnapshotDecodeError ||
          err instanceof ShareLinkError
        ) {
          setError(`Could not load graph: ${err.message}`);
        } else {
          setError('An unexpected error occurred while loading the graph.');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [encoded, shortId, shortSrv, vault.ready, vault.notes]);

  const handleSelect = useCallback((id: string | null) => {
    setSelectedId(id);
  }, []);

  // No-op open handler: embed is read-only, double-click does nothing.
  const handleOpen = useCallback(() => {
    /* read-only */
  }, []);

  const selectedNode = model?.nodes.find((n) => n.id === selectedId) ?? null;

  // Derive node count for the badge.
  const nodeCount = model?.nodes.length ?? 0;

  return (
    // Full-bleed overlay covering the app shell (sidebar, top bar) completely.
    // z-50 puts this above the sidebar (z-40 in AppShell drawer) and above the
    // mobile top bar. This makes the embed appear chrome-free without touching
    // any shared layout component.
    <div
      className="fixed inset-0 z-50 flex flex-col bg-neutral-950"
      aria-label="Embedded knowledge graph"
    >
      {/* Minimal status bar - just the node count and a "GraphVault" wordmark */}
      <div className="flex shrink-0 items-center justify-between border-b border-neutral-900 px-3 py-1.5">
        <span className="text-[11px] font-medium tracking-wider text-neutral-600 select-none">
          GraphVault
        </span>
        {!loading && !error && (
          <span className="text-[11px] text-neutral-700 select-none">
            {nodeCount} {nodeCount === 1 ? 'node' : 'nodes'}
          </span>
        )}
      </div>

      {/* Canvas area */}
      <div className="relative min-h-0 flex-1">
        {loading ? (
          <Centered>
            <LoadingDots />
          </Centered>
        ) : error ? (
          <Centered>
            <p className="max-w-xs text-center text-xs text-red-400">{error}</p>
          </Centered>
        ) : model && model.nodes.length === 0 ? (
          <Centered>
            <p className="text-xs text-neutral-600">No notes to display.</p>
          </Centered>
        ) : model ? (
          <>
            <ForceGraphCanvas
              model={model}
              selectedId={selectedId}
              physics={DEFAULT_PHYSICS}
              handleRef={canvasRef}
              onSelect={handleSelect}
              onOpen={handleOpen}
            />
            {/* Minimal hover tooltip for the selected node */}
            {selectedNode && (
              <div className="pointer-events-none absolute bottom-3 left-0 right-0 flex justify-center px-4">
                <div className="max-w-xs truncate rounded-md border border-neutral-800 bg-neutral-900/90 px-3 py-1.5 text-xs text-neutral-300 backdrop-blur-sm">
                  {selectedNode.title}
                </div>
              </div>
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Root export - wrapped in Suspense for useSearchParams (static export requirement)
// ---------------------------------------------------------------------------

export default function EmbedPage() {
  return (
    <Suspense
      fallback={
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-950">
          <LoadingDots />
        </div>
      }
    >
      <EmbedInner />
    </Suspense>
  );
}

// ---------------------------------------------------------------------------
// Small presentational helpers
// ---------------------------------------------------------------------------

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="flex h-full w-full items-center justify-center">{children}</div>;
}

function LoadingDots() {
  return (
    <div className="flex gap-1.5" aria-label="Loading" role="status">
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="inline-block h-1.5 w-1.5 rounded-full bg-neutral-700 motion-safe:animate-pulse"
          style={{ animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}
