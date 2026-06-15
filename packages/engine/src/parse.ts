/**
 * Markdown note parsing.
 *
 * Pure functions that turn a note's raw markdown + path into structured data:
 * title, frontmatter, inline `#tags`, and outbound links (wikilinks, standard
 * markdown links, and typed relations declared in frontmatter).
 *
 * This module is deliberately dependency-light: it ships a tiny, forgiving YAML
 * subset parser rather than pulling in a full YAML library, which keeps the
 * engine portable and auditable. The subset is documented in the package
 * README and is sufficient for note frontmatter (scalars, flow/block lists,
 * and one level of nested maps such as `relations:`).
 */

import type { FilePath } from '@graphvault/shared';
import type { ParsedLink, ParsedNote } from './types.js';

/** Matches a leading YAML frontmatter block delimited by `---` lines. */
const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Fenced code blocks (``` or ~~~) and inline code spans, for masking. */
const FENCED_CODE_RE = /(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;

/** `[[target#heading|alias]]` — heading and alias optional. */
const WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g;

/** `[text](url)` standard markdown link. */
const MARKDOWN_LINK_RE = /(!?)\[([^\]\n]*)\]\(([^)\s]+)(?:[ \t]+"[^"]*")?\)/g;

/** Inline `#tag`. Allows letters, digits, `_`, `-`, `/` (nested tags). */
const TAG_RE = /(^|[\s(])#([A-Za-z][\w/-]*)/g;

/** First ATX H1 (`# Title`). */
const H1_RE = /^[ \t]*#[ \t]+(.+?)[ \t]*#*[ \t]*$/m;

/**
 * Replace fenced code blocks and inline code spans with equivalent-length
 * blanks so links/tags inside code are ignored without shifting other offsets.
 */
function maskCode(input: string): string {
  const blank = (m: string): string => m.replace(/[^\n]/g, ' ');
  return input.replace(FENCED_CODE_RE, blank).replace(INLINE_CODE_RE, blank);
}

/** Strip surrounding single/double quotes from a scalar, if present. */
function unquote(raw: string): string {
  const s = raw.trim();
  if (s.length >= 2) {
    const first = s[0];
    if ((first === '"' || first === "'") && s[s.length - 1] === first) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/** Coerce a YAML scalar string into a boolean/number/string value. */
function coerceScalar(raw: string): unknown {
  const s = raw.trim();
  if (s === '' || s === '~' || s === 'null') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10);
  if (/^-?\d*\.\d+$/.test(s)) return Number.parseFloat(s);
  return unquote(s);
}

/**
 * True for a YAML flow sequence `[a, b, c]`, but NOT for a bare `[[wikilink]]`
 * scalar — so `refutes: [[Claim B]]` is kept as a string, not split apart.
 */
function isFlowList(raw: string): boolean {
  const s = raw.trim();
  return s.startsWith('[') && s.endsWith(']') && !s.startsWith('[[');
}

/** Parse a flow sequence `[a, b, c]` into scalar values. */
function parseFlowList(raw: string): unknown[] {
  const inner = raw.trim().slice(1, -1).trim();
  if (inner === '') return [];
  return inner.split(',').map((part) => coerceScalar(part));
}

interface YamlLine {
  indent: number;
  content: string;
}

/** Split YAML into significant lines (dropping comments and blanks). */
function toYamlLines(yaml: string): YamlLine[] {
  const out: YamlLine[] = [];
  for (const rawLine of yaml.split(/\r?\n/)) {
    const withoutComment = stripComment(rawLine);
    if (withoutComment.trim() === '') continue;
    const indent = withoutComment.length - withoutComment.trimStart().length;
    out.push({ indent, content: withoutComment.trim() });
  }
  return out;
}

/** Remove a trailing `# comment`, but not inside quotes. */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === '#' && !inSingle && !inDouble) {
      // Only treat as a comment when preceded by whitespace or at line start.
      if (i === 0 || /\s/.test(line[i - 1] ?? '')) return line.slice(0, i);
    }
  }
  return line;
}

/**
 * Parse a forgiving subset of YAML frontmatter into a plain object.
 *
 * Supported:
 * - `key: scalar` (string/number/bool/null)
 * - `key: [a, b]` flow lists
 * - block lists (`- item` lines under a key)
 * - one level of nested maps (`key:` then indented `subkey: value`)
 */
function parseYaml(yaml: string): Record<string, unknown> {
  const lines = toYamlLines(yaml);
  const result: Record<string, unknown> = {};
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const colon = findKeyColon(line.content);
    if (colon === -1) {
      i++;
      continue;
    }
    const key = unquote(line.content.slice(0, colon));
    const rest = line.content.slice(colon + 1).trim();
    const baseIndent = line.indent;

    if (rest !== '') {
      result[key] = isFlowList(rest) ? parseFlowList(rest) : coerceScalar(rest);
      i++;
      continue;
    }

    // `key:` with nothing after — look at following indented lines.
    const childStart = i + 1;
    if (childStart < lines.length && lines[childStart]!.indent > baseIndent) {
      const childIndent = lines[childStart]!.indent;
      const block: YamlLine[] = [];
      let j = childStart;
      while (j < lines.length && lines[j]!.indent >= childIndent) {
        block.push(lines[j]!);
        j++;
      }
      result[key] =
        block[0]!.content.startsWith('- ') || block[0]!.content === '-'
          ? parseBlockList(block)
          : parseNestedMap(block, childIndent);
      i = j;
    } else {
      result[key] = null;
      i++;
    }
  }

  return result;
}

/** Find the colon that separates a YAML key from its value (skips quotes). */
function findKeyColon(content: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === ':' && !inSingle && !inDouble) {
      const next = content[i + 1];
      if (next === undefined || next === ' ' || next === '\t') return i;
    }
  }
  return -1;
}

/** Parse a block list (`- item` lines) of scalars. */
function parseBlockList(block: YamlLine[]): unknown[] {
  const out: unknown[] = [];
  for (const line of block) {
    if (line.content === '-' || line.content.startsWith('- ')) {
      out.push(coerceScalar(line.content.replace(/^-\s*/, '')));
    }
  }
  return out;
}

/** Parse a nested map (one level) of `key: value` / `key: [list]` lines. */
function parseNestedMap(block: YamlLine[], indent: number): Record<string, unknown> {
  const map: Record<string, unknown> = {};
  let i = 0;
  while (i < block.length) {
    const line = block[i]!;
    if (line.indent !== indent) {
      i++;
      continue;
    }
    const colon = findKeyColon(line.content);
    if (colon === -1) {
      i++;
      continue;
    }
    const key = unquote(line.content.slice(0, colon));
    const rest = line.content.slice(colon + 1).trim();
    if (rest !== '') {
      map[key] = isFlowList(rest) ? parseFlowList(rest) : coerceScalar(rest);
      i++;
      continue;
    }
    // Nested block list under this sub-key.
    const childStart = i + 1;
    const child: YamlLine[] = [];
    let j = childStart;
    while (j < block.length && block[j]!.indent > indent) {
      child.push(block[j]!);
      j++;
    }
    map[key] = child.length > 0 ? parseBlockList(child) : null;
    i = j;
  }
  return map;
}

/**
 * Split a raw note into its frontmatter object and the body that follows it.
 * Returns `{ frontmatter, body, frontmatterRaw }`.
 */
export function splitFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  frontmatterRaw: string;
  body: string;
} {
  const match = FRONTMATTER_RE.exec(content);
  if (!match) {
    return { frontmatter: {}, frontmatterRaw: '', body: content };
  }
  const frontmatterRaw = match[1] ?? '';
  const body = content.slice(match[0].length);
  return { frontmatter: parseYaml(frontmatterRaw), frontmatterRaw, body };
}

/** Derive a note title from filename: basename without extension. */
function titleFromPath(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.[^.]+$/, '');
}

/** Parse one wikilink target string into target/alias/heading parts. */
function parseWikilinkTarget(raw: string): ParsedLink {
  let rest = raw.trim();
  let alias: string | undefined;
  let heading: string | undefined;

  const pipe = rest.indexOf('|');
  if (pipe !== -1) {
    alias = rest.slice(pipe + 1).trim() || undefined;
    rest = rest.slice(0, pipe).trim();
  }

  const hash = rest.indexOf('#');
  if (hash !== -1) {
    heading = rest.slice(hash + 1).trim() || undefined;
    rest = rest.slice(0, hash).trim();
  }

  const link: ParsedLink = { target: rest, type: 'wikilink' };
  if (alias !== undefined) link.alias = alias;
  if (heading !== undefined) link.heading = heading;
  return link;
}

/** True when a markdown link href points outside the vault (http(s), mailto…). */
function isExternalHref(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//');
}

/** Parse a standard `[text](href)` link into a {@link ParsedLink}. */
function parseMarkdownLink(text: string, href: string): ParsedLink | null {
  if (isExternalHref(href)) return null;

  let target = href;
  let heading: string | undefined;
  const hash = target.indexOf('#');
  if (hash !== -1) {
    heading = decodeURIComponent(target.slice(hash + 1)) || undefined;
    target = target.slice(0, hash);
  }
  // Pure in-page anchor (`#heading` with no path) is not a note link.
  if (target === '') return null;

  target = decodeURIComponent(target);
  const link: ParsedLink = { target, type: 'markdown' };
  const alias = text.trim();
  if (alias !== '') link.alias = alias;
  if (heading !== undefined) link.heading = heading;
  return link;
}

/** Extract typed-relation links from frontmatter (e.g. `relations: { references: [...] }`). */
function relationLinks(frontmatter: Record<string, unknown>): ParsedLink[] {
  const relations = frontmatter['relations'];
  if (relations === null || typeof relations !== 'object' || Array.isArray(relations)) {
    return [];
  }
  const out: ParsedLink[] = [];
  for (const [relType, value] of Object.entries(relations as Record<string, unknown>)) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      if (typeof item !== 'string') continue;
      const trimmed = item.trim();
      if (trimmed === '') continue;
      // Allow bare targets or `[[wikilink]]` syntax inside relation lists.
      const wiki = /^\[\[([^\]]+)\]\]$/.exec(trimmed);
      if (wiki) {
        const parsed = parseWikilinkTarget(wiki[1]!);
        out.push({ ...parsed, type: relType });
      } else {
        out.push({ target: trimmed, type: relType });
      }
    }
  }
  return out;
}

/** Extract inline `#tags` from already code-masked body text. */
function extractInlineTags(maskedBody: string): string[] {
  const tags: string[] = [];
  for (const m of maskedBody.matchAll(TAG_RE)) {
    tags.push(m[2]!);
  }
  return tags;
}

/** Normalise frontmatter `tags` (string CSV / list) into a string array. */
function frontmatterTags(frontmatter: Record<string, unknown>): string[] {
  const raw = frontmatter['tags'];
  if (raw === undefined || raw === null) return [];
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(/[,\s]+/) : [];
  return values
    .filter((v): v is string => typeof v === 'string')
    .map((v) => v.replace(/^#/, '').trim())
    .filter((v) => v !== '');
}

/**
 * Parse a single note's raw markdown.
 *
 * @param path    Vault-relative POSIX path of the note.
 * @param content Raw markdown content.
 */
export function parseNote(path: FilePath, content: string): ParsedNote {
  const { frontmatter, body } = splitFrontmatter(content);
  const maskedBody = maskCode(body);

  // Title: frontmatter `title` → first H1 → filename.
  let title: string;
  const fmTitle = frontmatter['title'];
  if (typeof fmTitle === 'string' && fmTitle.trim() !== '') {
    title = fmTitle.trim();
  } else {
    const h1 = H1_RE.exec(maskedBody);
    title = h1
      ? body
          .slice(h1.index, h1.index + h1[0].length)
          .replace(H1_RE, '$1')
          .trim()
      : titleFromPath(path);
  }

  // Links, in document order: wikilinks + markdown links interleaved by offset.
  const ordered: Array<{ offset: number; link: ParsedLink }> = [];
  for (const m of maskedBody.matchAll(WIKILINK_RE)) {
    ordered.push({ offset: m.index, link: parseWikilinkTarget(m[1]!) });
  }
  for (const m of maskedBody.matchAll(MARKDOWN_LINK_RE)) {
    if (m[1] === '!') continue; // image embed, not a note link
    const link = parseMarkdownLink(m[2]!, m[3]!);
    if (link) ordered.push({ offset: m.index, link });
  }
  ordered.sort((a, b) => a.offset - b.offset);
  const links = ordered.map((o) => o.link);
  links.push(...relationLinks(frontmatter));

  // Tags: inline + frontmatter, de-duplicated, order-stable.
  const tags = [...new Set([...extractInlineTags(maskedBody), ...frontmatterTags(frontmatter)])];

  return { path, title, frontmatter, tags, links };
}
