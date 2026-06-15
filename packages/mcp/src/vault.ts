/**
 * Filesystem I/O: walk a vault directory and return NoteInput values.
 *
 * Mirrors packages/cli/src/vault.ts exactly — zero third-party deps.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { NoteInput } from '@graphvault/engine';

/** Walk `dir` recursively, collecting all `.md` / `.markdown` files. */
function walkMarkdown(dir: string, results: string[] = []): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdown(full, results);
    } else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

/**
 * Read all Markdown files under `vaultDir` and return them as NoteInput
 * values. Paths are vault-relative POSIX strings (forward slashes).
 *
 * Throws if `vaultDir` does not exist or is not a directory.
 */
export function readVault(vaultDir: string): NoteInput[] {
  const stat = statSync(vaultDir); // throws ENOENT if missing
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${vaultDir}`);
  }

  const files = walkMarkdown(vaultDir);
  return files.map((absPath) => {
    // Vault-relative path with POSIX separators.
    const rel = relative(vaultDir, absPath);
    const path = sep === '\\' ? rel.replace(/\\/g, '/') : rel;

    const content = readFileSync(absPath, 'utf8');
    const { mtimeMs, birthtimeMs } = statSync(absPath);

    const note: NoteInput = {
      path: path as NoteInput['path'],
      content,
      updatedAt: Math.round(mtimeMs),
    };
    if (birthtimeMs > 0) note.createdAt = Math.round(birthtimeMs);
    return note;
  });
}
