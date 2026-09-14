/**
 * GraphVault Web Clipper - content script.
 *
 * Injected into every page at document_idle. Listens for messages from the
 * popup and background service worker, runs the clipper, and returns the
 * extracted Markdown + metadata.
 *
 * Message API (chrome.runtime.sendMessage / tabs.sendMessage):
 *   Request:  { type: 'GV_CLIP_SELECTION' | 'GV_CLIP_PAGE' }
 *   Response: { ok: true, data: ClipResult } | { ok: false, error: string }
 *
 *   ClipResult: { markdown: string, title: string, url: string }
 */

// ---------------------------------------------------------------------------
// Inline the clipper logic (avoids a second injected file at runtime).
// In MV3 content scripts, all <script> imports share the isolated world.
// We replicate the core functions here rather than using ES module imports,
// which require the scripts array to list them explicitly anyway.
// ---------------------------------------------------------------------------

// -- Utility --

function resolveUrl(url) {
  try {
    return new URL(url, document.baseURI).href;
  } catch {
    return url;
  }
}

function cleanupMd(md) {
  return md
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

// -- HTML → Markdown --

function nodeToMd(node, ctx) {
  if (!ctx) ctx = { listDepth: 0 };

  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent || '';
    if (ctx.inPre) return text;
    return text.replace(/\s+/g, ' ');
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  const el = /** @type {HTMLElement} */ (node);
  const tag = el.tagName.toLowerCase();

  // Skip invisible, scripting, and navigation/chrome elements
  try {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return '';
  } catch {
    // getComputedStyle can throw for detached nodes
  }

  if (
    tag === 'script' || tag === 'style' || tag === 'noscript' ||
    tag === 'nav' || tag === 'footer' || tag === 'aside' || tag === 'header'
  ) return '';

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
    case 'p': return `\n\n${inner().trim()}\n\n`;
    case 'br': return '  \n';
    case 'hr': return '\n\n---\n\n';

    case 'strong':
    case 'b': { const t = inner().trim(); return t ? `**${t}**` : ''; }

    case 'em':
    case 'i': { const t = inner().trim(); return t ? `_${t}_` : ''; }

    case 's':
    case 'del': { const t = inner().trim(); return t ? `~~${t}~~` : ''; }

    case 'code': {
      if (ctx.inPre) return el.textContent || '';
      const t = el.textContent || '';
      return t ? `\`${t.replace(/`/g, '\\`')}\`` : '';
    }

    case 'pre': {
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
      return `![${alt}](${resolveUrl(src)})`;
    }

    case 'ul': {
      const items = childListItems(el, ctx, false);
      return items ? `\n\n${items}\n\n` : '';
    }

    case 'ol': {
      const items = childListItems(el, ctx, true);
      return items ? `\n\n${items}\n\n` : '';
    }

    case 'li': return `- ${inner().trim()}\n`;

    case 'table': return tableToMd(el, ctx);
    case 'thead': case 'tbody': case 'tr': case 'th': case 'td':
      return inner();

    case 'div': case 'section': case 'article': case 'main': {
      const text = inner().trim();
      return text ? `\n\n${text}\n\n` : '';
    }

    default: return inner();
  }
}

function childListItems(listEl, ctx, ordered) {
  const depth = ctx.listDepth || 0;
  const indent = '  '.repeat(depth);
  let counter = 0;
  const lines = [];

  for (const child of listEl.children) {
    if (child.tagName.toLowerCase() !== 'li') continue;
    counter++;
    const prefix = ordered ? `${counter}.` : '-';

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

function tableToMd(tableEl, ctx) {
  const rows = Array.from(tableEl.querySelectorAll('tr'));
  if (rows.length === 0) return '';

  const cellText = (cell) => {
    const c = Object.assign({}, ctx);
    return Array.from(cell.childNodes)
      .map(n => nodeToMd(n, c))
      .join('')
      .replace(/\|/g, '\\|')
      .replace(/\s+/g, ' ')
      .trim();
  };

  const headerRow = rows[0];
  const headers = Array.from(headerRow.querySelectorAll('th, td')).map(cellText);
  if (headers.length === 0) return '';

  const sep = headers.map(() => '---');
  const bodyRows = rows.slice(1)
    .map(row => Array.from(row.querySelectorAll('th, td')).map(cellText))
    .filter(r => r.length > 0);

  const fmt = (cols) => `| ${cols.join(' | ')} |`;
  const out = [fmt(headers), fmt(sep), ...bodyRows.map(fmt)];
  return `\n\n${out.join('\n')}\n\n`;
}

// -- Readability heuristic --

function extractMainContent() {
  const article = document.querySelector('article');
  if (article) return article;
  const main = document.querySelector('main, [role="main"]');
  if (main) return main;

  const BAD_RE = /nav|footer|sidebar|aside|comment|ad|promo|sponsor|banner|widget|modal|cookie|subscribe|social|share|header/i;
  const GOOD_RE = /content|article|post|entry|story|body|text|main|prose/i;

  const candidates = Array.from(document.querySelectorAll('div, section, article, td'));
  let best = null;
  let bestScore = -Infinity;

  for (const el of candidates) {
    const text = el.innerText || '';
    if (text.length < 200) continue;
    if (el.querySelectorAll('div, section').length > 30) continue;

    let score = text.length / 100;
    score += el.querySelectorAll('p').length * 3;

    const linkText = Array.from(el.querySelectorAll('a'))
      .map(a => a.innerText || '').join('').length;
    const linkDensity = text.length > 0 ? linkText / text.length : 0;
    score -= linkDensity * 50;

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

// -- Clip functions --

function clipSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

  const range = sel.getRangeAt(0);
  const fragment = range.cloneContents();
  const wrapper = document.createElement('div');
  wrapper.appendChild(fragment);

  const markdown = cleanupMd(nodeToMd(wrapper, {}));
  if (!markdown.trim()) return null;

  return { markdown, title: document.title || '', url: window.location.href };
}

function clipPage() {
  const content = extractMainContent();
  const markdown = cleanupMd(nodeToMd(content, {}));
  return { markdown, title: document.title || '', url: window.location.href };
}

// ---------------------------------------------------------------------------
// Message listener
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  try {
    if (message.type === 'GV_CLIP_SELECTION') {
      const result = clipSelection();
      if (!result) {
        sendResponse({ ok: false, error: 'No text selected on this page.' });
      } else {
        sendResponse({ ok: true, data: result });
      }
    } else if (message.type === 'GV_CLIP_PAGE') {
      const result = clipPage();
      sendResponse({ ok: true, data: result });
    } else {
      sendResponse({ ok: false, error: `Unknown message type: ${message.type}` });
    }
  } catch (err) {
    sendResponse({ ok: false, error: String(err) });
  }
  // Return true to keep the message channel open for async sendResponse
  return true;
});
