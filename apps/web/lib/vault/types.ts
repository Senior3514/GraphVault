/**
 * Local vault model types.
 *
 * These describe the client's in-memory view of a vault of `.md` notes. They
 * are deliberately UI-independent so this module can later be swapped for a
 * real filesystem backend (desktop app) without touching the React layer.
 *
 * A `Note` here maps loosely onto the sync model's `LocalFileEntry`
 * (`@graphvault/shared`): both are keyed by a vault-relative POSIX path. The
 * sync engine (Milestone 5) owns hashing/revisions; this layer owns content,
 * parsing, and the derived link/search index.
 */

/** A vault-relative POSIX path, e.g. `notes/ideas.md`. */
export type NotePath = string;

/** A single Markdown note in the vault. */
export interface Note {
  /** Vault-relative POSIX path, including the `.md` extension. */
  path: NotePath;
  /** Raw Markdown content (frontmatter + body). */
  content: string;
  /** Epoch ms of last local modification. */
  mtime: number;
  /** Epoch ms the note was created. */
  ctime: number;
}

/** Parsed metadata derived from a note's content. */
export interface ParsedNote {
  /** Display title: frontmatter `title`, else first H1, else filename. */
  title: string;
  /** YAML frontmatter as a flat key/value map (string or string[]). */
  frontmatter: Record<string, string | string[]>;
  /** Markdown body with the frontmatter block stripped. */
  body: string;
  /** Tags from frontmatter `tags` plus inline `#tags`, de-duplicated. */
  tags: string[];
  /** Wikilink targets referenced in the body, in document order (unique). */
  links: WikiLink[];
}

/** A parsed `[[target|alias]]` wikilink occurrence. */
export interface WikiLink {
  /** The raw target as written (note title or path, without `[[ ]]`). */
  target: string;
  /** Optional display alias after `|`. */
  alias?: string;
}

/** A note plus its parsed metadata, the unit most UI consumes. */
export interface IndexedNote extends Note {
  parsed: ParsedNote;
}

/** The persistence boundary: anything that can load/save the note set. */
export interface VaultStore {
  load(): Promise<Note[]>;
  save(notes: Note[]): Promise<void>;
}
