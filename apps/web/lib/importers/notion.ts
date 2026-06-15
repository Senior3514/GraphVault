/**
 * Notion export importer (M20).
 *
 * Notion's "Export as Markdown & CSV" produces a ZIP where:
 *   - Each page becomes a `.md` file.
 *   - Filenames have a UUID suffix:  `My Page abc123def456.md`
 *   - Inline page links have the same UUID suffix:
 *       `[Page Title](My%20Page%20abc123def456.md)`
 *   - CSV exports are skipped (we only import Markdown pages).
 *   - Sub-pages live in matching directories:
 *       `Parent Page abc123def.md`
 *       `Parent Page abc123def/Child Page 9876abcd.md`
 *
 * What we normalise:
 *   1. Strip the UUID suffix from filenames: `My Page abc123.md` → `My Page.md`
 *   2. Strip the UUID suffix from all Markdown links that reference local files.
 *   3. Skip `.csv` files (database views) — they are not notes.
 *   4. Skip image/attachment entries (non-.md, non-.markdown, non-.txt are
 *      already filtered by `safeImportPath`).
 *
 * UUID pattern (Notion): 32 hex characters, optionally grouped, at the end of
 * the base name before the extension:  ` [0-9a-f]{32}` or the common
 * hyphenated form `[0-9a-f-]{32,36}` (with/without hyphens).
 * We use a conservative pattern: ` [0-9a-f]{8}(?:[0-9a-f]{4}){3}[0-9a-f]{12}`
 * (pure 32-char hex, no hyphens, preceded by a space — the exact Notion format).
 */

import { readVaultZip, safeImportPath, type ImportEntry } from '../vault/portability';
import { ImporterError, type Importer } from './types';

// ---------------------------------------------------------------------------
// UUID stripping
// ---------------------------------------------------------------------------

/**
 * The UUID pattern Notion appends to page filenames (space + 32 hex chars).
 * Example: `"My Note abc1234567890abcdef1234567890ab"`
 */
const NOTION_UUID_RE = / [0-9a-f]{32}$/i;

/**
 * Strip a Notion UUID suffix from the base name (without extension).
 * Returns the base name unchanged if no suffix is found.
 *
 * Example: `"Meeting Notes abc1234567890abcdef1234567890ab"` → `"Meeting Notes"`
 */
export function stripNotionUuid(baseName: string): string {
  return baseName.replace(NOTION_UUID_RE, '').trim();
}

/**
 * Derive a clean vault-relative path from a raw Notion archive path.
 * Returns null if the path should be skipped (CSV, unsafe, non-text).
 *
 * Steps:
 *   1. Reject CSV files early (before safeImportPath, which would also reject them).
 *   2. Strip UUID from each path segment's base name.
 *   3. Delegate final safety check to safeImportPath.
 */
export function notionPathToVaultPath(raw: string): string | null {
  // Reject CSV files (Notion database exports) — they have no note content.
  if (/\.csv$/i.test(raw)) return null;

  // Split into segments and strip UUIDs.
  const segments = raw.replace(/\\/g, '/').split('/');
  const cleaned = segments.map((seg) => {
    // Is this the last segment (filename)?
    const dotIdx = seg.lastIndexOf('.');
    if (dotIdx > 0) {
      const base = seg.slice(0, dotIdx);
      const ext = seg.slice(dotIdx);
      return stripNotionUuid(base) + ext;
    }
    // Directory segment: just strip UUID.
    return stripNotionUuid(seg);
  });

  const cleanedPath = cleaned.filter(Boolean).join('/');
  return safeImportPath(cleanedPath);
}

// ---------------------------------------------------------------------------
// Link rewriting
// ---------------------------------------------------------------------------

/**
 * Rewrite Notion's local Markdown links to remove UUID suffixes.
 *
 * Handles:
 *   - `[text](Some%20Page%20abc123...def.md)` → `[text](Some%20Page.md)`
 *   - `[text](path/to/Sub%20Page%20abc123...def.md)` → `[text](path/to/Sub%20Page.md)`
 *
 * We decode the href to work on raw filenames, strip the UUID, then re-encode
 * the base name. Only local (relative, no scheme) links are rewritten.
 */
export function rewriteNotionLinks(content: string): string {
  return content.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (match, text: string, href: string) => {
    // Skip external URLs and anchors.
    if (/^https?:\/\//i.test(href) || href.startsWith('#') || href.startsWith('mailto:')) {
      return match;
    }

    try {
      const decoded = decodeURIComponent(href);
      // Work on path segments.
      const segments = decoded.split('/');
      const rewritten = segments.map((seg) => {
        const dotIdx = seg.lastIndexOf('.');
        if (dotIdx > 0) {
          const base = seg.slice(0, dotIdx);
          const ext = seg.slice(dotIdx);
          return encodeURIComponent(stripNotionUuid(base)) + ext;
        }
        return encodeURIComponent(stripNotionUuid(seg));
      });
      const newHref = rewritten.join('/');
      return `[${text}](${newHref})`;
    } catch {
      // decodeURIComponent threw — leave as-is.
      return match;
    }
  });
}

// ---------------------------------------------------------------------------
// Public importer
// ---------------------------------------------------------------------------

async function convertNotionZip(bytes: Uint8Array): Promise<ImportEntry[]> {
  const raw = await readVaultZip(bytes);
  const entries: ImportEntry[] = [];
  for (const entry of raw) {
    // Re-derive a clean path (UUID stripped). `readVaultZip` already applied
    // `safeImportPath` to the raw path, but that path still has the UUID in it.
    // We need to re-process the original path to strip the UUID.
    // `entry.path` is already safe but UUID-bearing. Strip UUID from it.
    const segments = entry.path.split('/');
    const cleanSegments = segments.map((seg) => {
      const dotIdx = seg.lastIndexOf('.');
      if (dotIdx > 0) {
        const base = seg.slice(0, dotIdx);
        const ext = seg.slice(dotIdx);
        return stripNotionUuid(base) + ext;
      }
      return stripNotionUuid(seg);
    });
    const cleanPath = safeImportPath(cleanSegments.filter(Boolean).join('/'));
    if (!cleanPath) continue;

    const cleanContent = rewriteNotionLinks(entry.content);
    entries.push({
      path: cleanPath,
      content: cleanContent,
      ctime: entry.ctime,
      mtime: entry.mtime,
    });
  }
  return entries;
}

export const notionImporter: Importer = {
  id: 'notion',
  name: 'Notion',
  description:
    'Import a Notion "Export as Markdown & CSV" ZIP. UUID suffixes are stripped from ' +
    'filenames and links; CSV database exports are skipped. Pages become notes.',
  acceptedExtensions: ['.zip'],

  async convert(bytes: Uint8Array, filename: string): Promise<ImportEntry[]> {
    if (!filename.toLowerCase().endsWith('.zip')) {
      throw new ImporterError(`Notion importer: expected a .zip file, got "${filename}".`);
    }
    return convertNotionZip(bytes);
  },
};
