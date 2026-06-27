/**
 * Conflict-safe WRITE tool handlers.
 *
 * DATA-SAFETY: these handlers must NEVER silently lose user data. Every write
 * is a conflict-checked, fast-forward-only push:
 *
 *   1. Compute `sha256:<hex>` of the raw UTF-8 plaintext bytes.
 *   2. `PUT /v1/blobs/<hash>` so the content exists before it is referenced.
 *   3. `POST /v1/vaults/:id/push` with `baseRevision` equal to the file's
 *      CURRENT server revision (or 0 when the path has no server state). The
 *      server only fast-forward accepts when `baseRevision === server.revision`;
 *      otherwise it returns a conflict and does NOT clobber.
 *   4. If the push reports any conflict, we surface a clear tool error naming
 *      the conflict kind and telling the agent to re-read and retry - we never
 *      retry blindly with a bumped base, which would overwrite a concurrent
 *      edit.
 *
 * After a successful write we invalidate the index cache so later reads reflect
 * the change.
 *
 * Writes require a device id bound to the token (GRAPHVAULT_DEVICE_ID). When it
 * is absent every write tool returns a clear "writes disabled" error; the
 * read-only tools keep working.
 */

import { createHash } from 'node:crypto';
import {
  formatContentHash,
  type Conflict,
  type FileState,
  type PushOp,
  type PushResponse,
} from '@graphvault/shared';
import type { GraphVaultClient } from './client.js';
import type { McpConfig } from './config.js';
import { isMarkdownPath } from './vault.js';
import type { VaultManager } from './vault.js';

/** Result of a successful write: the path and the vault's new head revision. */
export interface WriteResult {
  path: string;
  revision: number;
  /** Content hash that was committed, or null for a delete. */
  hash: string | null;
}

/**
 * Error thrown when writes are requested but no device id is configured.
 * Surfaced to the agent as a clear, actionable MCP error.
 */
export class WritesDisabledError extends Error {
  constructor() {
    super('writes disabled: set GRAPHVAULT_DEVICE_ID to the device id bound to your token');
    this.name = 'WritesDisabledError';
  }
}

/**
 * Error thrown when a push reports one or more conflicts. The message names the
 * conflict kind(s) so the agent knows to re-read and retry rather than clobber.
 */
export class WriteConflictError extends Error {
  constructor(
    message: string,
    readonly conflicts: Conflict[],
  ) {
    super(message);
    this.name = 'WriteConflictError';
  }
}

/** SHA-256 content hash of the raw UTF-8 plaintext, as `sha256:<lower-hex>`. */
export function contentHashOf(content: string): string {
  const buf = Buffer.from(content, 'utf8');
  const hex = createHash('sha256').update(buf).digest('hex');
  return formatContentHash(hex);
}

/** Byte length of the UTF-8 encoding of `content`. */
function byteLength(content: string): number {
  return Buffer.byteLength(content, 'utf8');
}

/**
 * Validate and normalize a note path for a write. Reuses the same rules the
 * read tools rely on (vault-relative, no traversal) and additionally requires a
 * markdown extension so writes stay consistent with what the read tools index.
 */
export function validateNotePath(path: string): string {
  const p = path.trim();
  if (p.length === 0) throw new Error('Note path must not be empty');
  if (p.startsWith('/')) throw new Error('Note path must be vault-relative (no leading slash)');
  if (p.includes('\\')) throw new Error('Note path must use forward slashes');
  if (p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new Error('Note path must not contain empty, "." or ".." segments');
  }
  if (!isMarkdownPath(p)) {
    throw new Error('Note path must end in .md (or .markdown)');
  }
  return p;
}

/**
 * Bound write handlers over a live {@link VaultManager} and {@link GraphVaultClient}.
 * All four tools are conflict-safe and require a configured device id.
 */
export interface BoundWriteTools {
  /** Writes are only usable when this is true (GRAPHVAULT_DEVICE_ID is set). */
  readonly enabled: boolean;
  createNote(args: { path: string; content: string }): Promise<WriteResult>;
  updateNote(args: { path: string; content: string; expectedHash?: string }): Promise<WriteResult>;
  appendToNote(args: { path: string; content: string }): Promise<WriteResult>;
  deleteNote(args: { path: string }): Promise<WriteResult>;
}

/** A server state for a live (non-deleted) note: its `hash` is guaranteed set. */
type LiveNoteState = FileState & { hash: string };

/** A non-deleted server state with content means a live note exists at the path. */
function isLiveNote(state: FileState | null): state is LiveNoteState {
  return state !== null && !state.deleted && state.hash !== null;
}

export function bindWriteTools(
  manager: VaultManager,
  client: GraphVaultClient,
  config: McpConfig,
): BoundWriteTools {
  const deviceId = config.deviceId;
  const enabled = deviceId !== undefined;

  /** Require writes to be enabled; throws a clear error otherwise. */
  function requireDevice(): string {
    if (deviceId === undefined) throw new WritesDisabledError();
    return deviceId;
  }

  /**
   * Upload `content` and push a single op at the given base revision. Surfaces
   * conflicts as a {@link WriteConflictError} and invalidates the cache on
   * success.
   */
  async function commitWrite(
    vaultId: string,
    device: string,
    path: string,
    content: string,
    baseRevision: number,
  ): Promise<WriteResult> {
    const hash = contentHashOf(content);
    const bytes = new TextEncoder().encode(content);
    // Upload the blob first so the push never references a missing blob.
    await client.putBlob(hash, bytes);
    const op: PushOp = {
      path,
      hash,
      size: byteLength(content),
      mtime: Date.now(),
      deleted: false,
      baseRevision,
    };
    const resp = await client.push(vaultId, device, [op]);
    return finishPush(resp, path, hash);
  }

  /** Push a delete (tombstone) op at the given base revision. */
  async function commitDelete(
    vaultId: string,
    device: string,
    path: string,
    baseRevision: number,
  ): Promise<WriteResult> {
    const op: PushOp = {
      path,
      hash: null,
      size: 0,
      mtime: Date.now(),
      deleted: true,
      baseRevision,
    };
    const resp = await client.push(vaultId, device, [op]);
    return finishPush(resp, path, null);
  }

  /**
   * Interpret a {@link PushResponse}: throw on any conflict (never retry
   * blindly), otherwise confirm the path was applied and invalidate the cache.
   */
  function finishPush(resp: PushResponse, path: string, hash: string | null): WriteResult {
    if (resp.conflicts.length > 0) {
      const kinds = resp.conflicts.map((c) => c.kind).join(', ');
      throw new WriteConflictError(
        `Conflict (${kinds}) writing ${path}: the server moved ahead of your base. ` +
          `Re-read the note and retry; the write was NOT applied (no data was overwritten).`,
        resp.conflicts,
      );
    }
    if (!resp.applied.includes(path)) {
      // Defensive: neither applied nor conflicted. Do not assume success.
      throw new Error(
        `Write to ${path} was neither applied nor reported as a conflict; aborting to avoid data loss.`,
      );
    }
    manager.invalidate();
    return { path, revision: resp.revision, hash };
  }

  return {
    enabled,

    async createNote({ path, content }) {
      const device = requireDevice();
      const safePath = validateNotePath(path);
      const vaultId = await manager.resolveVaultId();
      const state = await client.getFileState(vaultId, safePath);
      if (isLiveNote(state)) {
        throw new Error(
          `Cannot create ${safePath}: a note already exists there. Use update_note to change it.`,
        );
      }
      // base = current revision (e.g. a prior tombstone) or 0 when truly absent.
      const baseRevision = state?.revision ?? 0;
      return commitWrite(vaultId, device, safePath, content, baseRevision);
    },

    async updateNote({ path, content, expectedHash }) {
      const device = requireDevice();
      const safePath = validateNotePath(path);
      const vaultId = await manager.resolveVaultId();
      const state = await client.getFileState(vaultId, safePath);
      if (!isLiveNote(state)) {
        throw new Error(`Cannot update ${safePath}: no note exists there. Use create_note first.`);
      }
      if (expectedHash !== undefined && expectedHash !== state.hash) {
        throw new Error(
          `Cannot update ${safePath}: expectedHash ${expectedHash} does not match the current ` +
            `server hash ${state.hash}. Re-read the note and retry.`,
        );
      }
      return commitWrite(vaultId, device, safePath, content, state.revision);
    },

    async appendToNote({ path, content }) {
      const device = requireDevice();
      const safePath = validateNotePath(path);
      const vaultId = await manager.resolveVaultId();
      const state = await client.getFileState(vaultId, safePath);
      if (!isLiveNote(state)) {
        throw new Error(
          `Cannot append to ${safePath}: no note exists there. Use create_note first.`,
        );
      }
      // Read-modify-write against the SAME revision we will push as the base, so
      // a concurrent edit between read and push is caught as a conflict.
      const current = await client.getBlobText(state.hash);
      const separator = current.endsWith('\n') ? '' : '\n';
      const merged = `${current}${separator}${content}`;
      return commitWrite(vaultId, device, safePath, merged, state.revision);
    },

    async deleteNote({ path }) {
      const device = requireDevice();
      const safePath = validateNotePath(path);
      const vaultId = await manager.resolveVaultId();
      const state = await client.getFileState(vaultId, safePath);
      if (!isLiveNote(state)) {
        throw new Error(`Cannot delete ${safePath}: no note exists there.`);
      }
      return commitDelete(vaultId, device, safePath, state.revision);
    },
  };
}
