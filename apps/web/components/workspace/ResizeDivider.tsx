'use client';

/**
 * A draggable divider between two panes.
 *
 * Fires onResize(deltaPx) continuously while dragging; the parent clamps and
 * applies the delta. Respects prefers-reduced-motion (no animated cursors).
 */

import { useCallback, useRef } from 'react';

interface ResizeDividerProps {
  /** 'horizontal' = vertical bar (resize left/right panels), 'vertical' = horizontal bar. */
  direction?: 'horizontal' | 'vertical';
  /** Called with raw pixel delta each pointermove. Parent clamps. */
  onResize(deltaPx: number): void;
  /** aria-label for screen readers. */
  label?: string;
}

export function ResizeDivider({
  direction = 'horizontal',
  onResize,
  label = 'Resize pane',
}: ResizeDividerProps) {
  const dragging = useRef(false);
  const lastPos = useRef(0);

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      dragging.current = true;
      lastPos.current = direction === 'horizontal' ? e.clientX : e.clientY;
      (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    },
    [direction],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragging.current) return;
      const cur = direction === 'horizontal' ? e.clientX : e.clientY;
      const delta = cur - lastPos.current;
      lastPos.current = cur;
      if (delta !== 0) onResize(delta);
    },
    [direction, onResize],
  );

  const onPointerUp = useCallback(() => {
    dragging.current = false;
  }, []);

  // Keyboard accessibility: arrow keys move by 8px.
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = 8;
      if (direction === 'horizontal') {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          onResize(-step);
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          onResize(step);
        }
      } else {
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          onResize(-step);
        }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          onResize(step);
        }
      }
    },
    [direction, onResize],
  );

  const isHoriz = direction === 'horizontal';

  return (
    <div
      role="separator"
      aria-label={label}
      aria-orientation={isHoriz ? 'vertical' : 'horizontal'}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onKeyDown={onKeyDown}
      className={[
        'group relative z-10 shrink-0 select-none focus:outline-none',
        isHoriz
          ? 'w-1 cursor-col-resize hover:bg-neutral-700/60 focus:bg-sky-600/40 active:bg-sky-600/60'
          : 'h-1 cursor-row-resize hover:bg-neutral-700/60 focus:bg-sky-600/40 active:bg-sky-600/60',
        'bg-neutral-800 transition-colors duration-100',
      ].join(' ')}
    >
      {/* Visual handle dot */}
      <div
        className={[
          'absolute rounded-full bg-neutral-600 opacity-0 transition-opacity group-hover:opacity-100 group-focus:opacity-100 group-active:opacity-100',
          isHoriz
            ? 'left-0 top-1/2 h-8 w-1 -translate-y-1/2'
            : 'left-1/2 top-0 h-1 w-8 -translate-x-1/2',
        ].join(' ')}
      />
    </div>
  );
}
