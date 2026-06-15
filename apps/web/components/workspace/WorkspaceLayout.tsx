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
 * Mobile (< md / 768 px):
 * - Collapses to a single visible pane at a time.
 * - A bottom segmented control switches between Notes / Editor / Details.
 * - Drag-resize dividers are hidden; only the active pane content is rendered.
 * - Safe-area insets are applied to the bottom bar for notched devices.
 *
 * Children use <WorkspaceLayoutContext> to access layout actions.
 */

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';

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

// ---- Mobile pane tabs -------------------------------------------------------

type MobilePane = 'notes' | 'editor' | 'details';

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

  // Mobile: which pane is currently visible
  const [mobilePane, setMobilePane] = useState<MobilePane>('editor');

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
      {/* ================================================================ */}
      {/* DESKTOP layout (md and up) — three resizable columns              */}
      {/* ================================================================ */}
      <div className="hidden md:flex md:h-full md:min-h-0 md:flex-1 md:overflow-hidden">
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

      {/* ================================================================ */}
      {/* MOBILE layout (< md) — single visible pane + bottom switcher      */}
      {/* ================================================================ */}
      <div className="flex h-full min-h-0 flex-col md:hidden">
        {/* Active pane fills all available height above the bottom bar */}
        <div className="min-h-0 flex-1 overflow-hidden">
          {mobilePane === 'notes' && (
            <div className="flex h-full flex-col overflow-hidden bg-neutral-950">
              {noteListSlot}
            </div>
          )}
          {mobilePane === 'editor' && (
            <div className="flex h-full min-w-0 flex-col overflow-hidden">{editorSlot}</div>
          )}
          {mobilePane === 'details' && (
            <div className="flex h-full flex-col overflow-hidden bg-neutral-950">{detailsSlot}</div>
          )}
        </div>

        {/* Bottom segmented control — switch between Notes / Editor / Details */}
        <nav
          aria-label="Pane switcher"
          className="flex shrink-0 border-t border-neutral-800 bg-neutral-950"
          style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
        >
          {(
            [
              { id: 'notes', label: 'Notes', icon: <NotesIcon /> },
              { id: 'editor', label: 'Editor', icon: <EditorIcon /> },
              { id: 'details', label: 'Details', icon: <DetailsIcon /> },
            ] as { id: MobilePane; label: string; icon: ReactNode }[]
          ).map(({ id, label, icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => setMobilePane(id)}
              aria-label={label}
              aria-current={mobilePane === id ? 'true' : undefined}
              className={[
                'flex flex-1 flex-col items-center justify-center gap-0.5 py-2 text-[10px] font-medium transition-colors',
                mobilePane === id ? 'text-sky-400' : 'text-neutral-500 hover:text-neutral-300',
              ].join(' ')}
            >
              {icon}
              {label}
            </button>
          ))}
        </nav>
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

// ---- Mobile bottom bar icons ------------------------------------------------

function NotesIcon() {
  return (
    <svg viewBox="0 0 20 20" fill="currentColor" className="h-5 w-5" aria-hidden="true">
      <path
        fillRule="evenodd"
        d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function EditorIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13.586 3.586a2 2 0 112.828 2.828l-8 8a2 2 0 01-.828.514l-3 1a1 1 0 01-1.243-1.243l1-3a2 2 0 01.514-.828l8-8z"
      />
    </svg>
  );
}

function DetailsIcon() {
  return (
    <svg
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      className="h-5 w-5"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M13 16H7m6-4H7m2-4H7M5 4h10a2 2 0 012 2v10a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2z"
      />
    </svg>
  );
}
