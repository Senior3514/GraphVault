'use client';

/**
 * A plain `<textarea>` Markdown editor with `[[wikilink]]` and `#tag`
 * autocomplete.
 *
 * When the caret sits inside an unclosed `[[`, a popup lists matching note
 * titles; when it sits just after a `#` token, it lists matching vault tags.
 * Arrow keys + Enter/Tab/click insert the selection (closing the `]]` for
 * wikilinks, or the bare tag text for tags). Editing is uncontrolled-by-
 * keystroke but value-synced via props; changes are pushed up through
 * `onChange` for the parent to autosave — the popup never mutates content
 * except on an explicit insert, so it can never drop the user's keystrokes.
 */

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';

import type { IndexedNote } from '../lib/vault/types';

interface MarkdownEditorProps {
  value: string;
  notes: IndexedNote[];
  /** Known vault tags (no leading `#`), for `#tag` autocomplete. */
  tags: string[];
  onChange(value: string): void;
}

type ActiveKind = 'wikilink' | 'tag';

interface ActiveToken {
  kind: ActiveKind;
  /** Index just after the opening `[[` or `#`. */
  start: number;
  /** The partial query typed so far. */
  query: string;
}

/** Find an open `[[` immediately before the caret on the same segment. */
function findActiveWikiLink(text: string, caret: number): ActiveToken | null {
  const open = text.lastIndexOf('[[', caret);
  if (open === -1) return null;
  const between = text.slice(open + 2, caret);
  // Bail if the link was already closed or spans a newline.
  if (between.includes(']]') || between.includes('\n')) return null;
  return { kind: 'wikilink', start: open + 2, query: between };
}

/**
 * Find an active inline `#tag` token ending at the caret. The `#` must sit at
 * the start of the buffer or after whitespace (so we don't fire inside URLs or
 * `c#`-style fragments), and the typed portion must be valid tag characters.
 */
function findActiveTag(text: string, caret: number): ActiveToken | null {
  const hash = text.lastIndexOf('#', caret - 1);
  if (hash === -1) return null;
  const before = hash === 0 ? '' : text[hash - 1];
  if (before !== '' && !/\s/.test(before)) return null;
  const between = text.slice(hash + 1, caret);
  // Only fire while typing the tag body — valid tag chars, no whitespace.
  if (!/^[\p{L}\p{N}_/-]*$/u.test(between)) return null;
  return { kind: 'tag', start: hash + 1, query: between };
}

/** Detect whichever completion is active at the caret (wikilink wins ties). */
function findActiveToken(text: string, caret: number): ActiveToken | null {
  return findActiveWikiLink(text, caret) ?? findActiveTag(text, caret);
}

export function MarkdownEditor({ value, notes, tags, onChange }: MarkdownEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [active, setActive] = useState<ActiveToken | null>(null);
  const [highlight, setHighlight] = useState(0);
  const textareaId = useId();
  const listboxId = useId();

  const suggestions = useMemo(() => {
    if (!active) return [];
    const q = active.query.trim().toLowerCase();
    if (active.kind === 'wikilink') {
      const titles = notes.map((n) => n.parsed.title);
      const filtered = q === '' ? titles : titles.filter((t) => t.toLowerCase().includes(q));
      return filtered.slice(0, 8);
    }
    // Tag suggestions: prefix matches first, then any substring. An empty query
    // (just typed `#`) offers the existing tags so they stay consistent.
    const filtered =
      q === ''
        ? tags
        : [...tags]
            .filter((t) => t.includes(q))
            .sort((a, b) => {
              const ap = a.startsWith(q) ? 0 : 1;
              const bp = b.startsWith(q) ? 0 : 1;
              return ap - bp || a.localeCompare(b);
            });
    return filtered.slice(0, 8);
  }, [active, notes, tags]);

  useEffect(() => {
    setHighlight(0);
  }, [active?.query, active?.kind]);

  // Keep caret detection in sync after the value changes externally.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || document.activeElement !== el) return;
    setActive(findActiveToken(el.value, el.selectionStart));
  }, [value]);

  const refreshActive = () => {
    const el = ref.current;
    if (!el) return;
    setActive(findActiveToken(el.value, el.selectionStart));
  };

  const applySuggestion = (choice: string) => {
    const el = ref.current;
    if (!el || !active) return;
    const before = el.value.slice(0, active.start);
    const after = el.value.slice(active.start + active.query.length);
    // Wikilinks close the brackets; tags insert the bare tag plus a trailing
    // space so the user can keep typing.
    const insertion = active.kind === 'wikilink' ? `${choice}]]` : `${choice} `;
    const next = `${before}${insertion}${after}`;
    onChange(next);
    setActive(null);
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

  const popupLabel = active?.kind === 'tag' ? 'Insert tag' : 'Link to note';

  const hasPopup = active !== null && suggestions.length > 0;

  return (
    <div className="relative h-full">
      {/* Visually-hidden label gives the textarea an accessible name. */}
      <label htmlFor={textareaId} className="sr-only">
        Markdown editor
      </label>
      <textarea
        ref={ref}
        id={textareaId}
        value={value}
        spellCheck={false}
        role="textbox"
        aria-multiline="true"
        aria-label="Markdown editor"
        aria-autocomplete={hasPopup ? 'list' : 'none'}
        aria-expanded={hasPopup}
        aria-controls={hasPopup ? listboxId : undefined}
        aria-activedescendant={hasPopup ? `suggestion-${highlight}` : undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        onKeyUp={refreshActive}
        onClick={refreshActive}
        onBlur={() => setActive(null)}
        className="h-full w-full resize-none bg-transparent px-6 py-5 font-mono text-sm leading-relaxed text-neutral-200 outline-none placeholder:text-neutral-600"
        placeholder="Start writing… use [[ to link notes and # to tag."
      />
      {hasPopup && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={popupLabel}
          className="absolute left-6 top-16 z-10 w-72 overflow-hidden rounded-md border border-neutral-700 bg-neutral-900 shadow-xl motion-safe:animate-[fadeIn_100ms_ease-out]"
        >
          <li
            role="presentation"
            className="border-b border-neutral-800 px-3 py-1 text-xs text-neutral-500"
          >
            {popupLabel}
          </li>
          {suggestions.map((choice, i) => (
            <li key={choice} role="option" aria-selected={i === highlight} id={`suggestion-${i}`}>
              <button
                type="button"
                // onMouseDown beats the textarea's onBlur so the insert lands.
                onMouseDown={(e) => {
                  e.preventDefault();
                  applySuggestion(choice);
                }}
                className={[
                  'block w-full truncate px-3 py-1.5 text-left text-sm',
                  i === highlight
                    ? 'bg-neutral-700 text-neutral-100'
                    : 'text-neutral-300 hover:bg-neutral-800',
                ].join(' ')}
              >
                {active.kind === 'tag' ? `#${choice}` : choice}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
