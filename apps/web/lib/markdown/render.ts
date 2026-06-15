/**
 * Markdown -> sanitized HTML rendering for the preview pane.
 *
 * Pipeline: pre-process `[[wikilinks]]` into anchor placeholders -> render with
 * `marked` -> sanitize with DOMPurify -> linkify inline `#tags` over the
 * sanitized DOM's text nodes. Sanitization is mandatory: note content is
 * user-controlled and rendered as HTML, so unsanitized output would be an XSS
 * vector. We allow `data-wikilink` / `data-tag` attributes through so the UI
 * can wire click navigation / filtering without re-parsing.
 *
 * Tags are linkified *after* sanitization, by walking text nodes and skipping
 * `code`/`pre`/`a` ancestors. Doing it on the DOM (not a pre-render string
 * replace) means a literal `#fff` or `#include` inside code is left untouched,
 * and the anchors are built with DOM APIs — never raw HTML — so the tag pass
 * introduces no new XSS surface.
 */

import DOMPurify from 'dompurify';
import { marked } from 'marked';

marked.setOptions({ gfm: true, breaks: false });

/** A function that maps a wikilink target to a known note path, or null. */
export type ResolveTarget = (target: string) => string | null;

const WIKILINK_RE = /\[\[([^\][|]+?)(?:\|([^\][]+?))?\]\]/g;

/**
 * Inline `#tags`, mirroring the parser's rule: a `#` at the start or after
 * whitespace, then a tag body. The leading separator is captured separately so
 * it is preserved, and a leading `# ` heading never matches (a space follows).
 */
const INLINE_TAG_RE = /(^|\s)#([\p{L}\p{N}][\p{L}\p{N}_/-]*)/gu;

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

/**
 * Walk the text nodes of a sanitized fragment and turn inline `#tags` into
 * `<a class="hashtag" data-tag="…">` anchors. Anchors are built with DOM APIs
 * (never innerHTML), and text inside `code`/`pre`/`a` is skipped so code and
 * existing links are left intact.
 */
function linkifyTags(root: ParentNode): void {
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  const targets: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.nodeValue || !text.nodeValue.includes('#')) continue;
    let skip = false;
    for (let el = text.parentElement; el; el = el.parentElement) {
      const tag = el.tagName.toLowerCase();
      if (tag === 'code' || tag === 'pre' || tag === 'a') {
        skip = true;
        break;
      }
    }
    if (!skip) targets.push(text);
  }

  for (const text of targets) {
    const value = text.nodeValue ?? '';
    INLINE_TAG_RE.lastIndex = 0;
    if (!INLINE_TAG_RE.test(value)) continue;
    INLINE_TAG_RE.lastIndex = 0;

    const frag = doc.createDocumentFragment();
    let last = 0;
    for (let m = INLINE_TAG_RE.exec(value); m; m = INLINE_TAG_RE.exec(value)) {
      const [, lead, tag] = m;
      const start = m.index + lead.length; // position of the `#`
      if (start > last) frag.appendChild(doc.createTextNode(value.slice(last, start)));
      const anchor = doc.createElement('a');
      anchor.className = 'hashtag';
      anchor.setAttribute('data-tag', tag.toLowerCase());
      anchor.setAttribute('href', '#');
      anchor.textContent = `#${tag}`;
      frag.appendChild(anchor);
      last = start + 1 + tag.length;
    }
    if (last < value.length) frag.appendChild(doc.createTextNode(value.slice(last)));
    text.parentNode?.replaceChild(frag, text);
  }
}

/** Render markdown to sanitized HTML, resolving wikilinks and tags to anchors. */
export function renderMarkdown(markdown: string, resolve: ResolveTarget): string {
  const withLinks = transformWikiLinks(markdown, resolve);
  const rawHtml = marked.parse(withLinks, { async: false });
  // DOMPurify needs a DOM. During SSR (no `window`) its `sanitize` is a stub, so
  // we must not emit unsanitized HTML — return empty and let the client render
  // pass produce the sanitized output once hydrated.
  if (typeof window === 'undefined' || typeof DOMPurify.sanitize !== 'function') {
    return '';
  }
  // Sanitize to a DOM fragment so we can safely post-process tag text nodes,
  // then serialize. `RETURN_DOM_FRAGMENT` keeps everything inside the trusted,
  // already-sanitized tree.
  const fragment = DOMPurify.sanitize(rawHtml, {
    ADD_ATTR: ['data-wikilink', 'data-tag', 'target', 'rel'],
    ADD_TAGS: ['input'], // task-list checkboxes from GFM
    RETURN_DOM_FRAGMENT: true,
  }) as unknown as DocumentFragment;
  linkifyTags(fragment);
  const container = document.createElement('div');
  container.appendChild(fragment);
  return container.innerHTML;
}
