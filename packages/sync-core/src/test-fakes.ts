/**
 * In-memory fakes for testing the sync engine end to end.
 *
 * - {@link FakeServer} is a minimal but faithful implementation of the server
 *   side of the protocol (§5-§6): content-addressed blobs, per-vault revisions,
 *   and the three-way conflict decision rules.
 * - {@link FakeLocalVault} is a `LocalVault` backed by plain Maps.
 * - {@link makeRemote} adapts a {@link FakeServer} to the {@link RemoteApi} port.
 *
 * Two `FakeLocalVault`s pointed at one `FakeServer` simulate two devices.
 */

import type {
  ChangesResponse,
  Conflict,
  FilePath,
  FileState,
  LocalFileEntry,
  PushRequest,
  PushResponse,
} from '@graphvault/shared';

import { hashContent } from './hash.js';
import type { LocalEntry, LocalVault, RemoteApi } from './ports.js';

/** A faithful in-memory GraphVault server for one or more vaults. */
export class FakeServer {
  private blobs = new Map<string, string>();
  private vaults = new Map<string, Map<FilePath, FileState>>();
  private heads = new Map<string, number>();

  createVault(vaultId: string): void {
    if (!this.vaults.has(vaultId)) {
      this.vaults.set(vaultId, new Map());
      this.heads.set(vaultId, 0);
    }
  }

  private files(vaultId: string): Map<FilePath, FileState> {
    const f = this.vaults.get(vaultId);
    if (!f) throw new Error(`unknown vault ${vaultId}`);
    return f;
  }

  head(vaultId: string): number {
    return this.heads.get(vaultId) ?? 0;
  }

  hasBlob(hash: string): boolean {
    return this.blobs.has(hash);
  }

  async putBlob(hash: string, content: string): Promise<void> {
    // Re-verify the hash, exactly like the real server (§5.5).
    const actual = await hashContent(content);
    if (actual !== hash) {
      throw new Error(`blob hash mismatch: expected ${hash}, got ${actual}`);
    }
    this.blobs.set(hash, content);
  }

  getBlob(hash: string): string {
    const c = this.blobs.get(hash);
    if (c === undefined) throw new Error(`missing blob ${hash}`);
    return c;
  }

  getChanges(vaultId: string, since: number, limit = 500): ChangesResponse {
    const all = [...this.files(vaultId).values()]
      .filter((s) => s.revision > since)
      .sort((a, b) => a.revision - b.revision);
    const page = all.slice(0, limit);
    return {
      revision: this.head(vaultId),
      changes: page,
      hasMore: all.length > page.length,
    };
  }

  push(vaultId: string, body: PushRequest): PushResponse {
    const files = this.files(vaultId);
    const applied: FilePath[] = [];
    const conflicts: Conflict[] = [];

    // Validate + classify every op first; commit accepted ops atomically.
    const accepted: FileState[] = [];
    let nextRev = this.head(vaultId);

    for (const op of body.ops) {
      const server = files.get(op.path) ?? null;
      const serverRev = server?.revision ?? 0;

      // Missing blob (§6.1.4).
      if (!op.deleted && op.hash !== null && !this.blobs.has(op.hash)) {
        conflicts.push({ path: op.path, kind: 'MISSING_BLOB', server });
        continue;
      }

      // No-op (§6.1.2): identical result, accept idempotently.
      if (server && server.hash === op.hash && server.deleted === op.deleted) {
        applied.push(op.path);
        continue;
      }

      // Fast-forward (§6.1.1).
      if (op.baseRevision === serverRev) {
        accepted.push(materialize(op, 0));
        applied.push(op.path);
        continue;
      }

      // Stale base: server moved ahead (§6.1.3).
      if (op.baseRevision < serverRev) {
        const serverHasContent = server ? !server.deleted : false;
        const opHasContent = !op.deleted;
        if (serverHasContent && opHasContent && server?.hash !== op.hash) {
          conflicts.push({ path: op.path, kind: 'CONTENT_CONFLICT', server });
        } else if (serverHasContent !== opHasContent) {
          conflicts.push({
            path: op.path,
            kind: 'DELETE_EDIT_CONFLICT',
            server,
          });
        } else {
          conflicts.push({ path: op.path, kind: 'STALE_BASE', server });
        }
        continue;
      }

      // baseRevision > serverRev should not happen; treat as stale.
      conflicts.push({ path: op.path, kind: 'STALE_BASE', server });
    }

    // Commit accepted ops as one change-set, each bumping the head.
    for (const state of accepted) {
      nextRev += 1;
      files.set(state.path, { ...state, revision: nextRev });
    }
    this.heads.set(vaultId, nextRev);

    return { revision: nextRev, applied, conflicts };
  }
}

function materialize(op: PushRequest['ops'][number], revision: number): FileState {
  return {
    path: op.path,
    hash: op.hash,
    size: op.size,
    mtime: op.mtime,
    deleted: op.deleted,
    revision,
  };
}

/** Adapt a {@link FakeServer} to the {@link RemoteApi} port for one vault. */
export function makeRemote(server: FakeServer): RemoteApi {
  return {
    getChanges: async (vaultId, since, limit) => server.getChanges(vaultId, since, limit),
    push: async (vaultId, body) => server.push(vaultId, body),
    hasBlob: async (hash) => server.hasBlob(hash),
    putBlob: async (hash, content) => server.putBlob(hash, content),
    getBlob: async (hash) => server.getBlob(hash),
  };
}

/** An in-memory `LocalVault` simulating one device's storage. */
export class FakeLocalVault implements LocalVault {
  private content = new Map<FilePath, { content: string; mtime: number }>();
  private index = new Map<FilePath, LocalFileEntry>();

  /** Seed/replace local content as if the user edited a file. */
  setContent(path: FilePath, content: string, mtime = Date.now()): void {
    this.content.set(path, { content, mtime });
  }

  /** Remove local content as if the user deleted a file. */
  removeContent(path: FilePath): void {
    this.content.delete(path);
  }

  has(path: FilePath): boolean {
    return this.content.has(path);
  }

  get(path: FilePath): string | undefined {
    return this.content.get(path)?.content;
  }

  listPaths(): FilePath[] {
    return [...this.content.keys()].sort();
  }

  // --- LocalVault port ---

  listEntries(): LocalEntry[] {
    return [...this.content.entries()].map(([path, v]) => ({
      path,
      hash: null,
      content: v.content,
      mtime: v.mtime,
      deleted: false,
    }));
  }

  readContent(path: FilePath): string | null {
    return this.content.get(path)?.content ?? null;
  }

  writeContent(path: FilePath, content: string, mtime: number): void {
    this.content.set(path, { content, mtime });
  }

  deleteContent(path: FilePath): void {
    this.content.delete(path);
  }

  readIndex(): LocalFileEntry[] {
    return [...this.index.values()].map((e) => ({ ...e }));
  }

  writeIndex(entries: LocalFileEntry[]): void {
    this.index = new Map(entries.map((e) => [e.path, { ...e }]));
  }
}
