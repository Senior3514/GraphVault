/**
 * Importer registry (M20 — one-click importers).
 *
 * Import from here to get the full list of importers in display order.
 * The list drives both the Settings UI picker and the file-extension accept
 * attribute for the upload input.
 */

export type { Importer } from './types';
export { ImporterError } from './types';

export { obsidianImporter } from './obsidian';
export { notionImporter } from './notion';
export { logseqRoamImporter } from './logseqRoam';
export { genericImporter } from './generic';

import type { Importer } from './types';
import { obsidianImporter } from './obsidian';
import { notionImporter } from './notion';
import { logseqRoamImporter } from './logseqRoam';
import { genericImporter } from './generic';

/**
 * All importers, in display order. The last entry (`generic`) is always shown
 * as a fallback — it handles GraphVault's own ZIP/JSON formats and raw .md files.
 */
export const ALL_IMPORTERS: readonly Importer[] = [
  obsidianImporter,
  notionImporter,
  logseqRoamImporter,
  genericImporter,
] as const;

/** Find an importer by its stable id. */
export function getImporter(id: string): Importer | undefined {
  return ALL_IMPORTERS.find((imp) => imp.id === id);
}
