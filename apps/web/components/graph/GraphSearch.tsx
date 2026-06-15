'use client';

/**
 * In-graph search bar. Floats over the canvas in the top-right corner.
 *
 * Behaviour:
 * - Press `/` anywhere on the page (when not typing in another input) to focus.
 * - Live match count updates with each keystroke.
 * - Escape or clearing the input cancels the search.
 * - When the query is non-empty, the canvas dims non-matching nodes and zooms
 *   the view to the first match batch (handled by the page).
 */

import { useEffect, useRef } from 'react';
import { matchSummary } from '../../lib/graph/search';

export interface GraphSearchProps {
  query: string;
  matchCount: number | null;
  onQueryChange: (q: string) => void;
}

export function GraphSearch({ query, matchCount, onQueryChange }: GraphSearchProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  // Bind `/` globally to focus the search input, but only when the user is not
  // already typing inside a form element.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key !== '/') return;
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      onQueryChange('');
      inputRef.current?.blur();
    }
  };

  const active = query.length > 0;

  return (
    <div className="pointer-events-auto flex items-center gap-2 rounded-md border border-neutral-700 bg-neutral-950/90 px-2 py-1.5 shadow-lg backdrop-blur">
      <svg
        className="h-3.5 w-3.5 shrink-0 text-neutral-500"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        aria-hidden
      >
        <circle cx="6.5" cy="6.5" r="4.5" />
        <path strokeLinecap="round" d="M10.5 10.5l3 3" />
      </svg>
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Search nodes… (/)"
        aria-label="Search graph nodes"
        className="w-44 bg-transparent text-xs text-neutral-200 placeholder-neutral-600 outline-none"
        spellCheck={false}
      />
      {active && (
        <>
          <span
            className={[
              'shrink-0 text-xs tabular-nums',
              matchCount === 0 ? 'text-rose-400' : 'text-neutral-400',
            ].join(' ')}
            aria-live="polite"
            aria-atomic
          >
            {matchCount !== null ? matchSummary(matchCount) : ''}
          </span>
          <button
            type="button"
            onClick={() => onQueryChange('')}
            aria-label="Clear search"
            className="ml-0.5 shrink-0 rounded p-0.5 text-neutral-500 transition-colors hover:text-neutral-200"
          >
            <svg
              viewBox="0 0 12 12"
              className="h-3 w-3"
              fill="none"
              stroke="currentColor"
              strokeWidth={1.8}
              aria-hidden
            >
              <path strokeLinecap="round" d="M2 2l8 8M10 2l-8 8" />
            </svg>
          </button>
        </>
      )}
    </div>
  );
}
