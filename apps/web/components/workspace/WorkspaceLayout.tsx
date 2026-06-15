'use client';

/**
 * WorkspaceLayout — the outermost shell for the vault workspace.
 *
 * Handles:
 * - Three-column layout (note list | editor | details) with resizable dividers.
 * - Per-pane maximize / restore controls.
 * - Persisted pane widths (via useLayout).
 * - Passing layout actions down to child panes via context.
 *
 * Children use <WorkspaceLayoutContext> to access layout actions.
 */

import { createContext, useCallback, useContext, type ReactNode } from 'react';

import type { LayoutActions } from '../../lib/layout/useLayout';
import type { MaximizedPane } from '../../lib/layout/types';
import { PaneControls } from './PaneControls';
import { ResizeDivider } from './ResizeDivider';

// ---- Context ----------------------------------------------------------------

export const WorkspaceContext = createContext<LayoutActions | null>(null);

export function useWorkspace(): LayoutActions {
  const ctx = useContext(WorkspaceContext);
  if (!ctx) throw new Error('useWorkspace must be used inside WorkspaceLayout');
  return ctx;
}

// ---- WorkspaceLayout --------------------------------------------------------

interface WorkspaceLayoutProps {
  actions: LayoutActions;
  noteListSlot: ReactNode;
  editorSlot: ReactNode;
  detailsSlot: ReactNode;
}

export function WorkspaceLayout({
  actions,
  noteListSlot,
  editorSlot,
  detailsSlot,
}: WorkspaceLayoutProps) {
  const { layout, maximizePane, restorePane, setNoteListWidth, setDetailsWidth, togglePanel } =
    actions;

  const { widths, panels, maximized } = layout;

  // Which panes are visible in the current maximized state?
  const showNoteList = panels.noteList && (maximized === null || maximized === 'noteList');
  const showEditor = maximized === null || maximized === 'editor';
  const showDetails = panels.details && (maximized === null || maximized === 'details');

  const handleNoteListResize = useCallback(
    (delta: number) => setNoteListWidth(widths.noteList + delta),
    [widths.noteList, setNoteListWidth],
  );

  const handleDetailsResize = useCallback(
    (delta: number) => setDetailsWidth(widths.details - delta),
    [widths.details, setDetailsWidth],
  );

  return (
    <WorkspaceContext.Provider value={actions}>
      <div className="flex h-full min-h-0 flex-1 overflow-hidden">
        {/* ===== Note List Panel ===== */}
        {showNoteList && (
          <>
            <div
              className="flex shrink-0 flex-col overflow-hidden border-r border-neutral-800 bg-neutral-950 transition-[width] duration-[50ms]"
              style={{
                width: maximized === 'noteList' ? '100%' : widths.noteList,
                minWidth: maximized === 'noteList' ? undefined : 0,
              }}
            >
              <PaneHeader
                title="Notes"
                paneId="noteList"
                maximized={maximized}
                onMaximize={() => maximizePane('noteList')}
                onRestore={restorePane}
                isCollapsible
                isCollapsed={!panels.noteList}
                onToggleCollapse={() => togglePanel('noteList')}
              />
              <div className="min-h-0 flex-1 overflow-auto">{noteListSlot}</div>
            </div>
            {maximized === null && showEditor && (
              <ResizeDivider onResize={handleNoteListResize} label="Resize note list / editor" />
            )}
          </>
        )}

        {/* Collapsed noteList button */}
        {!panels.noteList && maximized === null && (
          <CollapsedTab label="Notes" onClick={() => togglePanel('noteList')} side="left" />
        )}

        {/* ===== Editor Panel ===== */}
        {showEditor && (
          <div className="flex min-w-0 flex-1 flex-col overflow-hidden">{editorSlot}</div>
        )}

        {/* ===== Details Panel ===== */}
        {showDetails && maximized === null && showEditor && (
          <ResizeDivider onResize={handleDetailsResize} label="Resize editor / details" />
        )}

        {showDetails && (
          <div
            className="flex shrink-0 flex-col overflow-hidden border-l border-neutral-800 bg-neutral-950 transition-[width] duration-[50ms]"
            style={{
              width: maximized === 'details' ? '100%' : widths.details,
              minWidth: maximized === 'details' ? undefined : 0,
            }}
          >
            <PaneHeader
              title="Details"
              paneId="details"
              maximized={maximized}
              onMaximize={() => maximizePane('details')}
              onRestore={restorePane}
              isCollapsible
              isCollapsed={!panels.details}
              onToggleCollapse={() => togglePanel('details')}
            />
            <div className="min-h-0 flex-1 overflow-auto">{detailsSlot}</div>
          </div>
        )}

        {/* Collapsed details button */}
        {!panels.details && maximized === null && (
          <CollapsedTab label="Details" onClick={() => togglePanel('details')} side="right" />
        )}
      </div>
    </WorkspaceContext.Provider>
  );
}

// ---- PaneHeader -------------------------------------------------------------

interface PaneHeaderProps {
  title: string;
  paneId: MaximizedPane;
  maximized: MaximizedPane;
  onMaximize(): void;
  onRestore(): void;
  isCollapsible?: boolean;
  isCollapsed?: boolean;
  onToggleCollapse?(): void;
  /** Additional content to render in the header (e.g. "New" button). */
  children?: ReactNode;
}

export function PaneHeader({
  title,
  paneId,
  maximized,
  onMaximize,
  onRestore,
  isCollapsible,
  isCollapsed,
  onToggleCollapse,
  children,
}: PaneHeaderProps) {
  return (
    <header className="flex shrink-0 items-center justify-between border-b border-neutral-800 px-3 py-1.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </span>
      <div className="flex items-center gap-1">
        {children}
        <PaneControls
          paneId={paneId}
          currentMaximized={maximized}
          onMaximize={onMaximize}
          onRestore={onRestore}
          isCollapsible={isCollapsible}
          isCollapsed={isCollapsed}
          onToggleCollapse={onToggleCollapse}
        />
      </div>
    </header>
  );
}

// ---- CollapsedTab -----------------------------------------------------------

function CollapsedTab({
  label,
  onClick,
  side,
}: {
  label: string;
  onClick(): void;
  side: 'left' | 'right';
}) {
  return (
    <div
      className={[
        'flex shrink-0 items-center border-neutral-800 bg-neutral-950',
        side === 'left' ? 'border-r' : 'border-l',
      ].join(' ')}
    >
      <button
        type="button"
        onClick={onClick}
        title={`Show ${label}`}
        aria-label={`Show ${label} panel`}
        className="flex h-full w-6 items-center justify-center text-neutral-600 hover:bg-neutral-800 hover:text-neutral-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-sky-500"
      >
        <span
          className="text-[10px] font-semibold uppercase tracking-widest"
          style={{ writingMode: 'vertical-rl', textOrientation: 'mixed' }}
        >
          {label}
        </span>
      </button>
    </div>
  );
}
