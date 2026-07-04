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
import { toTrustedHTML } from '../lib/security/trustedTypes';

interface MarkdownPreviewProps {
  markdown: string;
  resolve: ResolveTarget;
  onNavigate(target: string): void;
  onTag?(tag: string): void;
}

export function MarkdownPreview({ markdown, resolve, onNavigate, onTag }: MarkdownPreviewProps) {
  // `renderMarkdown` already ran the raw markdown through DOMPurify; wrap the
  // result through our Trusted Types policy so this sink is ready for when the
  // CSP `trusted-types` directive is enabled (not yet - see the blocker note
  // in `lib/security/csp.ts`). No-op passthrough today either way - see
  // `lib/security/trustedTypes.ts`.
  const html = useMemo(() => toTrustedHTML(renderMarkdown(markdown, resolve)), [markdown, resolve]);

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
      role="region"
      aria-label="Markdown preview"
      onClick={handleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
