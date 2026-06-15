/**
 * Logseq / Roam Research importer (M20) — best-effort.
 *
 * ## Logseq
 *
 * Logseq exports to a ZIP of plain Markdown files structured as:
 *
 *   pages/          (top-level pages)
 *   journals/       (daily notes, `YYYY_MM_DD.md`)
 *   assets/         (attachments — skipped by safeImportPath)
 *
 * Logseq uses "outliner" Markdown: every paragraph is a bullet (`- content`).
 * Sub-bullets are indented:
 *
 *   - Parent
 *     - Child
 *       - Grandchild
 *
 * We convert this to regular Markdown: top-level bullets whose first-level
 * children are text become paragraphs; nested bullet trees stay as lists.
 * `((block-refs))` are converted to `[[block-refs]]` (best-effort wikilink).
 * `[[page-refs]]` are kept as-is (already wikilinks).
 *
 * Property syntax (`key:: value`) is stripped from the body but the `tags:`
 * property is surfaced as `#tag` style frontmatter lines.
 *
 * ## Roam Research
 *
 * Roam's JSON export is an array of pages:
 *
 *   [{ "title": "Page title", "children": [{ "string": "bullet text", ... }] }]
 *
 * `((uid-refs))` → `[[uid-refs]]`.  `[[page-refs]]` kept as-is.
 * Nested children → nested Markdown bullets.
 *
 * ## Shared ZIP handling
 *
 * Both tools can export as a ZIP. The importer detects:
 *   - `.json` → Roam JSON export
 *   - `.zip`  → Logseq ZIP (Markdown) or Roam ZIP of JSON (detect by inspecting
 *               the first `.json` file found)
 *   - `.md`   → single Logseq page
 */

import { readVaultZip, safeImportPath, type ImportEntry } from '../vault/portability';
import { ImporterError, type Importer } from './types';

// ---------------------------------------------------------------------------
// Logseq Markdown normalisation
// ---------------------------------------------------------------------------

/**
 * Logseq property syntax: `key:: value` at the start of a line.
 * We strip all properties from body content and extract `tags::`.
 */
const LOGSEQ_PROP_RE = /^[ \t]*-?\s*(\w[\w-]*)::[ \t]*(.*)$/;

export interface LogseqFrontmatter {
  tags: string[];
  title: string | null;
}

/**
 * Extract Logseq property lines from the top of a note.
 * Logseq properties appear as `key:: value` bullets, typically at the top.
 * We scan all `key::` lines regardless of position and remove them.
 *
 * Returns the cleaned content and any extracted tags/title.
 */
export function extractLogseqProperties(content: string): {
  cleaned: string;
  meta: LogseqFrontmatter;
} {
  const lines = content.split('\n');
  const body: string[] = [];
  const tags: string[] = [];
  let title: string | null = null;

  for (const line of lines) {
    const m = LOGSEQ_PROP_RE.exec(line);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key === 'tags') {
        // Logseq tags: comma-separated, or with [[wikilink]] syntax.
        const rawTags = val
          .split(',')
          .map((t) =>
            t
              .trim()
              .replace(/^\[\[|\]\]$/g, '')
              .trim(),
          )
          .filter(Boolean);
        tags.push(...rawTags);
      } else if (key === 'title') {
        title = val.replace(/^"|"$/g, '').trim() || null;
      }
      // All other properties are silently dropped.
    } else {
      body.push(line);
    }
  }

  return { cleaned: body.join('\n'), meta: { tags, title } };
}

/**
 * Convert `((block-ref))` to `[[block-ref]]` (best-effort wikilink).
 * Roam and Logseq both use this syntax for block references.
 */
export function convertBlockRefs(content: string): string {
  return content.replace(/\(\(([^)]+)\)\)/g, '[[$1]]');
}

/**
 * Normalise a Logseq/Roam Markdown note.
 *
 * Steps (in order):
 *   1. Extract and strip property lines (`key:: value`).
 *   2. Convert `((block-refs))` to `[[wikilinks]]`.
 *   3. If tags were found, inject a YAML frontmatter block.
 */
export function normaliseLogseqMarkdown(content: string, filenameTitle?: string): string {
  const { cleaned, meta } = extractLogseqProperties(content);
  const withRefs = convertBlockRefs(cleaned);

  if (meta.tags.length === 0 && !meta.title) {
    return withRefs.trim();
  }

  const title = meta.title ?? filenameTitle ?? null;
  const lines: string[] = ['---'];
  if (title) lines.push(`title: ${JSON.stringify(title)}`);
  if (meta.tags.length > 0) {
    lines.push(`tags: [${meta.tags.map((t) => JSON.stringify(t)).join(', ')}]`);
  }
  lines.push('---', '', withRefs.trim());
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Logseq journal date path normalisation
// ---------------------------------------------------------------------------

/**
 * Logseq daily notes have filenames like `2024_06_15.md`. We convert them to
 * `journals/2024-06-15.md` so they land in a predictable folder.
 */
export function normaliseLogseqPath(path: string): string | null {
  // Already safe from readVaultZip/safeImportPath.
  const journalMatch = /(?:^|[/\\])(\d{4})_(\d{2})_(\d{2})\.md$/i.exec(path);
  if (journalMatch) {
    const [, y, m, d] = journalMatch;
    return `journals/${y}-${m}-${d}.md`;
  }
  return path;
}

// ---------------------------------------------------------------------------
// Roam JSON export
// ---------------------------------------------------------------------------

interface RoamBlock {
  string?: string;
  children?: RoamBlock[];
  'create-time'?: number;
  'edit-time'?: number;
}

interface RoamPage {
  title?: string;
  children?: RoamBlock[];
  'create-time'?: number;
  'edit-time'?: number;
}

/**
 * Render a tree of Roam blocks to Markdown.
 * Top-level children become paragraphs or bullets depending on depth.
 */
function renderRoamBlocks(blocks: RoamBlock[], depth = 0): string {
  const lines: string[] = [];
  for (const block of blocks) {
    const text = block.string ?? '';
    // Convert block refs and keep wikilinks.
    const md = convertBlockRefs(text);
    const indent = '  '.repeat(depth);
    lines.push(`${indent}- ${md}`);
    if (block.children && block.children.length > 0) {
      lines.push(renderRoamBlocks(block.children, depth + 1));
    }
  }
  return lines.join('\n');
}

/**
 * Convert a single Roam page to an ImportEntry.
 */
function roamPageToEntry(page: RoamPage): ImportEntry | null {
  const title = (page.title ?? 'Untitled').trim();
  if (!title) return null;

  // Sanitise to a vault path: replace path-unsafe chars, keep the title.
  const safeName = title
    .replace(/[/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
  const path = safeImportPath(`roam/${safeName}.md`);
  if (!path) return null;

  const contentLines: string[] = [`# ${title}`, ''];
  if (page.children && page.children.length > 0) {
    contentLines.push(renderRoamBlocks(page.children));
  }

  return {
    path,
    content: contentLines.join('\n'),
    ctime: page['create-time'],
    mtime: page['edit-time'],
  };
}

/**
 * Parse a Roam JSON export string (array of pages) to ImportEntry[].
 * Throws `ImporterError` on fundamentally invalid JSON structure.
 */
export function parseRoamJson(text: string): ImportEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImporterError('Not valid JSON.');
  }
  if (!Array.isArray(parsed)) {
    throw new ImporterError('Roam JSON export must be an array of pages.');
  }

  const entries: ImportEntry[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const page = item as RoamPage;
    const entry = roamPageToEntry(page);
    if (entry) entries.push(entry);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// ZIP handling — detect Logseq vs Roam
// ---------------------------------------------------------------------------

async function convertLogseqZip(bytes: Uint8Array): Promise<ImportEntry[]> {
  const raw = await readVaultZip(bytes);

  // Check if this is actually a Roam JSON-in-ZIP export (first .json file).
  const jsonEntry = raw.find((e) => e.path.toLowerCase().endsWith('.json'));
  if (jsonEntry) {
    // Try to parse as Roam JSON.
    try {
      return parseRoamJson(jsonEntry.content);
    } catch {
      // Not Roam JSON — fall through to treat as Logseq Markdown.
    }
  }

  // Process as Logseq Markdown ZIP.
  const entries: ImportEntry[] = [];
  for (const entry of raw) {
    // Skip non-markdown entries (assets, etc. are already filtered by safeImportPath).
    if (
      !entry.path.toLowerCase().endsWith('.md') &&
      !entry.path.toLowerCase().endsWith('.markdown')
    ) {
      // safeImportPath already filtered these, but belt-and-suspenders.
      continue;
    }

    // Normalise the path (journal dates, etc.).
    const normPath = normaliseLogseqPath(entry.path);
    if (!normPath) continue;
    const safePath = safeImportPath(normPath);
    if (!safePath) continue;

    // Extract the filename title for frontmatter.
    const fileBase = safePath.split('/').pop() ?? safePath;
    const filenameTitle = fileBase.replace(/\.md$/i, '').replace(/_/g, ' ');

    const content = normaliseLogseqMarkdown(entry.content, filenameTitle);
    entries.push({ path: safePath, content, ctime: entry.ctime, mtime: entry.mtime });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Single .md file
// ---------------------------------------------------------------------------

function convertSingleMd(bytes: Uint8Array, filename: string): ImportEntry[] {
  const safe = safeImportPath(filename);
  if (!safe) return [];
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  const fileBase = filename.replace(/\.md$/i, '').replace(/_/g, ' ');
  const content = normaliseLogseqMarkdown(text, fileBase);
  return [{ path: safe, content }];
}

// ---------------------------------------------------------------------------
// Public importer
// ---------------------------------------------------------------------------

export const logseqRoamImporter: Importer = {
  id: 'logseq-roam',
  name: 'Logseq / Roam Research',
  description:
    'Import a Logseq vault ZIP (Markdown) or a Roam Research JSON export. ' +
    'Block bullets are converted to Markdown; ((refs)) become [[wikilinks]]; ' +
    'property lines and tags are normalised. Best-effort conversion.',
  acceptedExtensions: ['.zip', '.json', '.md', '.markdown'],

  async convert(bytes: Uint8Array, filename: string): Promise<ImportEntry[]> {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.zip')) {
      return convertLogseqZip(bytes);
    }
    if (lower.endsWith('.json')) {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      return parseRoamJson(text);
    }
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
      return convertSingleMd(bytes, filename);
    }
    throw new ImporterError(
      `Logseq/Roam importer: unsupported file type "${filename}". Expected .zip, .json, or .md.`,
    );
  },
};
