'use client';

/** Full-text/title search input with a results dropdown. */

import { useEffect, useRef, useState } from 'react';

import type { SearchResult } from '../lib/vault/search';
import type { NotePath } from '../lib/vault/types';

interface SearchBoxProps {
  search(query: string): SearchResult[];
  onOpen(path: NotePath): void;
}

export function SearchBox({ search, onOpen }: SearchBoxProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setResults(query.trim() ? search(query) : []);
  }, [query, search]);

  // Close on outside click.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const choose = (path: NotePath) => {
    onOpen(path);
    setOpen(false);
    setQuery('');
  };

  return (
    <div ref={wrapRef} className="relative w-72">
      <input
        type="search"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search notes…"
        className="w-full rounded-md border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-200 outline-none placeholder:text-neutral-600 focus:border-neutral-600"
      />
      {open && query.trim() !== '' && (
        <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-md border border-neutral-700 bg-neutral-900 shadow-xl">
          {results.length === 0 ? (
            <li className="px-3 py-2 text-sm text-neutral-500">No matches</li>
          ) : (
            results.map((r) => (
              <li key={r.path}>
                <button
                  type="button"
                  onClick={() => choose(r.path)}
                  className="block w-full truncate px-3 py-1.5 text-left text-sm text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100"
                  title={r.path}
                >
                  {r.title}
                  <span className="ml-2 text-xs text-neutral-600">{r.path}</span>
                </button>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  );
}
