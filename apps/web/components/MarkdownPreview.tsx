'use client';

/**
 * Renders sanitized markdown HTML and wires wikilink clicks to navigation.
 *
 * Clicking an `<a data-wikilink>` produced by the renderer calls `onNavigate`
 * with the resolved note path (or the raw target for unresolved links, so the
 * caller can offer to create it).
 */

import { useMemo, type MouseEvent } from 'react';

import { renderMarkdown, type ResolveTarget } from '../lib/markdown/render';

interface MarkdownPreviewProps {
  markdown: string;
  resolve: ResolveTarget;
  onNavigate(target: string): void;
}

export function MarkdownPreview({ markdown, resolve, onNavigate }: MarkdownPreviewProps) {
  const html = useMemo(() => renderMarkdown(markdown, resolve), [markdown, resolve]);

  const handleClick = (e: MouseEvent<HTMLDivElement>) => {
    const el = (e.target as HTMLElement).closest('a[data-wikilink]');
    if (!el) return;
    e.preventDefault();
    const target = el.getAttribute('data-wikilink');
    if (target) onNavigate(target);
  };

  return (
    <div
      className="markdown-preview h-full overflow-auto px-6 py-5"
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
