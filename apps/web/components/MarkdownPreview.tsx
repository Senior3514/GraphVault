'use client';

/**
 * Renders sanitized markdown HTML and wires wikilink + tag clicks.
 *
 * Clicking an `<a data-wikilink>` produced by the renderer calls `onNavigate`
 * with the resolved note path (or the raw target for unresolved links, so the
 * caller can offer to create it). Clicking an `<a data-tag>` calls `onTag` with
 * the tag name so the caller can filter the note list.
 */

import { useMemo, type MouseEvent } from 'react';

import { renderMarkdown, type ResolveTarget } from '../lib/markdown/render';

interface MarkdownPreviewProps {
  markdown: string;
  resolve: ResolveTarget;
  onNavigate(target: string): void;
  onTag?(tag: string): void;
}

export function MarkdownPreview({ markdown, resolve, onNavigate, onTag }: MarkdownPreviewProps) {
  const html = useMemo(() => renderMarkdown(markdown, resolve), [markdown, resolve]);

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement;
    const wiki = target.closest('a[data-wikilink]');
    if (wiki) {
      e.preventDefault();
      const t = wiki.getAttribute('data-wikilink');
      if (t) onNavigate(t);
      return;
    }
    const tag = target.closest('a[data-tag]');
    if (tag) {
      e.preventDefault();
      const t = tag.getAttribute('data-tag');
      if (t && onTag) onTag(t);
    }
  };

  return (
    <div
      className="markdown-preview h-full overflow-auto px-6 py-5"
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
