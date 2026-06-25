import { z } from 'zod';

/**
 * Canonical sync data model.
 *
 * This mirrors the server entities and the client's local index. See
 * docs/sync-protocol.md for the narrative spec; this file is the source of
 * truth for the wire representation.
 */

/**
 * Vault-relative POSIX path of a file, e.g. `notes/ideas/graphs.md`.
 *
 * Rules:
 * - Always forward slashes, never a leading slash.
 * - NFC-normalized Unicode.
 * - No `.` or `..` segments.
 * - Case is preserved and significant on the wire (clients on
 *   case-insensitive filesystems must detect collisions locally).
 */
export const filePathSchema = z
  .string()
  .min(1)
  .max(1024)
  // Normalize to NFC up front so two Unicode encodings of the same path (e.g.
  // NFD `café` vs NFC `café`) become a single canonical identity before any
  // hashing or comparison (spec §2.1). This only re-encodes Unicode; it never
  // changes ASCII, so it cannot reject a previously-valid path. Content bytes
  // are NOT normalized — only paths.
  .transform((p) => p.normalize('NFC'))
  .refine((p) => !p.startsWith('/'), 'path must be vault-relative (no leading slash)')
  .refine((p) => !p.includes('\\'), 'path must use forward slashes')
  .refine(
    (p) => !p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..'),
    'path must not contain empty, "." or ".." segments',
  );
export type FilePath = z.infer<typeof filePathSchema>;

/** `sha256:<hex>` content hash. */
export const contentHashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

/**
 * A monotonically increasing per-vault revision sequence number. Every
 * accepted change to a vault advances `seq` by one. Clients store the last
 * `seq` they have fully applied and request deltas since that value.
 */
export const revisionSeqSchema = z.number().int().nonnegative();
export type RevisionSeq = z.infer<typeof revisionSeqSchema>;

/**
 * The state of a single file at a particular revision, as the server sees it.
 * A deleted file is represented with `deleted: true` and a null hash (a
 * tombstone) so deletions propagate to every device.
 */
export const fileStateSchema = z.object({
  path: filePathSchema,
  /** Null only when `deleted` is true. */
  hash: contentHashSchema.nullable(),
  /** Size in bytes of the content, or 0 for a tombstone. */
  size: z.number().int().nonnegative(),
  /** Client-reported last-modified time, Unix epoch milliseconds. */
  mtime: z.number().int().nonnegative(),
  deleted: z.boolean(),
  /** Revision seq at which this state was recorded server-side. */
  revision: revisionSeqSchema,
});
export type FileState = z.infer<typeof fileStateSchema>;

/**
 * A client's local view of a file, kept in the local index (e.g. SQLite).
 * `baseRevision` is the server revision this local state was last reconciled
 * against; it is the basis for three-way conflict detection.
 */
export const localFileEntrySchema = z.object({
  path: filePathSchema,
  hash: contentHashSchema.nullable(),
  size: z.number().int().nonnegative(),
  mtime: z.number().int().nonnegative(),
  deleted: z.boolean(),
  baseRevision: revisionSeqSchema,
  /** True when the local content differs from `baseRevision`'s server state. */
  dirty: z.boolean(),
});
export type LocalFileEntry = z.infer<typeof localFileEntrySchema>;

export interface VaultRef {
  id: string;
  name: string;
}

export interface DeviceRef {
  id: string;
  name: string;
}
