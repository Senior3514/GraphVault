/**
 * Round-trip sync tests exercising the web adapter (`createLocalVault`) wired
 * to the sync-core engine. These tests verify the web-specific adapter code
 * (the `VaultMutator` -> `LocalVault` translation) plus the conflict model.
 *
 * We cannot import `FakeServer` / `FakeLocalVault` from sync-core because they
 * are internal test utilities not exported by the package. Instead this file
 * provides a minimal self-contained `InMemServer` and drives `runSync` through
 * the `createLocalVault` adapter — exactly as the browser does, but without
 * `localStorage` (we patch the index to use a plain array).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { hashContent } from '@graphvault/sync-core';
import type {
  ChangesResponse,
  Conflict,
  FilePath,
  FileState,
  LocalFileEntry,
  PushRequest,
  PushResponse,
} from '@graphvault/shared';
import type { RemoteApi } from '@graphvault/sync-core';
import { runSync } from '@graphvault/sync-core';

import { createLocalVault, type VaultMutator } from './localVault';

// ---------------------------------------------------------------------------
// Minimal in-memory server (faithful implementation of the conflict model)
// ---------------------------------------------------------------------------

class InMemServer {
  private blobs = new Map<string, string>();
  private files = new Map<FilePath, FileState>();
  private _head = 0;

  get head() {
    return this._head;
  }

  async putBlob(hash: string, content: string): Promise<void> {
    const actual = await hashContent(content);
    if (actual !== hash) throw new Error(`blob hash mismatch: expected ${hash}, got ${actual}`);
    this.blobs.set(hash, content);
  }

  hasBlob(hash: string): boolean {
    return this.blobs.has(hash);
  }

  getBlob(hash: string): string {
    const c = this.blobs.get(hash);
    if (c === undefined) throw new Error(`missing blob ${hash}`);
    return c;
  }

  getChanges(since: number, limit = 500): ChangesResponse {
    const all = [...this.files.values()]
      .filter((s) => s.revision > since)
      .sort((a, b) => a.revision - b.revision);
    const page = all.slice(0, limit);
    return { revision: this._head, changes: page, hasMore: all.length > page.length };
  }

  push(body: PushRequest): PushResponse {
    const applied: FilePath[] = [];
    const conflicts: Conflict[] = [];
    const accepted: Array<Omit<FileState, 'revision'>> = [];

    for (const op of body.ops) {
      const server = this.files.get(op.path) ?? null;
      const serverRev = server?.revision ?? 0;

      if (!op.deleted && op.hash !== null && !this.blobs.has(op.hash)) {
        conflicts.push({ path: op.path, kind: 'MISSING_BLOB', server });
        continue;
      }
      if (server && server.hash === op.hash && server.deleted === op.deleted) {
        applied.push(op.path);
        continue;
      }
      if (op.baseRevision === serverRev) {
        accepted.push({
          path: op.path,
          hash: op.hash,
          size: op.size,
          mtime: op.mtime,
          deleted: op.deleted,
        });
        applied.push(op.path);
        continue;
      }
      if (op.baseRevision < serverRev) {
        const serverHasContent = server ? !server.deleted : false;
        const opHasContent = !op.deleted;
        if (serverHasContent && opHasContent && server?.hash !== op.hash) {
          conflicts.push({ path: op.path, kind: 'CONTENT_CONFLICT', server });
        } else if (serverHasContent !== opHasContent) {
          conflicts.push({ path: op.path, kind: 'DELETE_EDIT_CONFLICT', server });
        } else {
          conflicts.push({ path: op.path, kind: 'STALE_BASE', server });
        }
        continue;
      }
      conflicts.push({ path: op.path, kind: 'STALE_BASE', server });
    }

    let nextRev = this._head;
    for (const s of accepted) {
      nextRev += 1;
      this.files.set(s.path, { ...s, revision: nextRev });
    }
    this._head = nextRev;
    return { revision: nextRev, applied, conflicts };
  }

  makeRemote(): RemoteApi {
    return {
      getChanges: async (_id, since, limit) => this.getChanges(since, limit),
      push: async (_id, body) => this.push(body),
      hasBlob: async (hash) => this.hasBlob(hash),
      putBlob: async (hash, content) => this.putBlob(hash, content),
      getBlob: async (hash) => this.getBlob(hash),
    };
  }
}

// ---------------------------------------------------------------------------
// Minimal in-memory VaultMutator + LocalVault (no React, no localStorage)
// ---------------------------------------------------------------------------

interface InMemNote {
  path: string;
  content: string;
  mtime: number;
  ctime: number;
}

function makeVaultMutator(initial: Omit<InMemNote, 'ctime'>[] = []): VaultMutator & {
  all(): InMemNote[];
  get(path: string): InMemNote | undefined;
} {
  const now = Date.now();
  const store = new Map<string, InMemNote>(initial.map((n) => [n.path, { ...n, ctime: now }]));
  return {
    notes: () => [...store.values()],
    upsert: (path, content, mtime) => {
      const prev = store.get(path);
      store.set(path, {
        path,
        content,
        mtime: mtime ?? Date.now(),
        ctime: prev?.ctime ?? Date.now(),
      });
    },
    remove: (path) => {
      store.delete(path);
    },
    all: () => [...store.values()],
    get: (path) => store.get(path),
  };
}

/**
 * Build a LocalVault backed by the given mutator with an in-memory sync index
 * (no localStorage). The index persists across calls to `runSync` as long as
 * the same object is reused — matching how the browser works.
 */
function makeTestLocalVault(mutator: ReturnType<typeof makeVaultMutator>) {
  const lv = createLocalVault(mutator);
  const indexStore: LocalFileEntry[] = [];
  return {
    ...lv,
    readIndex: () => [...indexStore],
    writeIndex: (entries: LocalFileEntry[]) => {
      indexStore.length = 0;
      indexStore.push(...entries);
    },
  };
}

const VAULT = 'vault-1';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('web adapter: new local note is pushed to the server', async () => {
  const server = new InMemServer();
  const remote = server.makeRemote();

  const mutator = makeVaultMutator([{ path: 'notes/hello.md', content: '# Hello', mtime: 1000 }]);
  const local = makeTestLocalVault(mutator);

  const result = await runSync(local, remote, VAULT, { deviceId: 'web-1' });

  assert.deepEqual(result.applied, ['notes/hello.md']);
  assert.equal(result.conflicts.length, 0);
  assert.equal(server.head, 1);
});

test('web adapter: remote note is pulled into the local vault', async () => {
  const server = new InMemServer();
  const remote = server.makeRemote();

  // Device A creates a note and syncs.
  const mutatorA = makeVaultMutator([{ path: 'notes/shared.md', content: 'from A', mtime: 1000 }]);
  await runSync(makeTestLocalVault(mutatorA), remote, VAULT, { deviceId: 'web-a' });

  // Device B starts empty and pulls.
  const mutatorB = makeVaultMutator();
  await runSync(makeTestLocalVault(mutatorB), remote, VAULT, { deviceId: 'web-b' });

  const pulled = mutatorB.get('notes/shared.md');
  assert.ok(pulled, 'note should have been pulled to device B');
  assert.equal(pulled.content, 'from A');
});

test('web adapter: content conflict creates a conflict copy — no data lost', async () => {
  const server = new InMemServer();
  const remote = server.makeRemote();

  // A creates a note and syncs. The index is retained in `localA`.
  const mutatorA = makeVaultMutator([{ path: 'notes/idea.md', content: 'base', mtime: 1000 }]);
  const localA = makeTestLocalVault(mutatorA);
  await runSync(localA, remote, VAULT, { deviceId: 'web-a' });

  // B starts empty, pulls the note. Index retained in `localB`.
  const mutatorB = makeVaultMutator();
  const localB = makeTestLocalVault(mutatorB);
  await runSync(localB, remote, VAULT, { deviceId: 'web-b' });
  assert.equal(mutatorB.get('notes/idea.md')?.content, 'base');

  // A edits and syncs first — A's index knows baseRevision=1.
  mutatorA.upsert('notes/idea.md' as FilePath, 'edit from A', 2000);
  await runSync(localA, remote, VAULT, { deviceId: 'web-a' });
  assert.equal(server.head, 2);

  // B edits the same note from its stale base (baseRevision=1, server now at rev=2).
  mutatorB.upsert('notes/idea.md' as FilePath, 'edit from B', 3000);
  const result = await runSync(localB, remote, VAULT, {
    deviceId: 'web-b',
    deviceName: 'web-b',
    now: () => new Date('2026-06-15T12:00:00.000Z'),
  });

  assert.equal(result.conflicts.length, 1, 'expected one content conflict');
  assert.equal(result.conflicts[0]?.kind, 'CONTENT_CONFLICT');

  // Canonical path holds the server version (A's edit); B's edit is in a copy.
  assert.equal(mutatorB.get('notes/idea.md')?.content, 'edit from A');
  const copyPath = 'notes/idea (conflict 2026-06-15 from web-b).md';
  const copy = mutatorB.get(copyPath);
  assert.ok(copy, 'conflict copy must exist — data must never be silently lost');
  assert.equal(copy.content, 'edit from B');
});

test('web adapter: delete propagates from A to B', async () => {
  const server = new InMemServer();
  const remote = server.makeRemote();

  const mutatorA = makeVaultMutator([{ path: 'notes/gone.md', content: 'bye', mtime: 1000 }]);
  const localA = makeTestLocalVault(mutatorA);
  await runSync(localA, remote, VAULT, { deviceId: 'web-a' });

  // B pulls the note.
  const mutatorB = makeVaultMutator();
  const localB = makeTestLocalVault(mutatorB);
  await runSync(localB, remote, VAULT, { deviceId: 'web-b' });
  assert.ok(mutatorB.get('notes/gone.md'), 'B should have the note after initial sync');

  // A deletes the note and syncs.
  mutatorA.remove('notes/gone.md' as FilePath);
  await runSync(localA, remote, VAULT, { deviceId: 'web-a' });

  // B syncs — note should be removed locally.
  await runSync(localB, remote, VAULT, { deviceId: 'web-b' });
  assert.ok(!mutatorB.get('notes/gone.md'), 'B should no longer have the deleted note');
});

test('web adapter: idempotent second sync produces no changes', async () => {
  const server = new InMemServer();
  const remote = server.makeRemote();

  const mutator = makeVaultMutator([
    { path: 'notes/stable.md', content: 'unchanged', mtime: 1000 },
  ]);
  const local = makeTestLocalVault(mutator);

  await runSync(local, remote, VAULT, { deviceId: 'web-1' });
  const headAfterFirst = server.head;

  const second = await runSync(local, remote, VAULT, { deviceId: 'web-1' });
  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.pushed, []);
  assert.deepEqual(second.pulled, []);
  assert.equal(second.conflicts.length, 0);
  assert.equal(server.head, headAfterFirst, 'server head must not advance on a no-op sync');
});
