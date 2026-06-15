/**
 * Email import connector — 100% client-side, no network calls, no credentials.
 *
 * Supports two email export formats:
 *   - `.eml`  — a single RFC 822 message → one note.
 *   - `.mbox` — multiple messages concatenated with `From ` separator lines →
 *               one note per message.
 *
 * For each message the connector:
 *   1. Parses RFC 822 headers (Subject, From, To, Date, Message-ID).
 *   2. Decodes the body:
 *      - Handles quoted-printable and base64 Content-Transfer-Encoding.
 *      - Prefers `text/plain` parts; falls back to `text/html` → Markdown
 *        conversion (DOM-based in browser, tag-strip fallback in Node tests).
 *      - Recurses into `multipart/*` to find the best readable part.
 *   3. Builds a Markdown note with YAML frontmatter.
 *   4. Guards the output path with `sanitisePathSegment` to prevent path
 *      traversal and filesystem-unsafe names.
 *
 * Security posture:
 *   - Email content is untrusted input. HTML bodies are converted to Markdown
 *     via the same DOM-based path as rssOpml.ts — text is extracted via
 *     `textContent`, never injected back into the live DOM.
 *   - Size limits match portability.ts (MAX_IMPORT_FILE_BYTES / MAX_IMPORT_FILES).
 *   - `safeImportPath` validates every output path.
 *
 * No external dependencies. Uses only built-in browser APIs (DOMParser, atob)
 * plus manual UTF-8 decode for base64 bodies.
 *
 * Phase 2 (NOT built here): live IMAP/Gmail/Outlook OAuth will be a `server`-
 * posture connector — all credential storage and outbound requests handled by
 * the self-hosted GraphVault server, so API keys never touch the browser.
 */

import { ConnectorError, type ConnectorNote, type LocalImportConnector } from './types';
import { sanitisePathSegment } from './rssOpml';

// ---------------------------------------------------------------------------
// Size caps (match portability.ts to keep guards consistent)
// ---------------------------------------------------------------------------

/** Per-message size cap (4 MiB). */
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
/** Maximum messages accepted from one mbox file. */
const MAX_MESSAGES = 10_000;

// ---------------------------------------------------------------------------
// RFC 822 header parsing
// ---------------------------------------------------------------------------

/** A single parsed header field. */
interface HeaderField {
  name: string;
  value: string;
}

/**
 * Parse RFC 822 / MIME headers from the top of a raw message string.
 *
 * Returns the parsed headers and the offset (in chars) where the body starts.
 * Header folding (lines starting with whitespace that continue the previous
 * header) is handled per RFC 2822 §2.2.3.
 */
function parseHeaders(raw: string): { headers: HeaderField[]; bodyStart: number } {
  const lines = raw.split(/\r?\n/);
  const headers: HeaderField[] = [];
  let i = 0;
  let bodyStart = 0;
  let byteCount = 0;

  while (i < lines.length) {
    const line = lines[i];
    byteCount += line.length + 1;

    // Blank line = end of header section.
    if (line.trim() === '') {
      bodyStart = byteCount;
      break;
    }

    // Header folding: lines starting with SP or HT continue the previous field.
    if ((line.startsWith(' ') || line.startsWith('\t')) && headers.length > 0) {
      headers[headers.length - 1].value += ' ' + line.trim();
      i++;
      continue;
    }

    const colon = line.indexOf(':');
    if (colon > 0) {
      const name = line.slice(0, colon).trim().toLowerCase();
      const value = line.slice(colon + 1).trim();
      headers.push({ name, value });
    }
    i++;
  }

  // If we exhausted lines without a blank line, entire content is headers.
  if (bodyStart === 0) bodyStart = raw.length;

  return { headers, bodyStart };
}

/** Get the first value of a header by name (case-insensitive). */
function getHeader(headers: HeaderField[], name: string): string {
  return headers.find((h) => h.name === name.toLowerCase())?.value ?? '';
}

// ---------------------------------------------------------------------------
// RFC 2047 encoded-word decoding (header values)
// ---------------------------------------------------------------------------

/**
 * Decode RFC 2047 encoded-words in a header value.
 * Form: `=?charset?encoding?encoded_text?=`
 * Encoding is Q (quoted-printable) or B (base64).
 *
 * We only support UTF-8 and ISO-8859-1 charsets (the vast majority of real
 * email). Other charsets fall back to raw bytes as Latin-1.
 */
function decodeEncodedWords(value: string): string {
  return value.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_match, charset, enc, text) => {
    const cs = (charset as string).toLowerCase();
    try {
      if ((enc as string).toLowerCase() === 'b') {
        const bytes = base64Decode(text as string);
        return bytesToString(bytes, cs);
      } else {
        // Q encoding: like quoted-printable but underscores are spaces.
        const qp = (text as string).replace(/_/g, ' ');
        const bytes = decodeQuotedPrintableBytes(qp);
        return bytesToString(bytes, cs);
      }
    } catch {
      return text as string;
    }
  });
}

/**
 * Convert a byte array to a string using the given charset.
 * Falls back to Latin-1 for unknown charsets.
 */
function bytesToString(bytes: Uint8Array, charset: string): string {
  if (charset === 'utf-8' || charset === 'utf8') {
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  }
  if (charset === 'iso-8859-1' || charset === 'latin-1' || charset === 'us-ascii') {
    return new TextDecoder('iso-8859-1', { fatal: false }).decode(bytes);
  }
  // Attempt to use the charset label if the browser supports it.
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes);
  } catch {
    // Fall back to Latin-1 for unrecognised charsets.
    return new TextDecoder('iso-8859-1', { fatal: false }).decode(bytes);
  }
}

// ---------------------------------------------------------------------------
// Base64 decoding
// ---------------------------------------------------------------------------

/**
 * Decode a base64 string to a Uint8Array.
 *
 * Uses the platform-standard `atob` (available in all browsers and Node ≥ 16).
 * Whitespace is stripped first since email base64 bodies wrap at 76 columns.
 */
function base64Decode(b64: string): Uint8Array {
  // Strip all whitespace (CRLF line endings in email base64).
  const clean = b64.replace(/\s/g, '');
  if (clean.length === 0) return new Uint8Array(0);

  const bin = atob(clean);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    bytes[i] = bin.charCodeAt(i) & 0xff;
  }
  return bytes;
}

// ---------------------------------------------------------------------------
// Quoted-printable decoding
// ---------------------------------------------------------------------------

/**
 * Decode a quoted-printable encoded string to a Uint8Array of bytes.
 *
 * Per RFC 2045:
 *  - `=XX` is a literal byte with hex value XX.
 *  - `=\r\n` (soft line break) is deleted.
 *  - All other bytes pass through literally.
 */
function decodeQuotedPrintableBytes(qp: string): Uint8Array {
  // Normalise line endings.
  const src = qp.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const out: number[] = [];
  let i = 0;
  while (i < src.length) {
    if (src[i] === '=') {
      if (i + 1 < src.length && src[i + 1] === '\n') {
        // Soft line break — skip.
        i += 2;
        continue;
      }
      if (i + 2 < src.length) {
        const hex = src.slice(i + 1, i + 3);
        const val = parseInt(hex, 16);
        if (!isNaN(val)) {
          out.push(val);
          i += 3;
          continue;
        }
      }
      // Malformed — pass '=' through.
      out.push(0x3d);
      i++;
    } else {
      out.push(src.charCodeAt(i) & 0xff);
      i++;
    }
  }
  return new Uint8Array(out);
}

/**
 * Decode quoted-printable to a string (UTF-8 bytes → string).
 */
function decodeQuotedPrintable(qp: string, charset = 'utf-8'): string {
  const bytes = decodeQuotedPrintableBytes(qp);
  return bytesToString(bytes, charset);
}

// ---------------------------------------------------------------------------
// MIME content-type / parameter parsing
// ---------------------------------------------------------------------------

interface ContentType {
  type: string; // e.g. "text/plain"
  params: Record<string, string>; // e.g. { charset: "utf-8", boundary: "…" }
}

/**
 * Parse a Content-Type header value.
 * Example: `text/plain; charset=utf-8; boundary="abc123"`
 */
function parseContentType(raw: string): ContentType {
  if (!raw) return { type: 'text/plain', params: {} };
  const parts = raw.split(';').map((s) => s.trim());
  const type = (parts[0] ?? 'text/plain').toLowerCase();
  const params: Record<string, string> = {};
  for (const part of parts.slice(1)) {
    const eq = part.indexOf('=');
    if (eq > 0) {
      const key = part.slice(0, eq).trim().toLowerCase();
      let val = part.slice(eq + 1).trim();
      // Strip surrounding quotes.
      if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
      params[key] = val;
    }
  }
  return { type, params };
}

// ---------------------------------------------------------------------------
// MIME multipart splitting
// ---------------------------------------------------------------------------

/**
 * Split a MIME multipart body into its constituent parts.
 *
 * Each returned string is the raw content of one part (including part headers).
 * The encapsulation boundary is `--<boundary>`. The closing boundary is
 * `--<boundary>--`.
 */
function splitMultipart(body: string, boundary: string): string[] {
  const delimiter = '--' + boundary;
  const closer = delimiter + '--';
  const parts: string[] = [];

  const lines = body.split(/\r?\n/);
  let current: string[] = [];
  let inPart = false;

  for (const line of lines) {
    if (line.startsWith(closer)) {
      if (inPart && current.length > 0) {
        parts.push(current.join('\n'));
      }
      break;
    }
    if (line.startsWith(delimiter)) {
      if (inPart && current.length > 0) {
        parts.push(current.join('\n'));
      }
      current = [];
      inPart = true;
      continue;
    }
    if (inPart) {
      current.push(line);
    }
  }
  // Unclosed final part (malformed but tolerate it).
  if (inPart && current.length > 0) {
    parts.push(current.join('\n'));
  }

  return parts;
}

// ---------------------------------------------------------------------------
// HTML → Markdown (reused from rssOpml pattern, inline for isolation)
// ---------------------------------------------------------------------------

/**
 * Convert HTML to safe plain Markdown.
 *
 * Reuses the same security strategy as rssOpml.ts: parse with DOMParser into
 * an isolated document, walk the tree to Markdown text. The result is never
 * injected back into the live DOM.
 *
 * Falls back to tag-stripping in Node (tests), identical to the rssOpml path.
 */
function htmlToMarkdownEmail(html: string): string {
  if (!html || html.trim() === '') return '';

  // Node test environment fallback.
  if (typeof DOMParser === 'undefined') {
    return html
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<\/div>/gi, '\n')
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#039;/g, "'")
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, c: string) => String.fromCodePoint(parseInt(c, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, c: string) => String.fromCodePoint(parseInt(c, 16)))
      .trim();
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<body>${html}</body>`, 'text/html');
  const root = (doc as Document & { body?: Node | null }).body ?? doc.documentElement;
  if (!root) {
    return html.replace(/<[^>]+>/g, '').trim();
  }
  return emailNodeToMarkdown(root as Node).trim();
}

function emailNodeToMarkdown(node: Node): string {
  if (!node) return '';
  if (node.nodeType === 3 /* TEXT_NODE */) {
    return node.textContent ?? '';
  }
  if (node.nodeType !== 1 /* ELEMENT_NODE */) return '';

  const el = node as Element;
  const tag = el.tagName.toLowerCase();
  const children = () => Array.from(el.childNodes).map(emailNodeToMarkdown).join('');

  switch (tag) {
    case 'p':
    case 'div':
    case 'section':
    case 'blockquote':
      return `\n\n${children()}\n\n`;
    case 'br':
      return '\n';
    case 'h1':
      return `\n\n# ${children()}\n\n`;
    case 'h2':
      return `\n\n## ${children()}\n\n`;
    case 'h3':
      return `\n\n### ${children()}\n\n`;
    case 'h4':
    case 'h5':
    case 'h6':
      return `\n\n#### ${children()}\n\n`;
    case 'strong':
    case 'b':
      return `**${children()}**`;
    case 'em':
    case 'i':
      return `_${children()}_`;
    case 'a': {
      const href = el.getAttribute('href') ?? '';
      const text = children();
      if (!href || href === text) return text;
      if (/^(https?:\/\/|mailto:)/i.test(href)) return `[${text}](${href})`;
      return text;
    }
    case 'ul':
    case 'ol': {
      const items = Array.from(el.querySelectorAll(':scope > li'));
      const lines = items.map((li, i) => {
        const prefix = tag === 'ul' ? '-' : `${i + 1}.`;
        return `${prefix} ${(li.textContent ?? '').trim().replace(/\n+/g, ' ')}`;
      });
      return `\n\n${lines.join('\n')}\n\n`;
    }
    case 'li':
      return children();
    case 'pre':
    case 'code': {
      const inner = el.textContent ?? '';
      return inner.includes('\n') ? `\`\`\`\n${inner}\n\`\`\`` : `\`${inner}\``;
    }
    case 'body':
    case 'html':
    case 'span':
    case 'table':
    case 'tbody':
    case 'tr':
    case 'td':
    case 'th':
      return children();
    case 'script':
    case 'style':
    case 'noscript':
    case 'head':
    case 'iframe':
    case 'object':
    case 'embed':
      return '';
    default:
      return children();
  }
}

// ---------------------------------------------------------------------------
// MIME body decoding
// ---------------------------------------------------------------------------

/**
 * Decode a MIME body part into a plain string, given its Content-Transfer-Encoding.
 *
 * Supported encodings:
 *   - `quoted-printable` (most common for text/plain)
 *   - `base64`           (most common for text/html and attachments)
 *   - `7bit` / `8bit` / `binary` → pass through
 */
function decodeBody(raw: string, cte: string, charset: string): string {
  const enc = cte.trim().toLowerCase();
  if (enc === 'quoted-printable') {
    return decodeQuotedPrintable(raw, charset);
  }
  if (enc === 'base64') {
    const bytes = base64Decode(raw);
    return bytesToString(bytes, charset);
  }
  // 7bit / 8bit / binary — content is already a plain string.
  return raw;
}

// ---------------------------------------------------------------------------
// Recursive MIME structure extraction
// ---------------------------------------------------------------------------

/** The result of extracting the best readable body from a MIME structure. */
interface ExtractedBody {
  /** Markdown content (converted from text/plain or text/html). */
  markdown: string;
  /** Content type that was selected ("text/plain" or "text/html"). */
  selectedType: string;
}

/**
 * Extract the best readable body from a MIME entity (possibly multipart).
 *
 * Preference order: text/plain > text/html. For multipart/alternative,
 * we pick the preferred type. For multipart/mixed, we concatenate all
 * readable parts. For other multipart types, we take the first readable.
 */
function extractBody(rawPart: string, depth = 0): ExtractedBody | null {
  if (depth > 10) return null; // guard against infinite recursion in pathological inputs

  const { headers, bodyStart } = parseHeaders(rawPart);
  const ctRaw = getHeader(headers, 'content-type');
  const ct = parseContentType(ctRaw);
  const cte = getHeader(headers, 'content-transfer-encoding') || '7bit';
  const charset = ct.params['charset'] ?? 'utf-8';
  const body = rawPart.slice(bodyStart);

  if (ct.type.startsWith('multipart/')) {
    const boundary = ct.params['boundary'];
    if (!boundary) return null;

    const parts = splitMultipart(body, boundary);
    if (parts.length === 0) return null;

    if (ct.type === 'multipart/alternative') {
      // Prefer text/plain; fall back to text/html.
      let plain: ExtractedBody | null = null;
      let html: ExtractedBody | null = null;

      for (const part of parts) {
        const partCt = parseContentType(getHeader(parseHeaders(part).headers, 'content-type'));
        if (partCt.type === 'text/plain' && !plain) {
          plain = extractBody(part, depth + 1);
        } else if (partCt.type === 'text/html' && !html) {
          html = extractBody(part, depth + 1);
        }
      }
      return plain ?? html;
    }

    if (ct.type === 'multipart/mixed') {
      // Concatenate all readable parts.
      const segments: string[] = [];
      for (const part of parts) {
        const extracted = extractBody(part, depth + 1);
        if (extracted?.markdown.trim()) {
          segments.push(extracted.markdown.trim());
        }
      }
      if (segments.length === 0) return null;
      return { markdown: segments.join('\n\n'), selectedType: 'multipart/mixed' };
    }

    // For other multipart types (related, signed, etc.), recurse into each part
    // and return the first readable result.
    for (const part of parts) {
      const extracted = extractBody(part, depth + 1);
      if (extracted) return extracted;
    }
    return null;
  }

  if (ct.type === 'text/plain') {
    const decoded = decodeBody(body, cte, charset);
    return { markdown: decoded, selectedType: 'text/plain' };
  }

  if (ct.type === 'text/html') {
    const decoded = decodeBody(body, cte, charset);
    const md = htmlToMarkdownEmail(decoded);
    return { markdown: md, selectedType: 'text/html' };
  }

  // Non-text MIME type (attachment, image, etc.) — skip.
  return null;
}

// ---------------------------------------------------------------------------
// Path generation for email notes
// ---------------------------------------------------------------------------

/**
 * Build a vault-relative path for a single email note.
 *
 *   connectors/email/<YYYY-MM>/<Subject>.md
 *
 * `dateStr` should be ISO-like (we extract YYYY-MM). Falls back to "unknown-date".
 * Subject is sanitised; falls back to "Untitled Message".
 */
export function buildEmailNotePath(subject: string, dateStr: string): string {
  let monthSegment = 'unknown-date';
  if (dateStr) {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, '0');
      monthSegment = `${y}-${m}`;
    }
  }
  const title = sanitisePathSegment(subject) || 'Untitled Message';
  return `connectors/email/${monthSegment}/${title}.md`;
}

// ---------------------------------------------------------------------------
// Single-message parser
// ---------------------------------------------------------------------------

/**
 * Parse a single RFC 822 message (string) into a `ConnectorNote`.
 *
 * @param raw   Raw message text.
 * @param index Optional index within an mbox (used to avoid path collisions).
 */
export function parseEmlMessage(raw: string, index?: number): ConnectorNote {
  if (raw.length > MAX_MESSAGE_BYTES) {
    throw new ConnectorError(
      `Message is too large (${(raw.length / 1024 / 1024).toFixed(1)} MiB > 4 MiB limit).`,
    );
  }

  const { headers } = parseHeaders(raw);

  const subject = decodeEncodedWords(getHeader(headers, 'subject')) || 'Untitled Message';
  const from = decodeEncodedWords(getHeader(headers, 'from'));
  const to = decodeEncodedWords(getHeader(headers, 'to'));
  const dateRaw = getHeader(headers, 'date');
  const messageId = getHeader(headers, 'message-id');

  // Parse date → epoch ms.
  let dateMs: number | undefined;
  let dateIso: string | undefined;
  if (dateRaw) {
    const ms = Date.parse(dateRaw);
    if (!isNaN(ms)) {
      dateMs = ms;
      dateIso = new Date(ms).toISOString();
    }
  }

  // Extract the body from the full message (starting from the raw message top,
  // treating the whole thing as a MIME entity).
  const bodyExtracted = extractBody(raw);
  const bodyMarkdown = bodyExtracted?.markdown ?? '';

  // Build path.
  let notePath = buildEmailNotePath(subject, dateIso ?? '');
  // For mbox imports, add index suffix to avoid collisions when subjects repeat.
  if (index !== undefined) {
    // Insert index before the .md extension.
    notePath = notePath.replace(/\.md$/, ` (${index + 1}).md`);
  }

  // Build note content.
  const lines: string[] = [];
  lines.push('---');
  lines.push(`title: ${JSON.stringify(subject)}`);
  if (from) lines.push(`from: ${JSON.stringify(from)}`);
  if (to) lines.push(`to: ${JSON.stringify(to)}`);
  if (dateIso) lines.push(`date: ${JSON.stringify(dateIso)}`);
  if (messageId) lines.push(`message_id: ${JSON.stringify(messageId)}`);
  lines.push('tags: [email-import]');
  lines.push('---');
  lines.push('');
  lines.push(`# ${subject}`);
  lines.push('');

  if (from) lines.push(`**From:** ${from}  `);
  if (to) lines.push(`**To:** ${to}  `);
  if (dateIso)
    lines.push(`**Date:** ${new Date(dateIso).toLocaleString('en-US', { timeZone: 'UTC' })}  `);
  if (from || to || dateIso) lines.push('');

  if (bodyMarkdown.trim()) {
    lines.push(
      bodyMarkdown
        .replace(/\n{3,}/g, '\n\n') // collapse excess blank lines
        .trim(),
    );
    lines.push('');
  }

  return {
    path: notePath,
    content: lines.join('\n'),
    ctime: dateMs,
    mtime: dateMs,
  };
}

// ---------------------------------------------------------------------------
// mbox parser
// ---------------------------------------------------------------------------

/**
 * Parse an mbox file into individual RFC 822 messages.
 *
 * The mbox format separates messages with lines starting with `From ` (a
 * space after "From", distinguishing it from the `From:` header). This
 * "Unix mbox" / mboxo format is the most common.
 *
 * Returns an array of raw message strings (without the `From ` envelope line).
 */
export function splitMbox(mbox: string): string[] {
  // The From line is at the start of each message:
  // "From <sender> <date>\n"
  // We split on lines matching /^From /m — note the space.
  const messages: string[] = [];
  const lines = mbox.split(/\r?\n/);
  let current: string[] = [];
  let inMessage = false;

  for (const line of lines) {
    if (/^From /.test(line)) {
      // Save any accumulated message.
      if (inMessage && current.length > 0) {
        // Un-quote any ">From " lines that mboxo-quoting introduced.
        messages.push(current.join('\n').replace(/^>From /gm, 'From '));
      }
      current = [];
      inMessage = true;
      // Do not include the From envelope line in the message.
      continue;
    }
    if (inMessage) {
      current.push(line);
    }
  }
  // Last message.
  if (inMessage && current.length > 0) {
    messages.push(current.join('\n').replace(/^>From /gm, 'From '));
  }

  return messages;
}

// ---------------------------------------------------------------------------
// Public connector parse function
// ---------------------------------------------------------------------------

/**
 * Parse `.eml` or `.mbox` source text into connector notes.
 *
 * For `.eml`, the entire source is one message → one note.
 * For `.mbox`, splits on `From ` envelope lines → one note per message.
 *
 * Auto-detects format:
 *  - If the source starts with `From ` it is treated as mbox.
 *  - Otherwise it is treated as a single .eml message.
 *
 * Throws `ConnectorError` on empty input or if no messages could be parsed.
 */
export function parseEmailSource(source: string): ConnectorNote[] {
  if (!source || source.trim() === '') {
    throw new ConnectorError('Source is empty.');
  }

  // Auto-detect mbox vs eml.
  const isMbox = /^From /m.test(source.trimStart().slice(0, 200));

  if (isMbox) {
    const rawMessages = splitMbox(source);
    if (rawMessages.length === 0) {
      throw new ConnectorError('No messages found in the mbox file.');
    }
    if (rawMessages.length > MAX_MESSAGES) {
      throw new ConnectorError(
        `mbox contains too many messages (${rawMessages.length} > ${MAX_MESSAGES} limit).`,
      );
    }

    const notes: ConnectorNote[] = [];
    const errors: string[] = [];

    for (let i = 0; i < rawMessages.length; i++) {
      try {
        const note = parseEmlMessage(rawMessages[i], i);
        notes.push(note);
      } catch (err) {
        errors.push(err instanceof Error ? err.message : `Message ${i + 1} failed.`);
      }
    }

    if (notes.length === 0) {
      throw new ConnectorError(
        `No messages could be parsed. Errors: ${errors.slice(0, 3).join('; ')}`,
      );
    }

    return notes;
  }

  // Single .eml message.
  return [parseEmlMessage(source)];
}

// ---------------------------------------------------------------------------
// Public connector singleton
// ---------------------------------------------------------------------------

/**
 * The email import connector singleton.
 *
 * Privacy posture: `local` — the user provides .eml or .mbox files directly
 * (file upload). No network calls are made. No credentials required.
 *
 * Phase 2 (NOT built here): live IMAP / Gmail / Outlook OAuth will be a
 * `server`-posture connector where all credential storage and outbound
 * requests (IMAP, Gmail API, Graph API) are handled by the self-hosted
 * GraphVault server. The browser would only ever hold a short-lived session
 * token — no email credentials, no Google/Microsoft OAuth tokens — and the
 * server would periodically fetch new mail and push notes to the vault.
 * That feature needs a server-side mail dependency (e.g. `imapflow`) and is
 * out of scope for phase 1.
 */
export const emailConnector: LocalImportConnector = {
  id: 'email-import',
  name: 'Email import (.eml / .mbox)',
  description:
    'Import emails from .eml files (single message) or .mbox archives (multiple messages). ' +
    'Each message becomes one note under connectors/email/. ' +
    'Upload files from your email client — nothing leaves your device.',
  privacyPosture: 'local',

  isAvailable(): boolean {
    return true;
  },

  acceptedExtensions: ['.eml', '.mbox'],
  acceptedMimeTypes: ['message/rfc822', 'application/mbox'],

  parse(source: string): ConnectorNote[] {
    return parseEmailSource(source);
  },
};
