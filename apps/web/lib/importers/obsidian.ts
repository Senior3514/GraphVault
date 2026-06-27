/**
 * Obsidian vault importer (M20).
 *
 * Obsidian exports are either:
 *   a) A ZIP of the vault folder (produced by "Export to ZIP" or third-party
 *      tools) - this path reuses `readVaultZip` from portability.ts.
 *   b) A plain folder of `.md` files (handled via the generic import or
 *      drag-and-drop in the existing Import section).
 *
 * Normalisation performed on every note:
 *   - `![[embed]]`       → `[[embed]]`    (embed → plain wikilink; we keep the
 *                                          target because the file may be in the vault)
 *   - `%%comment%%`      → ''             (Obsidian comments stripped)
 *   - `> [!callout] ...` → `> **callout:** ...`  (callout → blockquote + bold)
 *   - `[[wikilinks]]`    left intact (GraphVault already understands them)
 *   - `#tags`            left intact (already first-class)
 *
 * All transformations are purely textual (regex). No DOMParser needed.
 * Path safety delegates entirely to `safeImportPath` / `readVaultZip`.
 */

import { readVaultZip, safeImportPath, type ImportEntry } from '../vault/portability';
import { ImporterError, type Importer } from './types';

// ---------------------------------------------------------------------------
// Obsidian-specific text normalisation
// ---------------------------------------------------------------------------

/**
 * Strip Obsidian `%%comment%%` blocks (inline and multi-line).
 * Comments must not appear as vault content.
 */
export function stripObsidianComments(content: string): string {
  return content.replace(/%%[\s\S]*?%%/g, '');
}

/**
 * Convert `![[embed]]` and `![[embed|alias]]` to `[[embed]]` / `[[embed|alias]]`.
 * We keep wikilinks because the referenced file may also be in the imported vault.
 */
export function normaliseEmbeds(content: string): string {
  return content.replace(/!\[\[([^\]]+)\]\]/g, '[[$1]]');
}

/**
 * Convert Obsidian callout syntax to a Markdown blockquote with bold label.
 *
 * Obsidian callout:
 *   > [!NOTE] Optional title
 *   > Body line
 *
 * Becomes:
 *   > **Note:** Optional title
 *   > Body line
 *
 * Only the first line of each callout block is transformed; subsequent
 * blockquote lines (continuation) are left as-is.
 */
export function normaliseCallouts(content: string): string {
  return content.replace(
    /^(>+)\s*\[!(\w+)\]([+-]?)([ \t]*)(.*)$/gm,
    (_, arrows: string, type: string, _foldable: string, space: string, rest: string) => {
      const label = type.charAt(0).toUpperCase() + type.slice(1).toLowerCase();
      const title = rest.trim();
      return `${arrows} **${label}:**${title ? ` ${title}` : ''}`;
    },
  );
}

/**
 * Apply all Obsidian-specific normalisations to a note's content in order:
 *   1. Strip comments
 *   2. Normalise embeds
 *   3. Normalise callouts
 */
export function normaliseObsidianContent(content: string): string {
  let out = stripObsidianComments(content);
  out = normaliseEmbeds(out);
  out = normaliseCallouts(out);
  return out;
}

// ---------------------------------------------------------------------------
// Single-file import (plain .md dropped by the user)
// ---------------------------------------------------------------------------

/**
 * Convert a single Obsidian `.md` file (raw bytes) to an import entry.
 * The `filename` is the original filename without directory context.
 */
function convertSingleMd(bytes: Uint8Array, filename: string): ImportEntry[] {
  const safe = safeImportPath(filename);
  if (!safe) return [];
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return [{ path: safe, content: normaliseObsidianContent(text) }];
}

// ---------------------------------------------------------------------------
// ZIP import
// ---------------------------------------------------------------------------

async function convertZip(bytes: Uint8Array): Promise<ImportEntry[]> {
  const raw = await readVaultZip(bytes);
  return raw.map((entry) => ({
    ...entry,
    content: normaliseObsidianContent(entry.content),
  }));
}

// ---------------------------------------------------------------------------
// Public importer
// ---------------------------------------------------------------------------

export const obsidianImporter: Importer = {
  id: 'obsidian',
  name: 'Obsidian',
  description:
    'Import an Obsidian vault ZIP (or individual .md files). ' +
    'Wikilinks and #tags are preserved; embeds, comments, and callouts are normalised.',
  acceptedExtensions: ['.zip', '.md', '.markdown'],

  async convert(bytes: Uint8Array, filename: string): Promise<ImportEntry[]> {
    const lower = filename.toLowerCase();
    if (lower.endsWith('.zip')) {
      return convertZip(bytes);
    }
    if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
      return convertSingleMd(bytes, filename);
    }
    throw new ImporterError(
      `Obsidian importer: unsupported file type "${filename}". Expected .zip or .md.`,
    );
  },
};
