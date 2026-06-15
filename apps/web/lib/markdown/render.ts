/**
 * Markdown -> sanitized HTML rendering for the preview pane.
 *
 * Pipeline: pre-process `[[wikilinks]]` into anchor placeholders -> render with
 * `marked` -> sanitize with DOMPurify. Sanitization is mandatory: note content
 * is user-controlled and rendered as HTML, so unsanitized output would be an
 * XSS vector. We allow a `data-wikilink` attribute through so the UI can wire
 * click navigation without re-parsing.
 */

import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

/** A function that maps a wikilink target to a known note path, or null. */
export type ResolveTarget = (target: string) => string | null;

const WIKILINK_RE = /\[\[([^\][|]+?)(?:\|([^\][]+?))?\]\]/g;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Replace `[[target|alias]]` with anchor HTML carrying `data-wikilink`. Links
 * to existing notes get a `resolved` class; unknown targets get `unresolved`
 * so the UI can style them (e.g. dim / create-on-click).
 */
function transformWikiLinks(markdown: string, resolve: ResolveTarget): string {
  return markdown.replace(WIKILINK_RE, (_full, rawTarget: string, rawAlias?: string) => {
    const target = rawTarget.trim();
    const alias = (rawAlias ?? rawTarget).trim();
    const resolvedPath = resolve(target);
    const cls = resolvedPath ? 'wikilink wikilink--resolved' : 'wikilink wikilink--unresolved';
    const href = resolvedPath ?? target;
    return `<a class="${cls}" data-wikilink="${escapeHtml(href)}" href="#">${escapeHtml(alias)}</a>`;
  });
}

/** Render markdown to sanitized HTML, resolving wikilinks to navigable anchors. */
export function renderMarkdown(markdown: string, resolve: ResolveTarget): string {
  const withLinks = transformWikiLinks(markdown, resolve);
  const rawHtml = marked.parse(withLinks, { async: false });
  // DOMPurify needs a DOM. During SSR (no `window`) its `sanitize` is a stub, so
  // we must not emit unsanitized HTML — return empty and let the client render
  // pass produce the sanitized output once hydrated.
  if (typeof window === 'undefined' || typeof DOMPurify.sanitize !== 'function') {
    return '';
  }
  return DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: ['data-wikilink', 'target', 'rel'],
    ADD_TAGS: ['input'], // task-list checkboxes from GFM
  });
}
