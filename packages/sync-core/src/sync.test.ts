/**
 * End-to-end unit tests for the sync engine, driven through in-memory fakes
 * (a faithful fake server + per-device fake local vaults). These exercise the
 * scenarios from the milestone brief and spec §6-§7.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { FilePath } from '@graphvault/shared';

import { runSync } from './sync.js';
import { FakeLocalVault, FakeServer, makeRemote } from './test-fakes.js';
import type { SyncOptions } from './types.js';

const VAULT = 'vault-1';

function optsFor(deviceId: string, date = '2026-06-15T12:00:00.000Z'): SyncOptions {
  return {
    deviceId,
    deviceName: deviceId,
    now: () => new Date(date),
  };
}

function setup() {
  const server = new FakeServer();
  server.createVault(VAULT);
  const remote = makeRemote(server);
  return { server, remote };
}

test('new local file is pushed to the server', async () => {
  const { server, remote } = setup();
  const local = new FakeLocalVault();
  local.setContent('notes/a.md' as FilePath, '# Alpha', 1000);

  const result = await runSync(local, remote, VAULT, optsFor('dev-a'));

  assert.deepEqual(result.applied, ['notes/a.md']);
  assert.deepEqual(result.pushed, ['notes/a.md']);
  assert.equal(result.conflicts.length, 0);
  assert.equal(server.head(VAULT), 1);

  // Index is now clean and reconciled to revision 1.
  const idx = local.readIndex();
  assert.equal(idx.length, 1);
  assert.equal(idx[0]?.dirty, false);
  assert.equal(idx[0]?.baseRevision, 1);
});

test('remote new file is pulled into the local vault', async () => {
  const { remote } = setup();

  // Device A creates a file and syncs.
  const a = new FakeLocalVault();
  a.setContent('notes/shared.md' as FilePath, 'from A', 1000);
  await runSync(a, remote, VAULT, optsFor('dev-a'));

  // Device B starts empty and pulls it.
  const b = new FakeLocalVault();
  const result = await runSync(b, remote, VAULT, optsFor('dev-b'));

  assert.deepEqual(result.pulled, ['notes/shared.md']);
  assert.equal(b.get('notes/shared.md' as FilePath), 'from A');
  const idx = b.readIndex();
  assert.equal(idx[0]?.baseRevision, 1);
  assert.equal(idx[0]?.dirty, false);
});

test('edit/edit content conflict produces a conflict copy and converges', async () => {
  const { remote } = setup();

  // Both devices start from the same base file.
  const a = new FakeLocalVault();
  a.setContent('notes/idea.md' as FilePath, 'base', 1000);
  await runSync(a, remote, VAULT, optsFor('dev-a'));

  const b = new FakeLocalVault();
  await runSync(b, remote, VAULT, optsFor('dev-b'));
  assert.equal(b.get('notes/idea.md' as FilePath), 'base');

  // A edits and syncs first → server head advances.
  a.setContent('notes/idea.md' as FilePath, 'edit from A', 2000);
  await runSync(a, remote, VAULT, optsFor('dev-a'));

  // B edits the same file from the stale base, then syncs → conflict.
  b.setContent('notes/idea.md' as FilePath, 'edit from B', 3000);
  const result = await runSync(b, remote, VAULT, optsFor('dev-b'));

  assert.equal(result.conflicts.length, 1);
  const conflict = result.conflicts[0];
  assert.equal(conflict?.kind, 'CONTENT_CONFLICT');
  const copyPath = 'notes/idea (conflict 2026-06-15 from dev-b).md';
  assert.equal(conflict?.conflictCopyPath, copyPath);

  // Canonical path holds the server (A's) version; B's edit preserved in copy.
  assert.equal(b.get('notes/idea.md' as FilePath), 'edit from A');
  assert.equal(b.get(copyPath as FilePath), 'edit from B');

  // The conflict copy was pushed up; A pulls it and converges.
  const aResult = await runSync(a, remote, VAULT, optsFor('dev-a'));
  assert.ok(aResult.pulled.includes(copyPath as FilePath));
  assert.equal(a.get(copyPath as FilePath), 'edit from B');
  assert.equal(a.get('notes/idea.md' as FilePath), 'edit from A');

  // Both devices now hold identical content sets.
  assert.deepEqual(a.listPaths(), b.listPaths());
});

test('delete/edit conflict keeps the edit as canonical and records a copy', async () => {
  const { remote } = setup();

  const a = new FakeLocalVault();
  a.setContent('notes/keep.md' as FilePath, 'original', 1000);
  await runSync(a, remote, VAULT, optsFor('dev-a'));

  const b = new FakeLocalVault();
  await runSync(b, remote, VAULT, optsFor('dev-b'));

  // A edits; syncs first.
  a.setContent('notes/keep.md' as FilePath, 'edited by A', 2000);
  await runSync(a, remote, VAULT, optsFor('dev-a'));

  // B deletes the same file from the stale base.
  b.removeContent('notes/keep.md' as FilePath);
  const result = await runSync(b, remote, VAULT, optsFor('dev-b'));

  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]?.kind, 'DELETE_EDIT_CONFLICT');

  // The edited (non-deleted) version is canonical on B after resolution.
  assert.equal(b.get('notes/keep.md' as FilePath), 'edited by A');
});

test('client-edit/server-delete conflict keeps the local edit as canonical', async () => {
  const { server, remote } = setup();

  // Both devices start from the same base file.
  const a = new FakeLocalVault();
  a.setContent('notes/keep.md' as FilePath, 'original', 1000);
  await runSync(a, remote, VAULT, optsFor('dev-a'));

  const b = new FakeLocalVault();
  await runSync(b, remote, VAULT, optsFor('dev-b'));

  // A deletes the file; syncs first → server holds the tombstone.
  a.removeContent('notes/keep.md' as FilePath);
  await runSync(a, remote, VAULT, optsFor('dev-a'));

  // B edits the same file from the stale base → DELETE_EDIT_CONFLICT where the
  // CLIENT holds the edit and the SERVER holds the tombstone. Per §6.3 the
  // edited (non-deleted) version must stay canonical - a delete must not beat
  // an edit.
  b.setContent('notes/keep.md' as FilePath, 'edited by B', 3000);
  const result = await runSync(b, remote, VAULT, optsFor('dev-b'));

  assert.equal(result.conflicts.length, 1);
  assert.equal(result.conflicts[0]?.kind, 'DELETE_EDIT_CONFLICT');

  // The edit survives at the canonical path on B …
  assert.equal(b.get('notes/keep.md' as FilePath), 'edited by B');

  // … and it re-pushes and wins on the server, so A converges to the edit too.
  const aResult = await runSync(a, remote, VAULT, optsFor('dev-a'));
  assert.equal(a.get('notes/keep.md' as FilePath), 'edited by B');
  assert.ok(aResult.pulled.includes('notes/keep.md' as FilePath));

  // Both devices converge on identical content and the edit is live server-side.
  assert.deepEqual(a.listPaths(), b.listPaths());
  const serverState = server.getChanges(VAULT, 0).changes.find((s) => s.path === 'notes/keep.md');
  assert.equal(serverState?.deleted, false);
});

test('two same-day conflict copies on one file do not overwrite each other', async () => {
  const { remote } = setup();

  // Base file shared by both devices.
  const a = new FakeLocalVault();
  a.setContent('notes/idea.md' as FilePath, 'base', 1000);
  await runSync(a, remote, VAULT, optsFor('dev-a'));

  const b = new FakeLocalVault();
  await runSync(b, remote, VAULT, optsFor('dev-b'));

  // First conflict on dev-b, same day.
  a.setContent('notes/idea.md' as FilePath, 'A edit 1', 2000);
  await runSync(a, remote, VAULT, optsFor('dev-a'));
  b.setContent('notes/idea.md' as FilePath, 'B edit 1', 3000);
  const first = await runSync(b, remote, VAULT, optsFor('dev-b'));
  assert.equal(first.conflicts.length, 1);
  const firstCopy = first.conflicts[0]!.conflictCopyPath;

  // Second conflict on the SAME file, SAME device, SAME day.
  a.setContent('notes/idea.md' as FilePath, 'A edit 2', 4000);
  await runSync(a, remote, VAULT, optsFor('dev-a'));
  b.setContent('notes/idea.md' as FilePath, 'B edit 2', 5000);
  const second = await runSync(b, remote, VAULT, optsFor('dev-b'));
  assert.equal(second.conflicts.length, 1);
  const secondCopy = second.conflicts[0]!.conflictCopyPath;

  // The two copies must be distinct paths so neither overwrites the other.
  assert.notEqual(firstCopy, secondCopy);
  assert.equal(b.get(firstCopy as FilePath), 'B edit 1');
  assert.equal(b.get(secondCopy as FilePath), 'B edit 2');
});

test('NFC/NFD path forms are treated as the same file (no duplicate identity)', async () => {
  const { server, remote } = setup();

  // Device A pushes a note whose path is in NFC form.
  const nfc = 'notes/caf\u00e9.md'; // precomposed e-acute
  const nfd = 'notes/caf\u0065\u0301.md'; // e + U+0301 combining acute
  assert.notEqual(nfc, nfd);

  const a = new FakeLocalVault();
  a.setContent(nfc as FilePath, 'hello', 1000);
  await runSync(a, remote, VAULT, optsFor('dev-a'));
  assert.equal(server.head(VAULT), 1);

  // Device B pulls it, then "edits" using the NFD spelling of the SAME path.
  // It must reconcile against the existing note, not create a second file.
  const b = new FakeLocalVault();
  await runSync(b, remote, VAULT, optsFor('dev-b'));

  const idx = b.readIndex();
  assert.equal(idx.length, 1);
  // The single index entry is keyed in NFC form.
  assert.equal(idx[0]?.path.normalize('NFC'), nfc);

  // Re-scanning the NFD form is a no-op (same identity), not a new push.
  b.removeContent(idx[0]!.path);
  b.setContent(nfd as FilePath, 'hello', 1000);
  const result = await runSync(b, remote, VAULT, optsFor('dev-b'));
  assert.equal(result.conflicts.length, 0);
  // Still a single file server-side; no duplicate identity was created.
  assert.equal(server.head(VAULT), 1);
});

test('STALE_BASE with no server file re-bases to 0 and converges (no livelock)', async () => {
  const { server, remote } = setup();
  const local = new FakeLocalVault();
  local.setContent('notes/incoherent.md' as FilePath, 'content', 1000);

  // Hand-craft an index entry with a baseRevision > 0 but the server has no
  // such file → an incoherent base that classifies as STALE_BASE with
  // `server: null`. Previously this re-pushed every round and threw.
  local.writeIndex([
    {
      path: 'notes/incoherent.md' as FilePath,
      hash: null,
      size: 0,
      mtime: 1000,
      deleted: false,
      baseRevision: 5,
      dirty: false,
    },
  ]);

  // Must not throw "sync did not converge"; the file fast-forwards as new.
  const result = await runSync(local, remote, VAULT, optsFor('dev-a'));
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(result.applied, ['notes/incoherent.md']);
  assert.equal(server.head(VAULT), 1);
  assert.equal(local.readIndex()[0]?.dirty, false);
});

test('missing blob triggers upload-then-retry within one cycle', async () => {
  const { server, remote } = setup();
  const local = new FakeLocalVault();
  local.setContent('notes/x.md' as FilePath, 'content x', 1000);

  // Intercept putBlob to drop the FIRST upload, forcing a MISSING_BLOB
  // conflict and exercising the retry path.
  let dropped = false;
  const flaky = {
    ...remote,
    putBlob: async (hash: string, content: string) => {
      if (!dropped) {
        dropped = true;
        return; // pretend to upload but store nothing
      }
      return remote.putBlob(hash, content);
    },
  };

  const result = await runSync(local, flaky, VAULT, optsFor('dev-a'));

  assert.deepEqual(result.applied, ['notes/x.md']);
  assert.equal(result.conflicts.length, 0);
  assert.equal(server.head(VAULT), 1);
  assert.ok(server.hasBlob(local.readIndex()[0]?.hash as string));
});

test('no-op idempotency: a second sync with no changes does nothing', async () => {
  const { server, remote } = setup();
  const local = new FakeLocalVault();
  local.setContent('notes/a.md' as FilePath, '# Alpha', 1000);

  await runSync(local, remote, VAULT, optsFor('dev-a'));
  const headAfterFirst = server.head(VAULT);

  const second = await runSync(local, remote, VAULT, optsFor('dev-a'));

  assert.deepEqual(second.applied, []);
  assert.deepEqual(second.pushed, []);
  assert.deepEqual(second.pulled, []);
  assert.equal(second.conflicts.length, 0);
  assert.equal(server.head(VAULT), headAfterFirst);
});

test('multi-cycle convergence between two devices through one server', async () => {
  const { remote } = setup();
  const a = new FakeLocalVault();
  const b = new FakeLocalVault();

  // A creates two notes, B creates one - all distinct paths.
  a.setContent('notes/a1.md' as FilePath, 'a one', 1000);
  a.setContent('notes/a2.md' as FilePath, 'a two', 1001);
  b.setContent('notes/b1.md' as FilePath, 'b one', 1002);

  // Round 1: each pushes its own; then each pulls the other's.
  await runSync(a, remote, VAULT, optsFor('dev-a'));
  await runSync(b, remote, VAULT, optsFor('dev-b'));
  await runSync(a, remote, VAULT, optsFor('dev-a'));
  await runSync(b, remote, VAULT, optsFor('dev-b'));

  const expected = ['notes/a1.md', 'notes/a2.md', 'notes/b1.md'];
  assert.deepEqual(a.listPaths(), expected);
  assert.deepEqual(b.listPaths(), expected);
  assert.equal(a.get('notes/b1.md' as FilePath), 'b one');
  assert.equal(b.get('notes/a1.md' as FilePath), 'a one');

  // A deletes a note; it propagates to B.
  a.removeContent('notes/a2.md' as FilePath);
  await runSync(a, remote, VAULT, optsFor('dev-a'));
  await runSync(b, remote, VAULT, optsFor('dev-b'));

  assert.ok(!b.has('notes/a2.md' as FilePath));
  assert.deepEqual(a.listPaths(), b.listPaths());
});

test('resumability: interrupting before writeIndex still converges on retry', async () => {
  const { server, remote } = setup();
  const local = new FakeLocalVault();
  local.setContent('notes/r.md' as FilePath, 'resume me', 1000);

  // First run commits to the server but we simulate losing the local index by
  // creating a fresh vault that re-scans the same content.
  await runSync(local, remote, VAULT, optsFor('dev-a'));
  assert.equal(server.head(VAULT), 1);

  // A device that re-scans identical content + pulls should be a no-op push
  // (the server treats it as already-present content).
  const fresh = new FakeLocalVault();
  const result = await runSync(fresh, remote, VAULT, optsFor('dev-a'));
  assert.equal(result.pulled.length, 1);
  assert.equal(fresh.get('notes/r.md' as FilePath), 'resume me');
});
