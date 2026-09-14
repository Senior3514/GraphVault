'use client';

/**
 * Tab bar for the editor column.
 *
 * Features:
 * - Multiple tabs, drag-to-reorder.
 * - Dirty indicator (dot) on unsaved tabs.
 * - Close button per tab.
 * - "+" button to open a new blank tab.
 * - Split-mode toggle buttons (hidden on narrow/mobile screens where split is
 *   auto-disabled to save space).
 *
 * The tab list scrolls horizontally without overflow - it never causes the
 * container to grow wider than its parent. The split-mode toggles are
 * hidden below `md` (the WorkspaceLayout mobile view shows a single pane
 * anyway, so split is redundant there).
 *
 * Drag reorder uses HTML5 drag-and-drop (no extra deps).
 */

import { useRef, useState } from 'react';

import type { EditorTab, SplitMode } from '../../lib/layout/types';

interface TabBarProps {
  tabs: EditorTab[];
  activeTabId: string | null;
  splitMode: SplitMode;
  secondaryTabId: string | null;
  onActivate(tabId: string): void;
  onClose(tabId: string): void;
  onNew(): void;
  onReorder(from: number, to: number): void;
  onSplitMode(mode: SplitMode): void;
  onSetSecondary(tabId: string | null): void;
}

export function TabBar({
  tabs,
  activeTabId,
  splitMode,
  secondaryTabId,
  onActivate,
  onClose,
  onNew,
  onReorder,
  onSplitMode,
  onSetSecondary,
}: TabBarProps) {
  const dragFrom = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const handleDragStart = (idx: number) => {
    dragFrom.current = idx;
  };

  const handleDragOver = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    setDragOverIdx(idx);
  };

  const handleDrop = (e: React.DragEvent, idx: number) => {
    e.preventDefault();
    if (dragFrom.current !== null && dragFrom.current !== idx) {
      onReorder(dragFrom.current, idx);
    }
    dragFrom.current = null;
    setDragOverIdx(null);
  };

  const handleDragEnd = () => {
    dragFrom.current = null;
    setDragOverIdx(null);
  };

  return (
    // Use `min-w-0` to prevent the flex child from escaping its parent width.
    <div className="flex min-w-0 items-stretch border-b border-neutral-800 bg-neutral-950">
      {/* Tab list - scrolls horizontally; never forces parent wider */}
      <div className="scrollbar-none flex min-w-0 flex-1 items-stretch overflow-x-auto">
        {tabs.map((tab, idx) => {
          const isActive = tab.id === activeTabId;
          const isSecondary = tab.id === secondaryTabId;
          const isDragOver = dragOverIdx === idx;

          return (
            <div
              key={tab.id}
              draggable
              onDragStart={() => handleDragStart(idx)}
              onDragOver={(e) => handleDragOver(e, idx)}
              onDrop={(e) => handleDrop(e, idx)}
              onDragEnd={handleDragEnd}
              className={[
                'group relative flex shrink-0 cursor-pointer select-none items-center border-r border-neutral-800',
                isDragOver ? 'bg-neutral-800/60' : '',
                isActive
                  ? 'bg-neutral-900 text-neutral-100'
                  : 'bg-neutral-950 text-neutral-400 hover:bg-neutral-900/60 hover:text-neutral-200',
                // Top accent for active tab
                isActive ? 'shadow-[inset_0_2px_0_0_rgb(14_165_233)]' : '',
              ].join(' ')}
              // Cap width so long titles don't push the bar. On very small
              // screens keep it tighter (120px) so ≥2 tabs fit at once.
              style={{ maxWidth: 'min(180px, 40vw)' }}
            >
              <button
                type="button"
                onClick={() => onActivate(tab.id)}
                className="flex min-w-0 items-center gap-1.5 py-2 pl-3 pr-1 text-xs focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-500"
                title={tab.notePath ?? 'Untitled'}
                aria-label={`${tab.title || 'Untitled'}${tab.dirty ? ', unsaved changes' : ''}`}
              >
                {/* Dirty dot */}
                {tab.dirty && (
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-400"
                    aria-label="Unsaved changes"
                  />
                )}
                <span className="truncate">{tab.title || 'Untitled'}</span>
                {/* Secondary badge (split mode) */}
                {isSecondary && splitMode === 'two-notes' && (
                  <span className="shrink-0 rounded bg-neutral-700 px-1 text-[10px] text-neutral-400">
                    2
                  </span>
                )}
              </button>
              {/* Close button */}
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
                title="Close tab"
                aria-label={`Close ${tab.title}`}
                className="mr-1 flex h-4 w-4 shrink-0 items-center justify-center rounded text-neutral-600 opacity-0 transition-opacity hover:bg-neutral-700 hover:text-neutral-300 group-hover:opacity-100 focus:opacity-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-500"
              >
                <CloseIcon />
              </button>
            </div>
          );
        })}

        {/* New tab button */}
        <button
          type="button"
          onClick={onNew}
          title="Open new tab"
          aria-label="Open new tab"
          className="flex h-full shrink-0 items-center px-2 text-neutral-600 hover:bg-neutral-800/60 hover:text-neutral-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-500"
        >
          <PlusIcon />
        </button>
      </div>

      {/* Split mode controls - hidden on mobile (single-pane mode anyway) */}
      <div className="hidden shrink-0 items-center gap-0.5 border-l border-neutral-800 px-1 md:flex">
        <SplitButton
          active={splitMode === 'none'}
          onClick={() => onSplitMode('none')}
          title="Single editor"
          aria-label="Single editor"
        >
          <SinglePaneIcon />
        </SplitButton>
        <SplitButton
          active={splitMode === 'editor-preview'}
          onClick={() => onSplitMode('editor-preview')}
          title="Editor + Preview"
          aria-label="Editor and preview split"
        >
          <SplitPreviewIcon />
        </SplitButton>
        <SplitButton
          active={splitMode === 'two-notes'}
          onClick={() => {
            onSplitMode('two-notes');
            // If no secondary is set, pick the one before the active.
            if (!secondaryTabId && tabs.length > 1) {
              const activeIdx = tabs.findIndex((t) => t.id === activeTabId);
              const secondIdx = activeIdx > 0 ? activeIdx - 1 : activeIdx + 1;
              if (tabs[secondIdx]) onSetSecondary(tabs[secondIdx].id);
            }
          }}
          title="Two notes side by side"
          aria-label="Two notes side by side"
        >
          <SplitTwoIcon />
        </SplitButton>
      </div>
    </div>
  );
}

function SplitButton({
  active,
  onClick,
  title,
  'aria-label': ariaLabel,
  children,
}: {
  active: boolean;
  onClick(): void;
  title: string;
  'aria-label': string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      aria-pressed={active}
      className={[
        'flex h-6 w-6 items-center justify-center rounded text-xs focus:outline-none focus-visible:ring-1 focus-visible:ring-accent-500',
        active
          ? 'bg-neutral-700 text-neutral-100'
          : 'text-neutral-500 hover:bg-neutral-800 hover:text-neutral-300',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function CloseIcon() {
  return (
    <svg width="8" height="8" viewBox="0 0 8 8" fill="currentColor" aria-hidden>
      <path d="M1.293 1.293a1 1 0 011.414 0L4 2.586l1.293-1.293a1 1 0 111.414 1.414L5.414 4l1.293 1.293a1 1 0 01-1.414 1.414L4 5.414 2.707 6.707a1 1 0 01-1.414-1.414L2.586 4 1.293 2.707a1 1 0 010-1.414z" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden>
      <path d="M5.5 0h1v5.5H12v1H6.5V12h-1V6.5H0v-1h5.5V0z" />
    </svg>
  );
}

function SinglePaneIcon() {
  return (
    <svg width="12" height="10" viewBox="0 0 12 10" fill="currentColor" aria-hidden>
      <rect x="0" y="0" width="12" height="10" rx="1" />
    </svg>
  );
}

function SplitPreviewIcon() {
  return (
    <svg width="12" height="10" viewBox="0 0 12 10" fill="currentColor" aria-hidden>
      <rect x="0" y="0" width="5" height="10" rx="1" />
      <rect x="7" y="0" width="5" height="10" rx="1" opacity="0.5" />
    </svg>
  );
}

function SplitTwoIcon() {
  return (
    <svg width="12" height="10" viewBox="0 0 12 10" fill="currentColor" aria-hidden>
      <rect x="0" y="0" width="5" height="10" rx="1" />
      <rect x="7" y="0" width="5" height="10" rx="1" />
    </svg>
  );
}
