/**
 * Generic fallback importer (M20).
 *
 * Handles any combination of:
 *   - `.zip`      - standard Markdown ZIP (reuses `readVaultZip` from portability.ts)
 *   - `.json`     - GraphVault JSON export (reuses `parseJsonExport`)
 *   - `.md` / `.markdown` / `.txt` - single plain-text file
 *
 * This is the same logic that the existing "Import & export" section uses, but
 * wrapped as a typed `Importer` so the new "Import from another app" UI can
 * delegate to it for the "Other / GraphVault backup" option.
 *
 * No transformations are applied beyond what `readVaultZip` / `parseJsonExport`
 * already perform (path safety, size caps, de-encoding). The content is imported
 * verbatim.
 */

import {
  parseJsonExport,
  readVaultZip,
  safeImportPath,
  type ImportEntry,
} from '../vault/portability';
import { ImporterError, type Importer } from './types';

export const genericImporter: Importer = {
  id: 'generic',
  name: 'Other / GraphVault backup',
  description:
    'Import a GraphVault .zip or .json backup, or any individual .md / .txt file. ' +
    'Use this for GraphVault-to-GraphVault transfers or for any Markdown file not covered ' +
    'by a dedicated importer.',
  acceptedExtensions: ['.zip', '.json', '.md', '.markdown', '.txt'],

  async convert(bytes: Uint8Array, filename: string): Promise<ImportEntry[]> {
    const lower = filename.toLowerCase();

    if (lower.endsWith('.zip')) {
      return readVaultZip(bytes);
    }

    if (lower.endsWith('.json')) {
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      // parseJsonExport throws on non-GraphVault JSON - surface as ImporterError.
      try {
        return parseJsonExport(text);
      } catch (err) {
        throw new ImporterError(
          err instanceof Error ? err.message : 'Failed to parse JSON export.',
        );
      }
    }

    if (lower.endsWith('.md') || lower.endsWith('.markdown') || lower.endsWith('.txt')) {
      const safe = safeImportPath(filename);
      if (!safe) {
        throw new ImporterError(`Unsafe file path: "${filename}".`);
      }
      const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      const entry: ImportEntry = { path: safe, content: text };
      return [entry];
    }

    throw new ImporterError(
      `Generic importer: unsupported file type "${filename}". ` +
        'Expected .zip, .json, .md, .markdown, or .txt.',
    );
  },
};
