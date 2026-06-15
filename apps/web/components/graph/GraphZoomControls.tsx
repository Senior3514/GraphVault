'use client';

/**
 * Floating zoom controls overlaid on the graph canvas.
 *
 * Three buttons: zoom-in (+), zoom-out (−), and fit (fit the whole graph in
 * the viewport). These are driven imperatively through the `ForceGraphHandle`
 * ref so the controls don't need to know about the canvas internals.
 *
 * The buttons are pointer-events-enabled but surrounded by a pointer-events-none
 * wrapper so the rest of the overlay area keeps passing through to the canvas.
 */

export interface GraphZoomControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  /** Whether any nodes are pinned — shows "Unpin all" if true. */
  hasPinnedNodes: boolean;
  onUnpinAll: () => void;
}

export function GraphZoomControls({
  onZoomIn,
  onZoomOut,
  onFit,
  hasPinnedNodes,
  onUnpinAll,
}: GraphZoomControlsProps) {
  return (
    <div className="pointer-events-auto flex flex-col gap-1">
      <ZoomBtn onClick={onZoomIn} title="Zoom in">
        <span className="text-base font-medium leading-none">+</span>
      </ZoomBtn>
      <ZoomBtn onClick={onZoomOut} title="Zoom out">
        <span className="text-base font-medium leading-none">−</span>
      </ZoomBtn>
      <ZoomBtn onClick={onFit} title="Fit graph">
        <FitIcon />
      </ZoomBtn>
      {hasPinnedNodes && (
        <button
          type="button"
          onClick={onUnpinAll}
          title="Unpin all nodes"
          className="mt-1 rounded-md border border-amber-700/60 bg-amber-900/40 px-2 py-1 text-[10px] font-medium text-amber-300 transition-colors hover:bg-amber-800/50 hover:text-amber-100"
        >
          Unpin all
        </button>
      )}
    </div>
  );
}

function ZoomBtn({
  onClick,
  title,
  children,
}: {
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex h-8 w-8 items-center justify-center rounded-md border border-neutral-700 bg-neutral-900/90 text-neutral-300 shadow transition-colors hover:bg-neutral-800 hover:text-neutral-100 active:bg-neutral-700"
    >
      {children}
    </button>
  );
}

function FitIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-3.5 w-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      aria-hidden
    >
      <path
        strokeLinecap="round"
        d="M2 2h4M2 2v4M14 2h-4M14 2v4M2 14h4M2 14v-4M14 14h-4M14 14v-4"
      />
    </svg>
  );
}
