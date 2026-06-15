/**
 * Tiny, dependency-free virtual-list helpers for the note tree sidebar.
 *
 * The algorithm: given a fixed item height, a container scroll offset, and a
 * container viewport height, return the slice of indices that should be
 * rendered plus top/bottom padding heights that keep the scrollbar accurate.
 *
 * This is the minimum "windowed rendering" needed to keep the note sidebar
 * smooth with thousands of items — no layout observers, ResizeObservers, or
 * dynamic heights required (all rows are a single fixed height).
 *
 * UI-independent: no React imports, fully pure, testable in Node.
 */

export interface VirtualWindow {
  /** Index of the first item to render. */
  startIndex: number;
  /** Index one past the last item to render (exclusive). */
  endIndex: number;
  /** Pixels of empty space ABOVE the rendered slice (pad the first rendered row up). */
  paddingTop: number;
  /** Pixels of empty space BELOW the rendered slice. */
  paddingBottom: number;
}

/**
 * Compute the virtual window for a flat list.
 *
 * @param totalItems    Total number of items in the list.
 * @param itemHeight    Fixed height (px) of each item.
 * @param scrollTop     Current scroll offset (px) of the container.
 * @param viewportHeight Visible height (px) of the scroll container.
 * @param overscan      Extra items to render above/below the visible region
 *                      (default 5) to prevent flicker during fast scrolling.
 */
export function computeVirtualWindow(
  totalItems: number,
  itemHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = 5,
): VirtualWindow {
  if (totalItems === 0 || itemHeight <= 0 || viewportHeight <= 0) {
    return { startIndex: 0, endIndex: 0, paddingTop: 0, paddingBottom: 0 };
  }

  const firstVisible = Math.floor(scrollTop / itemHeight);
  const lastVisible = Math.ceil((scrollTop + viewportHeight) / itemHeight);

  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(totalItems, lastVisible + overscan);

  const paddingTop = startIndex * itemHeight;
  const paddingBottom = (totalItems - endIndex) * itemHeight;

  return { startIndex, endIndex, paddingTop, paddingBottom };
}

/** One flattened row entry produced by {@link flattenTree}. */
export interface FlatRow<T> {
  item: T;
  depth: number;
}

/**
 * Recursively flatten a tree into a list of `{item, depth}` rows, respecting
 * open/closed folder state. Only items with an open ancestor are included.
 *
 * `getChildren` returns the children of a node (or an empty array for leaf
 * nodes). `isOpen` determines whether a folder is currently expanded.
 */
export function flattenTree<T>(
  roots: T[],
  getChildren: (node: T) => T[],
  isOpen: (node: T) => boolean,
  depth = 0,
): FlatRow<T>[] {
  const rows: FlatRow<T>[] = [];
  for (const item of roots) {
    rows.push({ item, depth });
    const children = getChildren(item);
    if (children.length > 0 && isOpen(item)) {
      rows.push(...flattenTree(children, getChildren, isOpen, depth + 1));
    }
  }
  return rows;
}
