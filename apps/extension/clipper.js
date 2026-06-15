/**
 * GraphVault Web Clipper — core extraction and conversion logic.
 *
 * Runs in the content-script context (has access to the live DOM).
 * No external dependencies — everything is vanilla JS.
 *
 * Exports (via globalThis assignment for MV3 content-script use):
 *   clipSelection()  — convert the current window selection to Markdown
 *   clipPage()       — extract main content and convert to Markdown
 */

// ---------------------------------------------------------------------------
// HTML → Markdown converter
// ---------------------------------------------------------------------------

/**
 * Convert a DOM node (and its subtree) to a Markdown string.
 * Supports: h1–h6, p, ul/ol/li, blockquote, pre/code, a, strong/b, em/i,
 * img (rendered as a link), br, hr, table (simplified).
 *
 * @param {Node} node
 * @param {object} ctx  – context state threaded through recursion
 * @returns {string}
 */
function nodeToMd(node, ctx) {
  if (!ctx) ctx = { listDepth: 0, orderedCounters: [] };

  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent || '';
    // Collapse whitespace inside non-pre contexts
    if (ctx.inPre) return text;
    return text.replace(/\s+/g, ' ');
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const el = /** @type {HTMLElement} */ (node);
  const tag = el.tagName.toLowerCase();

  // Skip hidden / script / style elements
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return '';
  if (tag === 'script' || tag === 'style' || tag === 'noscript' || tag === 'nav' ||
      tag === 'footer' || tag === 'aside' || tag === 'header') {
    return '';
  }

  // Helper: recurse over children and collect text
  const inner = (extraCtx) => {
    const c = Object.assign({}, ctx, extraCtx);
    return Array.from(el.childNodes).map(n => nodeToMd(n, c)).join('');
  };

  switch (tag) {
    case 'h1': return `\n\n# ${inner().trim()}\n\n`;
    case 'h2': return `\n\n## ${inner().trim()}\n\n`;
    case 'h3': return `\n\n### ${inner().trim()}\n\n`;
    case 'h4': return `\n\n#### ${inner().trim()}\n\n`;
    case 'h5': return `\n\n##### ${inner().trim()}\n\n`;
    case 'h6': return `\n\n###### ${inner().trim()}\n\n`;

    case 'p':
      return `\n\n${inner().trim()}\n\n`;

    case 'br':
      return '  \n';

    case 'hr':
      return '\n\n---\n\n';

    case 'strong':
    case 'b': {
      const t = inner().trim();
      return t ? `**${t}**` : '';
    }

    case 'em':
    case 'i': {
      const t = inner().trim();
      return t ? `_${t}_` : '';
    }

    case 's':
    case 'del': {
      const t = inner().trim();
      return t ? `~~${t}~~` : '';
    }

    case 'code': {
      if (ctx.inPre) return el.textContent || '';
      const t = el.textContent || '';
      return t ? `\`${t.replace(/`/g, '\\`')}\`` : '';
    }

    case 'pre': {
      // Try to detect language from a nested <code class="language-*">
      const codeEl = el.querySelector('code');
      const langMatch = (codeEl?.className || '').match(/language-(\S+)/);
      const lang = langMatch ? langMatch[1] : '';
      const text = (codeEl || el).textContent || '';
      return `\n\n\`\`\`${lang}\n${text.trimEnd()}\n\`\`\`\n\n`;
    }

    case 'blockquote': {
      const lines = inner({ inBlockquote: true }).trim().split('\n');
      return '\n\n' + lines.map(l => `> ${l}`).join('\n') + '\n\n';
    }

    case 'a': {
      const href = el.getAttribute('href') || '';
      const text = inner().trim() || href;
      if (!href || href.startsWith('javascript:')) return text;
      const absHref = resolveUrl(href);
      if (text === absHref) return absHref;
      return `[${text}](${absHref})`;
    }

    case 'img': {
      const src = el.getAttribute('src') || '';
      const alt = el.getAttribute('alt') || '';
      if (!src) return alt;
      const absSrc = resolveUrl(src);
      return `![${alt}](${absSrc})`;
    }

    case 'ul': {
      const items = childListItems(el, ctx, false);
      return items ? `\n\n${items}\n\n` : '';
    }

    case 'ol': {
      const items = childListItems(el, ctx, true);
      return items ? `\n\n${items}\n\n` : '';
    }

    case 'li': {
      // Handled by the parent ul/ol branch; if encountered standalone, render inline
      return `- ${inner().trim()}\n`;
    }

    case 'table': {
      return tableToMd(el, ctx);
    }

    case 'thead':
    case 'tbody':
    case 'tr':
    case 'th':
    case 'td':
      // Handled inside tableToMd; skip if encountered outside
      return inner();

    case 'div':
    case 'section':
    case 'article':
    case 'main': {
      const text = inner().trim();
      return text ? `\n\n${text}\n\n` : '';
    }

    case 'span':
    case 'label':
    case 'mark':
    case 'sup':
    case 'sub':
    case 'abbr':
    case 'cite':
    case 'time':
      return inner();

    default:
      return inner();
  }
}

/** Recursively render list children with proper nesting. */
function childListItems(listEl, ctx, ordered) {
  const depth = ctx.listDepth || 0;
  const indent = '  '.repeat(depth);
  let counter = 0;
  const lines = [];

  for (const child of listEl.children) {
    if (child.tagName.toLowerCase() !== 'li') continue;
    counter++;
    const prefix = ordered ? `${counter}.` : '-';

    // Separate direct text / inline children from nested lists
    let directText = '';
    let nestedMd = '';
    for (const n of child.childNodes) {
      if (n.nodeType === Node.ELEMENT_NODE) {
        const t = n.tagName.toLowerCase();
        if (t === 'ul' || t === 'ol') {
          nestedMd += childListItems(n, { ...ctx, listDepth: depth + 1 }, t === 'ol');
          continue;
        }
      }
      directText += nodeToMd(n, { ...ctx, listDepth: depth });
    }
    const text = directText.replace(/\s+/g, ' ').trim();
    lines.push(`${indent}${prefix} ${text}`);
    if (nestedMd) lines.push(nestedMd);
  }

  return lines.join('\n');
}

/** Convert a <table> element to a GFM Markdown table. */
function tableToMd(tableEl, ctx) {
  const rows = Array.from(tableEl.querySelectorAll('tr'));
  if (rows.length === 0) return '';

  const cellText = (cell) => {
    const c = Object.assign({}, ctx);
    return Array.from(cell.childNodes).map(n => nodeToMd(n, c)).join('').replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
  };

  const headerRow = rows[0];
  const headers = Array.from(headerRow.querySelectorAll('th, td')).map(cellText);
  if (headers.length === 0) return '';

  const sep = headers.map(() => '---');
  const bodyRows = rows.slice(1).map(row =>
    Array.from(row.querySelectorAll('th, td')).map(cellText)
  ).filter(r => r.length > 0);

  const fmt = (cols) => `| ${cols.join(' | ')} |`;
  const out = [fmt(headers), fmt(sep), ...bodyRows.map(fmt)];
  return `\n\n${out.join('\n')}\n\n`;
}

/** Resolve a potentially relative URL against the current document location. */
function resolveUrl(url) {
  try {
    return new URL(url, document.baseURI).href;
  } catch {
    return url;
  }
}

// ---------------------------------------------------------------------------
// Readability heuristic — extract "main content" from a page
// ---------------------------------------------------------------------------

/**
 * Score candidates for main content. Inspired by the ideas behind Mozilla
 * Readability but intentionally tiny and dependency-free.
 *
 * Strategy:
 * 1. Prefer explicit semantic landmarks: <article>, <main>, [role=main].
 * 2. Otherwise, score all block-level container elements by:
 *    - Link density (low is good — nav/footer have high link density)
 *    - Text length (more prose text = higher score)
 *    - Paragraph density (many <p> children = good)
 *    - Penalise known non-content classes/ids (nav, footer, sidebar, ad…)
 * 3. Return the highest-scoring candidate, or <body> as a fallback.
 *
 * @returns {Element}
 */
function extractMainContent() {
  // Semantic shortcuts
  const article = document.querySelector('article');
  if (article) return article;
  const main = document.querySelector('main, [role="main"]');
  if (main) return main;

  const BAD_RE = /nav|footer|sidebar|aside|comment|ad|promo|sponsor|banner|widget|modal|cookie|subscribe|social|share|header/i;
  const GOOD_RE = /content|article|post|entry|story|body|text|main|prose/i;

  const candidates = Array.from(document.querySelectorAll(
    'div, section, article, td'
  ));

  let best = null;
  let bestScore = -Infinity;

  for (const el of candidates) {
    // Skip tiny nodes
    const text = el.innerText || '';
    if (text.length < 200) continue;

    // Skip deeply nested nodes (we want the outermost useful block)
    if (el.querySelectorAll('div, section').length > 30) continue;

    let score = text.length / 100;

    // Paragraph density bonus
    score += el.querySelectorAll('p').length * 3;

    // Link density penalty: links / text length
    const linkText = Array.from(el.querySelectorAll('a'))
      .map(a => a.innerText || '').join('').length;
    const linkDensity = text.length > 0 ? linkText / text.length : 0;
    score -= linkDensity * 50;

    // Class/id signals
    const idClass = `${el.id} ${el.className}`;
    if (BAD_RE.test(idClass)) score -= 40;
    if (GOOD_RE.test(idClass)) score += 25;

    if (score > bestScore) {
      bestScore = score;
      best = el;
    }
  }

  return best || document.body;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Clip the current window selection to Markdown.
 * Returns null if there is no non-empty selection.
 *
 * @returns {{ markdown: string, title: string, url: string } | null}
 */
function clipSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

  const range = sel.getRangeAt(0);
  const fragment = range.cloneContents();
  const wrapper = document.createElement('div');
  wrapper.appendChild(fragment);

  const markdown = cleanupMd(nodeToMd(wrapper, {}));
  if (!markdown.trim()) return null;

  return {
    markdown,
    title: document.title || '',
    url: window.location.href,
  };
}

/**
 * Clip the full page's main content to Markdown.
 *
 * @returns {{ markdown: string, title: string, url: string }}
 */
function clipPage() {
  const content = extractMainContent();
  const markdown = cleanupMd(nodeToMd(content, {}));
  return {
    markdown,
    title: document.title || '',
    url: window.location.href,
  };
}

/**
 * Collapse excess blank lines and trim the result.
 *
 * @param {string} md
 * @returns {string}
 */
function cleanupMd(md) {
  return md
    .replace(/\n{3,}/g, '\n\n')   // at most one blank line between blocks
    .replace(/[ \t]+\n/g, '\n')    // trailing whitespace on lines
    .trim();
}

// Expose on globalThis so the content-script wrapper and popup can call them.
globalThis.__gvClipper = { clipSelection, clipPage };
