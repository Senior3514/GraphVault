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
