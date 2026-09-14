/**
 * Shared types for the app-importer layer (M20 - one-click importers).
 *
 * An Importer converts a third-party export archive or folder into the vault's
 * native `ImportEntry` shape (a path + content pair that `vault.importNotes`
 * can merge safely). All importers run entirely client-side - no network calls,
 * no new dependencies beyond DOMParser / JSON (already available everywhere).
 *
 * The import pipeline is:
 *   1. User selects source app + drops/picks export file(s).
 *   2. The importer converts the archive to `ImportEntry[]`.
 *   3. The UI calls `vault.importNotes(entries)` - collision-safe, never overwrites.
 *   4. A summary (added / copies / unchanged) is shown.
 */

import type { ImportEntry } from '../vault/portability';

/** A registered importer, identified by a stable `id`. */
export interface Importer {
  /** Stable machine-readable ID (snake_case). */
  readonly id: string;
  /** Short human-readable name shown in the source picker. */
  readonly name: string;
  /** One-sentence description of the source app and format. */
  readonly description: string;
  /** File extensions this importer accepts for the file picker. */
  readonly acceptedExtensions: readonly string[];
  /**
   * Convert a user-supplied file to import entries.
   *
   * The raw bytes come from `file.arrayBuffer()` so the importer can handle
   * binary archives (ZIP). Importers must be async because decompression uses
   * `DecompressionStream` (async).
   *
   * Returns an empty array if the file contains no importable notes (not an
   * error - an archive with only non-text files, for example). Throws
   * `ImporterError` on fundamentally malformed input (not-a-zip, corrupt JSON,
   * etc.) so the UI can show a specific message.
   */
  convert(bytes: Uint8Array, filename: string): Promise<ImportEntry[]>;
}

/** Thrown by an importer on unrecoverable bad input. */
export class ImporterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImporterError';
  }
}
