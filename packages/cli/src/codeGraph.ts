/**
 * Filesystem I/O for the `codegraph` command: walk a directory and return
 * CodeFileInput values for @graphvault/engine's buildCodeGraph.
 *
 * Uses only Node.js built-ins (node:fs, node:path), same as vault.ts.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { CodeFileInput } from '@graphvault/engine';

/** Source file extensions the import-graph builder knows how to scan. */
export const DEFAULT_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Directory names never descended into, regardless of depth - build output,
 * dependency trees, and VCS metadata. None of these represent hand-written
 * source structure, and node_modules alone can be orders of magnitude larger
 * than the rest of a repo.
 */
export const DEFAULT_IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  '.next',
  'target',
  'coverage',
  '.turbo',
  '.cache',
]);

export interface WalkSourceFilesOptions {
  extensions?: readonly string[];
  ignoreDirs?: ReadonlySet<string>;
}

/** Walk `dir` recursively, collecting source files matching `extensions`. */
function walkSource(
  dir: string,
  extensions: readonly string[],
  ignoreDirs: ReadonlySet<string>,
  results: string[] = [],
): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoreDirs.has(entry.name)) continue;
      walkSource(join(dir, entry.name), extensions, ignoreDirs, results);
    } else if (entry.isFile() && extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(join(dir, entry.name));
    }
  }
  return results;
}

/**
 * Read all source files under `rootDir` (respecting `options.extensions` /
 * `options.ignoreDirs`) and return them as {@link CodeFileInput} values with
 * repo-relative POSIX paths.
 *
 * Throws if `rootDir` does not exist or is not a directory.
 */
export function walkSourceFiles(
  rootDir: string,
  options: WalkSourceFilesOptions = {},
): CodeFileInput[] {
  const stat = statSync(rootDir); // throws ENOENT if missing
  if (!stat.isDirectory()) {
    throw new Error(`Not a directory: ${rootDir}`);
  }

  const extensions = options.extensions ?? DEFAULT_SOURCE_EXTENSIONS;
  const ignoreDirs = options.ignoreDirs ?? DEFAULT_IGNORE_DIRS;
  const files = walkSource(rootDir, extensions, ignoreDirs);

  return files.map((absPath) => {
    const rel = relative(rootDir, absPath);
    const path = sep === '\\' ? rel.replace(/\\/g, '/') : rel;
    const content = readFileSync(absPath, 'utf8');
    return { path, content };
  });
}
