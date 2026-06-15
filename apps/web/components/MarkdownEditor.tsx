'use client';

/**
 * A plain `<textarea>` Markdown editor with `[[wikilink]]` autocomplete.
 *
 * When the caret sits inside an unclosed `[[`, a popup lists matching note
 * titles; arrow keys + Enter/Tab insert the selection and close the brackets.
 * Editing is uncontrolled-by-keystroke but value-synced via props; changes are
 * pushed up through `onChange` for the parent to autosave.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';

import type { IndexedNote } from '../lib/vault/types';

interface MarkdownEditorProps {
  value: string;
  notes: IndexedNote[];
  onChange(value: string): void;
}

interface ActiveLink {
  /** Index just after the opening `[[`. */
  start: number;
  /** The partial query typed so far. */
  query: string;
}

/** Find an open `[[` immediately before the caret on the same segment. */
function findActiveWikiLink(text: string, caret: number): ActiveLink | null {
  const open = text.lastIndexOf('[[', caret);
  if (open === -1) return null;
  const between = text.slice(open + 2, caret);
  // Bail if the link was already closed, contains a newline, or an alias pipe.
  if (between.includes(']]') || between.includes('\n')) return null;
  return { start: open + 2, query: between };
}

export function MarkdownEditor({ value, notes, onChange }: MarkdownEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [active, setActive] = useState<ActiveLink | null>(null);
  const [highlight, setHighlight] = useState(0);

  const suggestions = useMemo(() => {
    if (!active) return [];
    const q = active.query.trim().toLowerCase();
    const titles = notes.map((n) => n.parsed.title);
    const filtered = q === '' ? titles : titles.filter((t) => t.toLowerCase().includes(q));
    return filtered.slice(0, 8);
  }, [active, notes]);

  useEffect(() => {
    setHighlight(0);
  }, [active?.query]);

  // Keep caret detection in sync after the value changes externally.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || document.activeElement !== el) return;
    setActive(findActiveWikiLink(el.value, el.selectionStart));
  }, [value]);

  const refreshActive = () => {
    const el = ref.current;
    if (!el) return;
    setActive(findActiveWikiLink(el.value, el.selectionStart));
  };

  const applySuggestion = (title: string) => {
    const el = ref.current;
    if (!el || !active) return;
    const before = el.value.slice(0, active.start);
    const after = el.value.slice(active.start + active.query.length);
    const insertion = `${title}]]`;
    const next = `${before}${insertion}${after}`;
    onChange(next);
    setActive(null);
    // Place caret after the inserted `]]`.
    const caret = active.start + insertion.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (active && suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => (h + 1) % suggestions.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => (h - 1 + suggestions.length) % suggestions.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        applySuggestion(suggestions[highlight]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setActive(null);
        return;
      }
    }
  };

  return (
    <div className="relative h-full">
      <textarea
        ref={ref}
        value={value}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onKeyUp={refreshActive}
        onClick={refreshActive}
        onBlur={() => setActive(null)}
        className="h-full w-full resize-none bg-transparent px-6 py-5 font-mono text-sm leading-relaxed text-neutral-200 outline-none placeholder:text-neutral-600"
        placeholder="Start writing… use [[ to link notes."
      />
      {active && suggestions.length > 0 && (
        <ul className="absolute left-6 top-16 z-10 w-72 overflow-hidden rounded-md border border-neutral-700 bg-neutral-900 shadow-xl">
          <li className="border-b border-neutral-800 px-3 py-1 text-xs text-neutral-500">
            Link to note
          </li>
          {suggestions.map((title, i) => (
            <li key={title}>
              <button
                type="button"
                // onMouseDown beats the textarea's onBlur so the insert lands.
                onMouseDown={(e) => {
                  e.preventDefault();
                  applySuggestion(title);
                }}
                className={[
                  'block w-full truncate px-3 py-1.5 text-left text-sm',
                  i === highlight
                    ? 'bg-neutral-700 text-neutral-100'
                    : 'text-neutral-300 hover:bg-neutral-800',
                ].join(' ')}
              >
                {title}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
