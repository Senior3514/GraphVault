'use client';

/**
 * Clickable tag list for the vault sidebar. Selecting a tag filters the note
 * list; selecting it again clears the filter. Purely presentational - the
 * active tag and the toggle handler are owned by the vault page.
 */

import type { TagCount } from '../lib/vault/tags';

interface TagListProps {
  tags: TagCount[];
  activeTag: string | null;
  onToggle(tag: string): void;
}

export function TagList({ tags, activeTag, onToggle }: TagListProps) {
  if (tags.length === 0) {
    return <p className="px-2 py-1 text-xs text-neutral-600">No tags yet.</p>;
  }
  return (
    <div className="flex flex-wrap gap-1.5 px-2 py-1">
      {tags.map(({ tag, count }) => {
        const active = tag === activeTag;
        return (
          <button
            key={tag}
            type="button"
            onClick={() => onToggle(tag)}
            aria-pressed={active}
            title={`${count} note${count === 1 ? '' : 's'}`}
            className={[
              'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs transition-colors motion-reduce:transition-none',
              active
                ? 'border-sky-400/40 bg-sky-500/15 text-sky-200'
                : 'border-neutral-800 bg-neutral-900/60 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200',
            ].join(' ')}
          >
            <span>#{tag}</span>
            <span className={active ? 'text-sky-300/70' : 'text-neutral-600'}>{count}</span>
          </button>
        );
      })}
    </div>
  );
}
