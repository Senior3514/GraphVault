import { z } from 'zod';
import { contentHashSchema, fileStateSchema, filePathSchema, revisionSeqSchema } from './model.js';

/**
 * Sync protocol wire messages.
 *
 * Flow (see docs/sync-protocol.md):
 *   1. auth (handled by /v1/auth/*)
 *   2. POST /v1/vaults                      -> register a vault
 *   3. GET  /v1/vaults/:id/changes?since=N  -> pull remote changes
 *   4. POST /v1/vaults/:id/push             -> push local changes
 *   5. blob upload/download for content addressed by hash
 */

/** Reason a pushed change was rejected or flagged. */
export const conflictKindSchema = z.enum([
  'CONTENT_CONFLICT', // both sides edited the same file from the same base
  'DELETE_EDIT_CONFLICT', // one side deleted, the other edited
  'STALE_BASE', // client's baseRevision is behind; must pull and retry
  'MISSING_BLOB', // referenced content hash was never uploaded
]);
export type ConflictKind = z.infer<typeof conflictKindSchema>;

/** A single change a client wants to push. */
export const pushOpSchema = z.object({
  path: filePathSchema,
  /** Null => the client is deleting the file (tombstone). */
  hash: contentHashSchema.nullable(),
  size: z.number().int().nonnegative(),
  mtime: z.number().int().nonnegative(),
  deleted: z.boolean(),
  /** Server revision the client based this change on. */
  baseRevision: revisionSeqSchema,
});
export type PushOp = z.infer<typeof pushOpSchema>;

export const pushRequestSchema = z.object({
  deviceId: z.string().min(1),
  ops: z.array(pushOpSchema).max(5000),
});
export type PushRequest = z.infer<typeof pushRequestSchema>;

export const conflictSchema = z.object({
  path: filePathSchema,
  kind: conflictKindSchema,
  /** Server's current authoritative state for the path, if any. */
  server: fileStateSchema.nullable(),
});
export type Conflict = z.infer<typeof conflictSchema>;

export const pushResponseSchema = z.object({
  /** New head revision after applying the accepted ops. */
  revision: revisionSeqSchema,
  /** Paths that were accepted and committed. */
  applied: z.array(filePathSchema),
  /** Paths that could not be applied; client must resolve and retry. */
  conflicts: z.array(conflictSchema),
});
export type PushResponse = z.infer<typeof pushResponseSchema>;

export const changesResponseSchema = z.object({
  /** Server head revision at the time of the response. */
  revision: revisionSeqSchema,
  /** File states changed strictly after the requested `since`. */
  changes: z.array(fileStateSchema),
  /** True when more changes remain; client should page with the new `since`. */
  hasMore: z.boolean(),
});
export type ChangesResponse = z.infer<typeof changesResponseSchema>;

export const registerVaultRequestSchema = z.object({
  name: z.string().min(1).max(200),
});
export type RegisterVaultRequest = z.infer<typeof registerVaultRequestSchema>;

export const registerVaultResponseSchema = z.object({
  vaultId: z.string().min(1),
  name: z.string(),
  revision: revisionSeqSchema,
});
export type RegisterVaultResponse = z.infer<typeof registerVaultResponseSchema>;

/** Standard error envelope returned for non-2xx responses. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof apiErrorSchema>;
