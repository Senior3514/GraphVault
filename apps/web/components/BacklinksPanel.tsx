'use client';

/** Shows notes that link to the current note, plus its tags and outbound links. */

import { useState } from 'react';
import type { Backlink } from '../lib/vault/links';
import type { IndexedNote, NotePath } from '../lib/vault/types';

interface BacklinksPanelProps {
  note: IndexedNote;
  backlinks: Backlink[];
  /** All notes, for the parent-picker's suggestion list. */
  allNotes: readonly IndexedNote[];
  resolveLink(target: string): NotePath | null;
  onOpen(path: NotePath): void;
  /** Filter the note list by a tag when one of this note's tags is clicked. */
  onTag?(tag: string): void;
  /**
   * Set (`value` non-null) or remove (`value === null`) this note's
   * CherryTree-style hierarchy parent. `value` is a note title or path, as
   * typed in the picker - resolution happens the same way `buildNoteHierarchy`
   * resolves it (see `@graphvault/engine`).
   */
  onSetParent(path: NotePath, value: string | null): void;
}

export function BacklinksPanel({
  note,
  backlinks,
  allNotes,
  resolveLink,
  onOpen,
  onTag,
  onSetParent,
}: BacklinksPanelProps) {
  const outbound = note.parsed.links
    .map((l) => ({ link: l, path: resolveLink(l.target) }))
    .filter((o): o is { link: typeof o.link; path: NotePath } => o.path !== null);

  return (
    <aside className="flex w-72 shrink-0 flex-col gap-6 overflow-auto border-l border-neutral-800 bg-neutral-950 px-4 py-5 text-sm">
      <Section title="Tags">
        {note.parsed.tags.length === 0 ? (
          <Empty>No tags</Empty>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {note.parsed.tags.map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={() => onTag?.(tag)}
                disabled={!onTag}
                title={onTag ? `Filter by #${tag}` : undefined}
                className={[
                  'rounded-full bg-neutral-800 px-2 py-0.5 text-xs text-neutral-300 transition-colors',
                  onTag ? 'hover:bg-accent-500/20 hover:text-accent-200' : 'cursor-default',
                ].join(' ')}
              >
                #{tag}
              </button>
            ))}
          </div>
        )}
      </Section>

      {/* CherryTree-style hierarchy: keyed by note.path so the draft input
          resets to this note's current parent when switching notes, rather
          than carrying over stale text from the previously-open note. */}
      <ParentSection
        key={note.path}
        note={note}
        allNotes={allNotes}
        resolveLink={resolveLink}
        onOpen={onOpen}
        onSetParent={onSetParent}
      />

      <Section title={`Backlinks (${backlinks.length})`}>
        {backlinks.length === 0 ? (
          <Empty>No notes link here yet</Empty>
        ) : (
          <ul className="space-y-1">
            {backlinks.map((b, i) => (
              <li key={`${b.from}-${i}`}>
                <button
                  type="button"
                  onClick={() => onOpen(b.from)}
                  className="block w-full truncate rounded px-2 py-1 text-left text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100"
                  title={b.from}
                >
                  {b.fromTitle}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title={`Links out (${outbound.length})`}>
        {outbound.length === 0 ? (
          <Empty>No outbound links</Empty>
        ) : (
          <ul className="space-y-1">
            {outbound.map((o, i) => (
              <li key={`${o.path}-${i}`}>
                <button
                  type="button"
                  onClick={() => onOpen(o.path)}
                  className="block w-full truncate rounded px-2 py-1 text-left text-neutral-300 hover:bg-neutral-900 hover:text-neutral-100"
                  title={o.path}
                >
                  {o.link.alias ?? o.link.target}
                </button>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </aside>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-neutral-600">{children}</p>;
}

interface ParentSectionProps {
  note: IndexedNote;
  allNotes: readonly IndexedNote[];
  resolveLink(target: string): NotePath | null;
  onOpen(path: NotePath): void;
  onSetParent(path: NotePath, value: string | null): void;
}

const PARENT_DATALIST_ID = 'gv-parent-note-options';

function ParentSection({ note, allNotes, resolveLink, onOpen, onSetParent }: ParentSectionProps) {
  const currentRaw =
    typeof note.parsed.frontmatter['parent'] === 'string'
      ? (note.parsed.frontmatter['parent'] as string)
      : null;
  const currentResolvedPath = currentRaw ? resolveLink(currentRaw) : null;
  const currentResolvedTitle = currentResolvedPath
    ? (allNotes.find((n) => n.path === currentResolvedPath)?.parsed.title ?? currentRaw)
    : null;

  const [draft, setDraft] = useState('');

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed === '') return;
    onSetParent(note.path, trimmed);
    setDraft('');
  };

  return (
    <Section title="Parent note (hierarchy)">
      {currentRaw === null ? (
        <Empty>No parent set</Empty>
      ) : currentResolvedPath ? (
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={() => onOpen(currentResolvedPath)}
            className="truncate text-left text-neutral-300 hover:text-neutral-100"
            title={currentResolvedPath}
          >
            {currentResolvedTitle}
          </button>
          <button
            type="button"
            onClick={() => onSetParent(note.path, null)}
            className="shrink-0 text-xs text-neutral-600 hover:text-neutral-300"
          >
            Remove
          </button>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2">
          <p className="truncate text-xs text-amber-500" title={`"${currentRaw}" not found`}>
            ⚠ &ldquo;{currentRaw}&rdquo; not found
          </p>
          <button
            type="button"
            onClick={() => onSetParent(note.path, null)}
            className="shrink-0 text-xs text-neutral-600 hover:text-neutral-300"
          >
            Clear
          </button>
        </div>
      )}

      <form
        onSubmit={(e) => {
          e.preventDefault();
          commit();
        }}
        className="mt-2 flex gap-1.5"
      >
        <input
          type="text"
          list={PARENT_DATALIST_ID}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Set parent note…"
          aria-label="Set parent note"
          className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-2 py-1 text-xs text-neutral-200 outline-none focus:border-neutral-600"
        />
        <datalist id={PARENT_DATALIST_ID}>
          {allNotes
            .filter((n) => n.path !== note.path)
            .map((n) => (
              <option key={n.path} value={n.parsed.title} />
            ))}
        </datalist>
        <button
          type="submit"
          disabled={draft.trim() === ''}
          className="shrink-0 rounded bg-neutral-800 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-700 disabled:opacity-40"
        >
          Set
        </button>
      </form>
    </Section>
  );
}
