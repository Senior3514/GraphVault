/**
 * Pure parsing helpers for note content: YAML frontmatter, inline `#tags`,
 * `[[wikilinks]]`, and title derivation.
 *
 * These are intentionally dependency-free and side-effect-free so they are
 * trivial to unit-test and reuse from a real filesystem backend later. The
 * YAML parser handles the small subset GraphVault writes (scalars and simple
 * lists); it is not a general YAML implementation.
 */

import type { ParsedNote, WikiLink } from './types';

const FRONTMATTER_RE = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/** Matches `[[target]]` or `[[target|alias]]`. Target excludes `[`, `]`, `|`. */
const WIKILINK_RE = /\[\[([^\][|]+?)(?:\|([^\][]+?))?\]\]/g;

/**
 * Inline tags: `#word`, allowing `-`, `_`, `/` and unicode letters. Must be at
 * the start of a line or preceded by whitespace so we don't match `#` inside
 * URLs/anchors or `c#`-style fragments mid-word.
 */
const INLINE_TAG_RE = /(?:^|\s)#([\p{L}\p{N}][\p{L}\p{N}_/-]*)/gu;

/** Strip surrounding quotes from a scalar YAML value. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Parse the small YAML subset GraphVault emits: top-level `key: value` scalars
 * and lists written either inline (`tags: [a, b]`) or as a block of `- item`
 * lines. Unknown/complex YAML is preserved as a best-effort string.
 */
export function parseFrontmatterBlock(raw: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  const lines = raw.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      i += 1;
      continue;
    }
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) {
      i += 1;
      continue;
    }
    const key = m[1];
    const rest = m[2];
    if (rest === '') {
      // Possibly a block list on following indented `- item` lines.
      const items: string[] = [];
      let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) {
        items.push(unquote(lines[j].replace(/^\s*-\s+/, '')));
        j += 1;
      }
      out[key] = items;
      i = j;
      continue;
    }
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      out[key] = inner === '' ? [] : inner.split(',').map((s) => unquote(s));
      i += 1;
      continue;
    }
    out[key] = unquote(rest);
    i += 1;
  }
  return out;
}

/** Split content into `{ frontmatter, body }`, stripping the `---` fences. */
export function splitFrontmatter(content: string): {
  frontmatter: Record<string, string | string[]>;
  body: string;
} {
  const m = FRONTMATTER_RE.exec(content);
  if (!m) {
    return { frontmatter: {}, body: content };
  }
  return {
    frontmatter: parseFrontmatterBlock(m[1]),
    body: content.slice(m[0].length),
  };
}

/**
 * Quote a scalar YAML value if writing it bare would round-trip incorrectly
 * through {@link parseFrontmatterBlock} - which splits a line on the FIRST
 * `:` and treats a leading `[`/`- ` specially, so a value containing any of
 * those (or leading/trailing whitespace, which would silently vanish) must be
 * quoted to survive being read back.
 *
 * {@link unquote} - the reader half of this pair - only strips a matching
 * outer quote CHARACTER; it does not un-escape anything inside the quotes.
 * So backslash-escaping an internal `"` (the obvious-looking fix) would NOT
 * round-trip: the literal backslash would survive into the read-back value.
 * Caught by testing an actual round-trip, not just that quoting happens.
 * Instead: wrap in whichever quote character (`"` or `'`) does not appear in
 * the value, so nothing inside ever needs escaping at all. If the value
 * contains BOTH quote characters, there is no quote-free wrapping available
 * in this deliberately-small, non-general-YAML subset; falls back to double
 * quotes as a best effort (an already rare case, containing both quote
 * characters at once, is rarer still).
 *
 * A raw embedded newline is flattened to a space defensively: this writer is
 * line-based, and nothing downstream un-escapes a newline either, so an
 * embedded one would otherwise corrupt the frontmatter block's line
 * structure. No current caller can produce one (the parent-picker UI is a
 * single-line `<input>`), so this only guards against future misuse.
 */
function quoteIfNeeded(value: string): string {
  const flattened = value.replace(/\r?\n/g, ' ');
  const needsQuoting =
    flattened === '' || /[:#[\]]/.test(flattened) || flattened.trim() !== flattened;
  if (!needsQuoting) return flattened;
  if (!flattened.includes('"')) return `"${flattened}"`;
  if (!flattened.includes("'")) return `'${flattened}'`;
  return `"${flattened}"`;
}

/**
 * Set (or remove, when `value` is `null`) a single top-level scalar
 * frontmatter field in raw note content, preserving every other line
 * (frontmatter and body) exactly as written. Adds a frontmatter block if the
 * note doesn't have one yet and `value` is non-null; a no-op if the note has
 * no frontmatter and `value` is `null` (nothing to remove).
 *
 * Deliberately line-based, matching {@link parseFrontmatterBlock}'s own
 * reading rules, rather than a full YAML AST round-trip - this project's
 * frontmatter support is a documented small subset, not general YAML.
 */
export function setFrontmatterField(content: string, key: string, value: string | null): string {
  const keyLineRe = new RegExp(`^${key}:\\s*.*$`);
  const m = FRONTMATTER_RE.exec(content);

  if (!m) {
    if (value === null) return content; // nothing to remove
    return `---\n${key}: ${quoteIfNeeded(value)}\n---\n\n${content}`;
  }

  const rawBlock = m[1];
  const body = content.slice(m[0].length);
  const lines = rawBlock.split(/\r?\n/);
  const existingIndex = lines.findIndex((line) => keyLineRe.test(line));

  if (value === null) {
    if (existingIndex !== -1) lines.splice(existingIndex, 1);
  } else {
    const newLine = `${key}: ${quoteIfNeeded(value)}`;
    if (existingIndex !== -1) lines[existingIndex] = newLine;
    else lines.push(newLine);
  }

  return `---\n${lines.join('\n')}\n---\n${body}`;
}

/** Extract inline `#tags` from a markdown body, normalized to lower case. */
export function extractInlineTags(body: string): string[] {
  const tags = new Set<string>();
  for (const m of body.matchAll(INLINE_TAG_RE)) {
    tags.add(m[1].toLowerCase());
  }
  return [...tags];
}

/** Extract unique `[[wikilink]]` occurrences from a markdown body. */
export function extractWikiLinks(body: string): WikiLink[] {
  const seen = new Set<string>();
  const links: WikiLink[] = [];
  for (const m of body.matchAll(WIKILINK_RE)) {
    const target = m[1].trim();
    if (target === '') continue;
    const alias = m[2]?.trim();
    const dedupeKey = `${target} ${alias ?? ''}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    links.push(alias ? { target, alias } : { target });
  }
  return links;
}

/** Combine frontmatter `tags` and inline tags into one de-duplicated list. */
function collectTags(frontmatter: Record<string, string | string[]>, body: string): string[] {
  const tags = new Set<string>();
  const fmTags = frontmatter.tags;
  if (Array.isArray(fmTags)) {
    for (const t of fmTags) tags.add(String(t).replace(/^#/, '').toLowerCase());
  } else if (typeof fmTags === 'string' && fmTags.trim() !== '') {
    for (const t of fmTags.split(/[,\s]+/)) {
      if (t) tags.add(t.replace(/^#/, '').toLowerCase());
    }
  }
  for (const t of extractInlineTags(body)) tags.add(t);
  return [...tags];
}

/** Derive a display title from frontmatter, first H1, or the file name. */
export function deriveTitle(
  path: string,
  frontmatter: Record<string, string | string[]>,
  body: string,
): string {
  const fmTitle = frontmatter.title;
  if (typeof fmTitle === 'string' && fmTitle.trim() !== '') {
    return fmTitle.trim();
  }
  const h1 = /^#\s+(.+)$/m.exec(body);
  if (h1) return h1[1].trim();
  return basename(path).replace(/\.md$/i, '');
}

/** Full parse of a note's raw content into derived metadata. */
export function parseNote(path: string, content: string): ParsedNote {
  const { frontmatter, body } = splitFrontmatter(content);
  return {
    title: deriveTitle(path, frontmatter, body),
    frontmatter,
    body,
    tags: collectTags(frontmatter, body),
    links: extractWikiLinks(body),
  };
}

/** Last path segment, e.g. `notes/a.md` -> `a.md`. */
export function basename(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Parent directory of a path, or `''` for a root-level file. */
export function dirname(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? '' : path.slice(0, idx);
}
