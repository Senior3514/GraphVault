/**
 * MCP Resources: expose each vault note as an attachable resource.
 *
 * A resource has a stable URI of the form:
 *
 *   graphvault://note/<vault-relative-path>
 *
 * where `<vault-relative-path>` is the note's POSIX path with each path segment
 * percent-encoded, so slashes inside the path round-trip cleanly and characters
 * like spaces or `#` cannot break the URI. The `read` callback returns the
 * note's raw markdown as `text/markdown` resource contents.
 *
 * Everything here is a pure read over a {@link VaultSnapshot} (reusing the same
 * TTL-cached {@link VaultManager} the read tools use), so resources reflect
 * recent edits and never mutate the vault. Handlers are split from the transport
 * so they can be unit-tested directly against an in-memory snapshot.
 */

import type { VaultManager, VaultSnapshot } from './vault.js';

/** URI scheme + host prefix for note resources: `graphvault://note/`. */
export const NOTE_URI_PREFIX = 'graphvault://note/';

/** MIME type reported for note contents. */
export const NOTE_MIME_TYPE = 'text/markdown';

/** A single resource entry as returned by the list callback. */
export interface NoteResource {
  uri: string;
  name: string;
  title: string;
  mimeType: string;
}

/** The contents of one resource read: its URI, mime type, and markdown text. */
export interface NoteResourceContents {
  uri: string;
  mimeType: string;
  text: string;
}

/**
 * Build the canonical resource URI for a vault-relative note path. Each path
 * segment is percent-encoded (so `/` separators survive) and re-joined with
 * `/`, keeping URIs readable while remaining unambiguous.
 */
export function noteUriForPath(path: string): string {
  const encoded = path
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `${NOTE_URI_PREFIX}${encoded}`;
}

/**
 * Decode a `graphvault://note/<path>` URI back to a normalized, vault-relative
 * note path. Rejects anything that is not a note URI or that, once decoded,
 * would escape the vault (absolute paths, traversal, or empty segments). The
 * returned path is NOT guaranteed to exist - call {@link readNoteResource} to
 * resolve it against a snapshot.
 *
 * @throws {Error} with a clear message for a malformed or unsafe URI.
 */
export function pathFromNoteUri(uri: string): string {
  if (!uri.startsWith(NOTE_URI_PREFIX)) {
    throw new Error(
      `Not a GraphVault note resource URI: ${uri} (expected ${NOTE_URI_PREFIX}<path>)`,
    );
  }
  const rawPath = uri.slice(NOTE_URI_PREFIX.length);
  if (rawPath.length === 0) {
    throw new Error(`Invalid note resource URI: ${uri} (missing note path)`);
  }
  // Decode each segment independently so an encoded slash inside a segment
  // cannot smuggle in an extra path level.
  const segments = rawPath.split('/').map((seg) => {
    try {
      return decodeURIComponent(seg);
    } catch {
      throw new Error(`Invalid note resource URI: ${uri} (malformed percent-encoding)`);
    }
  });
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new Error(
      `Unsafe note resource URI: ${uri} (path must not contain empty, "." or ".." segments)`,
    );
  }
  const path = segments.join('/');
  if (path.includes('\\')) {
    throw new Error(`Unsafe note resource URI: ${uri} (path must use forward slashes)`);
  }
  return path;
}

/** Notes as resource entries, sorted by path for deterministic output. */
export function listNoteResources(snapshot: VaultSnapshot): NoteResource[] {
  return [...snapshot.index.nodes.values()]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((n) => ({
      uri: noteUriForPath(n.path),
      name: n.path,
      title: n.title,
      mimeType: NOTE_MIME_TYPE,
    }));
}

/**
 * Resolve a note resource URI to its markdown contents against a snapshot.
 * Validates/normalizes the path from the URI (no traversal) and requires the
 * note to actually exist, else throws a clear not-found error.
 */
export function readNoteResource(snapshot: VaultSnapshot, uri: string): NoteResourceContents {
  const path = pathFromNoteUri(uri);
  const content = snapshot.contentByPath.get(path);
  if (content === undefined) {
    throw new Error(`Note not found for resource ${uri} (no note at ${path})`);
  }
  return { uri, mimeType: NOTE_MIME_TYPE, text: content };
}

/**
 * Resource handlers bound to a live {@link VaultManager}. Each call refreshes
 * the snapshot (respecting the TTL) so resources reflect recent edits.
 */
export interface BoundResources {
  list(): Promise<NoteResource[]>;
  read(uri: string): Promise<NoteResourceContents>;
}

export function bindResources(manager: VaultManager): BoundResources {
  return {
    async list() {
      return listNoteResources(await manager.getSnapshot());
    },
    async read(uri) {
      return readNoteResource(await manager.getSnapshot(), uri);
    },
  };
}
