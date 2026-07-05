/**
 * Note hierarchy - a third, independent graph model alongside the note-link
 * graph ({@link "./graph.js"}) and the code import graph
 * ({@link "./codeGraph.js"}). Where the other two model "note ↔ note via
 * wikilinks" and "file → file via imports", this one models CherryTree-style
 * explicit parent/child nesting: any note can declare a `parent` in its
 * frontmatter, independent of which folder it physically lives in on disk.
 *
 *   ---
 *   title: Deploying to a VPS
 *   parent: Sync & Backups
 *   ---
 *
 * This is deliberately NOT the folder tree (already covered by the sidebar's
 * file/folder view) - it lets a user build a CherryTree-style outline of
 * notes-under-notes that has nothing to do with where the files sit on disk,
 * while GraphVault's wikilink graph keeps working exactly as before. Both
 * organizational modes coexist; a note can have a folder, tags, wikilinks,
 * AND a hierarchy parent, all independently.
 *
 * Pure and framework-free, same invariant as the rest of this package:
 * callers supply plain data ({@link NoteHierarchyInput}, satisfied by
 * {@link ParsedNote} - e.g. via {@link parseNote} - or any equivalent shape a
 * host app already has); nothing here touches `node:fs`.
 */

/**
 * The minimal shape {@link buildNoteHierarchy} needs - deliberately narrower
 * than the full {@link ParsedNote}, so a caller with its own lighter parsed-
 * note representation (e.g. the web client's client-side parser) can build
 * this input without depending on this package's full parse pipeline.
 */
export interface NoteHierarchyInput {
  path: string;
  title: string;
  frontmatter: Record<string, unknown>;
}

/** One note in the hierarchy tree. */
export interface HierarchyNode {
  path: string;
  title: string;
  /**
   * True when this note declared a `parent` that could not be resolved to
   * any known note, or that would have formed a cycle - in both cases the
   * note is placed at the root instead of being silently dropped, and this
   * flag lets the UI surface a "parent not found" hint rather than pretend
   * the declaration didn't exist.
   */
  parentUnresolved: boolean;
  children: HierarchyNode[];
}

/** NFC-normalize + strip a trailing `.md`/`.markdown` extension, lowercased. */
function pathKey(path: string): string {
  return path
    .normalize('NFC')
    .replace(/\.(md|markdown)$/i, '')
    .toLowerCase();
}

/**
 * Resolve a raw `parent` frontmatter value to a known note's path.
 * Tries, in order: exact path match (with/without extension), then a
 * case-insensitive title match. Returns `null` if nothing matches.
 */
function resolveParent(
  raw: string,
  byPathKey: ReadonlyMap<string, string>,
  byTitleKey: ReadonlyMap<string, string>,
): string | null {
  const trimmed = raw.trim();
  if (trimmed === '') return null;
  return byPathKey.get(pathKey(trimmed)) ?? byTitleKey.get(pathKey(trimmed)) ?? null;
}

/** Extract the raw `parent` frontmatter value as a string, or `null`. */
function rawParentOf(note: NoteHierarchyInput): string | null {
  const value = note.frontmatter['parent'];
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

/**
 * Build a {@link HierarchyNode} forest from a set of parsed notes, using each
 * note's `parent` frontmatter field. Notes with no `parent`, an unresolvable
 * `parent`, or whose `parent` chain would form a cycle are placed as roots -
 * never dropped, matching this project's never-lose-data invariant.
 */
export function buildNoteHierarchy(notes: readonly NoteHierarchyInput[]): HierarchyNode[] {
  const byPath = new Map<string, NoteHierarchyInput>();
  const byPathKey = new Map<string, string>();
  const byTitleKey = new Map<string, string>();

  for (const note of notes) {
    byPath.set(note.path, note);
    byPathKey.set(pathKey(note.path), note.path);
    // First note with a given title wins ties, same as the link-resolution
    // convention in index-build.ts - deterministic, not "most recent wins".
    const tKey = pathKey(note.title);
    if (!byTitleKey.has(tKey)) byTitleKey.set(tKey, note.path);
  }

  // Resolve every note's parent path up front (or null), before building the
  // tree, so cycle detection can walk pure path references.
  const parentOf = new Map<string, string | null>();
  const parentWasDeclaredButUnresolved = new Set<string>();
  for (const note of notes) {
    const raw = rawParentOf(note);
    if (raw === null) {
      parentOf.set(note.path, null);
      continue;
    }
    const resolved = resolveParent(raw, byPathKey, byTitleKey);
    if (resolved === null || resolved === note.path) {
      // Unresolvable, or a note declaring itself as its own parent - both
      // treated as "no parent" (root), flagged for the UI.
      parentOf.set(note.path, null);
      parentWasDeclaredButUnresolved.add(note.path);
    } else {
      parentOf.set(note.path, resolved);
    }
  }

  // Detect and break cycles: walk each note's ancestor chain; if it revisits
  // a node already seen on that same walk, this note is part of a cycle -
  // place it at the root instead of infinite-looping or dropping it. Every
  // note participating in a cycle becomes its own root this way (not just
  // one edge cut to reconnect the rest of the cycle as a chain) - simpler
  // and still fully safe (nothing is ever dropped or crashes), at the cost
  // of not preserving the non-cyclic part of a broken cycle's structure.
  // Cycles are a user-authoring mistake, not a normal case, so this v1
  // trade-off favors simplicity over minimal disruption.
  const brokenCycleRoots = new Set<string>();
  for (const note of notes) {
    const seen = new Set<string>();
    let current: string | null = note.path;
    while (current !== null) {
      if (seen.has(current)) {
        brokenCycleRoots.add(note.path);
        break;
      }
      seen.add(current);
      current = parentOf.get(current) ?? null;
    }
  }
  for (const path of brokenCycleRoots) {
    parentOf.set(path, null);
    parentWasDeclaredButUnresolved.add(path);
  }

  const nodeOf = new Map<string, HierarchyNode>();
  for (const note of notes) {
    nodeOf.set(note.path, {
      path: note.path,
      title: note.title,
      parentUnresolved: parentWasDeclaredButUnresolved.has(note.path),
      children: [],
    });
  }

  const roots: HierarchyNode[] = [];
  for (const note of notes) {
    const node = nodeOf.get(note.path)!;
    const parentPath = parentOf.get(note.path) ?? null;
    if (parentPath === null) {
      roots.push(node);
    } else {
      const parentNode = nodeOf.get(parentPath);
      // Should always exist (parentOf only holds resolved paths at this
      // point), but fall back to root rather than throw if it somehow doesn't.
      if (parentNode) parentNode.children.push(node);
      else roots.push(node);
    }
  }

  return roots;
}
