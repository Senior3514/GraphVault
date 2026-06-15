'use client';

/** Shows notes that link to the current note, plus its tags and outbound links. */

import type { Backlink } from '../lib/vault/links';
import type { IndexedNote, NotePath } from '../lib/vault/types';

interface BacklinksPanelProps {
  note: IndexedNote;
  backlinks: Backlink[];
  resolveLink(target: string): NotePath | null;
  onOpen(path: NotePath): void;
  /** Filter the note list by a tag when one of this note's tags is clicked. */
  onTag?(tag: string): void;
}

export function BacklinksPanel({
  note,
  backlinks,
  resolveLink,
  onOpen,
  onTag,
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
                  onTag ? 'hover:bg-sky-500/20 hover:text-sky-200' : 'cursor-default',
                ].join(' ')}
              >
                #{tag}
              </button>
            ))}
          </div>
        )}
      </Section>

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
