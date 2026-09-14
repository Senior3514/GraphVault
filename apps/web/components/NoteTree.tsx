'use client';

/**
 * Recursive folder/file tree for the vault sidebar - virtualized.
 *
 * Performance design:
 * - The tree is flattened to a linear list of visible rows on each render
 *   using `flattenTree` from `lib/vault/virtualList`. This is O(visible) not
 *   O(total).
 * - Only the rows that fall inside the scroll viewport (+ overscan) are
 *   mounted in the DOM. A top/bottom padding spacer keeps the scrollbar
 *   correct without rendering off-screen nodes.
 * - `buildTree` is called once per `notes` change via `useMemo`, not on
 *   every render.
 * - Folder open/closed state lives in a `Set<path>` of CLOSED folders so
 *   toggling is O(1).
 *
 * Behavior preserved from the original:
 * - All folders default to open.
 * - Active note is highlighted.
 * - Click selects; folder button toggles open/closed.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { buildTree, type TreeNode } from '../lib/vault/vault';
import { computeVirtualWindow, flattenTree, type FlatRow } from '../lib/vault/virtualList';
import type { IndexedNote, NotePath } from '../lib/vault/types';

interface NoteTreeProps {
  notes: IndexedNote[];
  activePath: NotePath | null;
  onSelect(path: NotePath): void;
}

/** Fixed px height of every row (folder heading or file leaf). Keep in sync with row classes. */
const ROW_HEIGHT = 28;

/** Number of extra rows rendered above/below the visible region to smooth fast scrolling. */
const OVERSCAN = 8;

export function NoteTree({ notes, activePath, onSelect }: NoteTreeProps) {
  // Set of paths of CLOSED folders (empty = all folders open by default).
  const [closedFolders, setClosedFolders] = useState<ReadonlySet<string>>(new Set());

  const containerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(600);
  // Coalesces `scroll` events (which can fire far more often than the
  // display's refresh rate during a fast fling) down to one state update -
  // and one virtualization recompute + re-render - per animation frame.
  const scrollRafRef = useRef<number | null>(null);

  // Rebuild tree only when notes change - O(n) but amortized.
  const tree = useMemo(() => buildTree(notes), [notes]);

  // Flatten the visible tree to a linear row list - O(visible nodes).
  const rows = useMemo(
    () =>
      flattenTree<TreeNode>(
        tree,
        (node) => node.children ?? [],
        (node) => !closedFolders.has(node.path),
      ),
    [tree, closedFolders],
  );

  // Track container dimensions so we know the viewport height.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // Read initial size.
    setViewportHeight(el.clientHeight || 600);

    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setViewportHeight(entry.contentRect.height);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    if (scrollRafRef.current !== null) return; // already scheduled for this frame
    scrollRafRef.current = requestAnimationFrame(() => {
      scrollRafRef.current = null;
      if (containerRef.current) setScrollTop(containerRef.current.scrollTop);
    });
  }, []);

  // Cancel any in-flight rAF on unmount so it never fires against a
  // detached container.
  useEffect(() => {
    return () => {
      if (scrollRafRef.current !== null) cancelAnimationFrame(scrollRafRef.current);
    };
  }, []);

  // Scroll the active note into view whenever it changes.
  useEffect(() => {
    if (!activePath || !containerRef.current) return;
    const idx = rows.findIndex((r) => r.item.path === activePath);
    if (idx === -1) return;
    const top = idx * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    const el = containerRef.current;
    if (top < el.scrollTop) {
      el.scrollTop = top;
    } else if (bottom > el.scrollTop + el.clientHeight) {
      el.scrollTop = bottom - el.clientHeight;
    }
  }, [activePath, rows]);

  const toggleFolder = useCallback((path: string) => {
    setClosedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  if (notes.length === 0) {
    return <p className="px-3 py-4 text-sm text-neutral-500">No notes yet.</p>;
  }

  const { startIndex, endIndex, paddingTop, paddingBottom } = computeVirtualWindow(
    rows.length,
    ROW_HEIGHT,
    scrollTop,
    viewportHeight,
    OVERSCAN,
  );

  const visibleRows = rows.slice(startIndex, endIndex);

  return (
    <div
      ref={containerRef}
      onScroll={handleScroll}
      className="overflow-y-auto"
      style={{ height: '100%' }}
    >
      {/* Top spacer */}
      {paddingTop > 0 && <div style={{ height: paddingTop }} aria-hidden="true" />}

      <ul className="space-y-0.5">
        {visibleRows.map((row: FlatRow<TreeNode>) => (
          <Row
            key={row.item.path}
            row={row}
            activePath={activePath}
            closedFolders={closedFolders}
            onSelect={onSelect}
            onToggle={toggleFolder}
          />
        ))}
      </ul>

      {/* Bottom spacer */}
      {paddingBottom > 0 && <div style={{ height: paddingBottom }} aria-hidden="true" />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface RowProps {
  row: FlatRow<TreeNode>;
  activePath: NotePath | null;
  closedFolders: ReadonlySet<string>;
  onSelect(path: NotePath): void;
  onToggle(path: string): void;
}

function Row({ row, activePath, closedFolders, onSelect, onToggle }: RowProps) {
  const { item: node, depth } = row;
  const pad = { paddingLeft: `${depth * 12 + 8}px` };

  if (node.children) {
    const open = !closedFolders.has(node.path);
    return (
      <li style={{ height: ROW_HEIGHT }}>
        <button
          type="button"
          onClick={() => onToggle(node.path)}
          style={pad}
          className="flex h-full w-full items-center gap-1 rounded px-2 py-1 text-left text-sm text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200"
        >
          <span className="inline-block w-3 text-xs text-neutral-600">{open ? '▾' : '▸'}</span>
          <span className="truncate">{node.name}</span>
        </button>
      </li>
    );
  }

  const active = node.path === activePath;
  return (
    <li style={{ height: ROW_HEIGHT }}>
      <button
        type="button"
        onClick={() => onSelect(node.path)}
        style={pad}
        className={[
          'block h-full w-full truncate rounded px-2 py-1 text-left text-sm transition-colors',
          active
            ? 'bg-neutral-800/80 text-neutral-100'
            : 'text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100',
        ].join(' ')}
        title={node.path}
      >
        {node.note?.parsed.title ?? node.name}
      </button>
    </li>
  );
}
