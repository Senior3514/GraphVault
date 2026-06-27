'use client';

/**
 * Window control buttons rendered in a pane's header.
 *
 * Provides collapse, expand, and maximize/restore buttons - Obsidian-style.
 * Icons are SVG inline to avoid any icon library dependency.
 */

import type { MaximizedPane } from '../../lib/layout/types';

interface PaneControlsProps {
  paneId: MaximizedPane;
  currentMaximized: MaximizedPane;
  onMaximize(): void;
  onRestore(): void;
  /** When provided, renders a collapse/expand button. */
  isCollapsible?: boolean;
  isCollapsed?: boolean;
  onToggleCollapse?(): void;
  className?: string;
}

export function PaneControls({
  paneId,
  currentMaximized,
  onMaximize,
  onRestore,
  isCollapsible,
  isCollapsed,
  onToggleCollapse,
  className = '',
}: PaneControlsProps) {
  const isMax = currentMaximized === paneId;
  const otherIsMax = currentMaximized !== null && currentMaximized !== paneId;

  return (
    <div className={['flex items-center gap-0.5', className].join(' ')}>
      {isCollapsible && onToggleCollapse && (
        <ControlButton
          onClick={onToggleCollapse}
          title={isCollapsed ? 'Expand pane' : 'Collapse pane'}
          aria-label={isCollapsed ? 'Expand pane' : 'Collapse pane'}
          aria-pressed={isCollapsed}
        >
          {isCollapsed ? <ExpandIcon /> : <CollapseIcon />}
        </ControlButton>
      )}
      {!otherIsMax && (
        <ControlButton
          onClick={isMax ? onRestore : onMaximize}
          title={isMax ? 'Restore pane' : 'Maximize pane'}
          aria-label={isMax ? 'Restore pane' : 'Maximize pane'}
          aria-pressed={isMax}
        >
          {isMax ? <RestoreIcon /> : <MaximizeIcon />}
        </ControlButton>
      )}
    </div>
  );
}

function ControlButton({
  onClick,
  title,
  children,
  'aria-label': ariaLabel,
  'aria-pressed': ariaPressed,
}: {
  onClick(): void;
  title: string;
  children: React.ReactNode;
  'aria-label'?: string;
  'aria-pressed'?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={ariaPressed}
      className="flex h-6 w-6 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-neutral-700 hover:text-neutral-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-sky-500"
    >
      {children}
    </button>
  );
}

function CollapseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
      <path d="M1 4h10v1H1V4zm0 3h10v1H1V7z" />
    </svg>
  );
}

function ExpandIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
      <path d="M6 2l4 4H2l4-4zm0 8L2 6h8l-4 4z" />
    </svg>
  );
}

function MaximizeIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
      <path d="M1 1h4v1H2v3H1V1zm6 0h4v4h-1V2H7V1zM1 7h1v3h3v1H1V7zm9 3H7v1h4V7h-1v3z" />
    </svg>
  );
}

function RestoreIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
      <path d="M3 3v6h6V3H3zm1 1h4v4H4V4z" />
    </svg>
  );
}
