/**
 * Collision-safe "Untitled" name generator.
 *
 * Returns the lowest-indexed name that does not already exist in the set of
 * known note paths:
 *  - `Untitled.md`
 *  - `Untitled 2.md`
 *  - `Untitled 3.md`  …
 *
 * Optionally scoped to a folder prefix (e.g. `notes/` → `notes/Untitled.md`).
 * Pure function — no I/O, no React.
 */

/**
 * Given a set of existing note paths, return the next available untitled name.
 *
 * @param existingPaths - The paths already in the vault (`IndexedNote[].map(n => n.path)`).
 * @param folder        - Optional folder prefix (trailing `/` is normalised). Defaults to root.
 * @returns A vault-relative path like `"Untitled.md"` or `"notes/Untitled 3.md"`.
 */
export function nextUntitledName(existingPaths: readonly string[], folder = ''): string {
  // Normalise the folder prefix: trim whitespace, remove leading slashes,
  // ensure exactly one trailing slash when non-empty.
  const prefix = folder
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/?$/, folder.trim() ? '/' : '');

  const candidate = (n: number) => (n === 1 ? `${prefix}Untitled.md` : `${prefix}Untitled ${n}.md`);

  const existing = new Set(existingPaths);
  let n = 1;
  while (existing.has(candidate(n))) n++;
  return candidate(n);
}
