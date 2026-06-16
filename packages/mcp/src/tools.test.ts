/**
 * Tool-handler tests against an in-memory fake set of notes.
 *
 * Each test builds a real engine index from a handful of markdown notes (no
 * network, no server), then exercises the pure tool handlers and the
 * TTL-cached VaultManager via a fake client.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIndex, type NoteInput } from '@graphvault/engine';
import type { FilePath, FileState, VaultRef } from '@graphvault/shared';
import {
  backlinksFor,
  bindTools,
  graphNeighbors,
  listNotes,
  readNote,
  searchNotes,
  vaultStats,
} from './tools.js';
import { latestMarkdownStates, VaultManager, type VaultSnapshot } from './vault.js';
import type { GraphVaultClient } from './client.js';
import type { McpConfig } from './config.js';

const NOTES: Array<{ path: string; content: string; mtime: number }> = [
  {
    path: 'index.md',
    content: '---\ntitle: Home\n---\n# Home\n\nSee [[graphs]] and [[missing-note]]. #start',
    mtime: 10,
  },
  {
    path: 'notes/graphs.md',
    content: '# Graph Theory\n\nNotes about graphs and edges. #math #graphs\n\nBack to [[Home]].',
    mtime: 20,
  },
  {
    path: 'notes/algorithms.md',
    content: '# Algorithms\n\nDijkstra over a [[graphs|graph]]. #math',
    mtime: 30,
  },
];

/** Build a VaultSnapshot directly from the fake notes. */
function makeSnapshot(): VaultSnapshot {
  const inputs: NoteInput[] = NOTES.map((n) => ({
    path: n.path as FilePath,
    content: n.content,
    updatedAt: n.mtime,
  }));
  const index = buildIndex(inputs);
  const contentByPath = new Map<string, string>(NOTES.map((n) => [n.path, n.content]));
  return {
    index,
    contentByPath,
    notes: NOTES.map((n) => ({ path: n.path as FilePath, content: n.content, mtime: n.mtime })),
    builtAt: 0,
  };
}

test('listNotes returns all summaries sorted by path', () => {
  const snap = makeSnapshot();
  const out = listNotes(snap, {});
  assert.deepEqual(
    out.map((n) => n.path),
    ['index.md', 'notes/algorithms.md', 'notes/graphs.md'],
  );
  const graphs = out.find((n) => n.path === 'notes/graphs.md');
  assert.deepEqual(graphs?.tags.sort(), ['graphs', 'math']);
});

test('listNotes filters by a case-insensitive substring of path/title', () => {
  const snap = makeSnapshot();
  const byPath = listNotes(snap, { query: 'ALGO' });
  assert.deepEqual(
    byPath.map((n) => n.path),
    ['notes/algorithms.md'],
  );
  const byTitle = listNotes(snap, { query: 'graph theory' });
  assert.deepEqual(
    byTitle.map((n) => n.path),
    ['notes/graphs.md'],
  );
});

test('listNotes respects the limit', () => {
  const snap = makeSnapshot();
  assert.equal(listNotes(snap, { limit: 2 }).length, 2);
});

test('readNote returns raw markdown and throws on a missing path', () => {
  const snap = makeSnapshot();
  assert.match(readNote(snap, 'notes/graphs.md'), /# Graph Theory/);
  assert.throws(() => readNote(snap, 'nope.md'), /Note not found/);
});

test('searchNotes matches title, tags, body, and links', () => {
  const snap = makeSnapshot();

  const byBody = searchNotes(snap, { query: 'Dijkstra' });
  assert.deepEqual(
    byBody.map((r) => r.path),
    ['notes/algorithms.md'],
  );
  assert.ok(byBody[0]?.matched.includes('body'));

  const byTag = searchNotes(snap, { query: 'math' });
  assert.deepEqual(byTag.map((r) => r.path).sort(), ['notes/algorithms.md', 'notes/graphs.md']);
  assert.ok(byTag.every((r) => r.matched.includes('tags')));

  const byTitle = searchNotes(snap, { query: 'home' });
  assert.ok(byTitle.some((r) => r.path === 'index.md' && r.matched.includes('title')));
});

test('searchNotes returns [] for an empty query', () => {
  assert.deepEqual(searchNotes(makeSnapshot(), { query: '   ' }), []);
});

test('backlinksFor returns notes linking to the target', () => {
  const snap = makeSnapshot();
  const backs = backlinksFor(snap, 'notes/graphs.md');
  const sources = backs.map((b) => b.path).sort();
  assert.deepEqual(sources, ['index.md', 'notes/algorithms.md']);
  // the algorithms note used an alias [[graphs|graph]].
  const aliased = backs.find((b) => b.path === 'notes/algorithms.md');
  assert.equal(aliased?.alias, 'graph');
  assert.throws(() => backlinksFor(snap, 'missing.md'), /Note not found/);
});

test('graphNeighbors returns the local subgraph, clamping depth', () => {
  const snap = makeSnapshot();
  const g = graphNeighbors(snap, { path: 'notes/graphs.md', depth: 1 });
  assert.equal(g.root, 'notes/graphs.md');
  const paths = g.nodes.map((n) => n.path).sort();
  // graphs links Home, and is backlinked from index + algorithms.
  assert.ok(paths.includes('index.md'));
  assert.ok(paths.includes('notes/algorithms.md'));

  // Depth is clamped to MAX_DEPTH (4); a huge value must not throw.
  const clamped = graphNeighbors(snap, { path: 'index.md', depth: 999 });
  assert.equal(clamped.depth, 4);

  assert.throws(() => graphNeighbors(snap, { path: 'missing.md' }), /Note not found/);
});

test('vaultStats counts notes, tags, links and unresolved', () => {
  const snap = makeSnapshot();
  const stats = vaultStats(snap);
  assert.equal(stats.notes, 3);
  // distinct tags: start, math, graphs.
  assert.equal(stats.tags, 3);
  // index -> graphs, index -> missing (unresolved), graphs -> Home, algorithms -> graphs.
  assert.ok(stats.links >= 4);
  assert.equal(stats.unresolved, 1);
});

// ---------------------------------------------------------------------------
// VaultManager: id resolution + TTL caching via a fake client.
// ---------------------------------------------------------------------------

/** A minimal fake GraphVaultClient backed by in-memory fixtures. */
class FakeClient {
  listVaultsCalls = 0;
  listStatesCalls = 0;
  constructor(
    private readonly vaults: VaultRef[],
    private readonly states: FileState[],
    private readonly blobs: Map<string, string>,
  ) {}
  async listVaults(): Promise<VaultRef[]> {
    this.listVaultsCalls++;
    return this.vaults;
  }
  async listAllFileStates(): Promise<FileState[]> {
    this.listStatesCalls++;
    return this.states;
  }
  async getBlobText(hash: string): Promise<string> {
    const v = this.blobs.get(hash);
    if (v === undefined) throw new Error(`no blob ${hash}`);
    return v;
  }
}

function asClient(fake: FakeClient): GraphVaultClient {
  return fake as unknown as GraphVaultClient;
}

function makeConfig(over: Partial<McpConfig>): McpConfig {
  return {
    serverUrl: 'https://x',
    token: 't',
    vaultId: undefined,
    vaultName: undefined,
    indexTtlMs: 1000,
    ...over,
  };
}

test('latestMarkdownStates keeps the newest non-deleted markdown per path', () => {
  const states: FileState[] = [
    { path: 'a.md', hash: 'sha256:1', size: 1, mtime: 1, deleted: false, revision: 1 },
    { path: 'a.md', hash: 'sha256:2', size: 1, mtime: 2, deleted: false, revision: 3 },
    { path: 'b.md', hash: null, size: 0, mtime: 1, deleted: true, revision: 2 },
    { path: 'c.txt', hash: 'sha256:3', size: 1, mtime: 1, deleted: false, revision: 1 },
  ];
  const live = latestMarkdownStates(states);
  assert.deepEqual(
    live.map((s) => [s.path, s.hash]),
    [['a.md', 'sha256:2']],
  );
});

test('VaultManager resolves a vault id by name', async () => {
  const fake = new FakeClient(
    [
      { id: 'v-personal', name: 'Personal' },
      { id: 'v-work', name: 'Work' },
    ],
    [],
    new Map(),
  );
  const manager = new VaultManager(asClient(fake), makeConfig({ vaultName: 'Work' }));
  assert.equal(await manager.resolveVaultId(), 'v-work');
  // cached: a second call does not re-list.
  await manager.resolveVaultId();
  assert.equal(fake.listVaultsCalls, 1);
});

test('VaultManager errors clearly when the named vault is absent', async () => {
  const fake = new FakeClient([{ id: 'v1', name: 'Personal' }], [], new Map());
  const manager = new VaultManager(asClient(fake), makeConfig({ vaultName: 'Nope' }));
  await assert.rejects(() => manager.resolveVaultId(), /No vault named "Nope"/);
});

test('VaultManager caches the snapshot within the TTL and rebuilds after it', async () => {
  let clock = 0;
  const states: FileState[] = [
    { path: 'a.md', hash: 'sha256:h1', size: 1, mtime: 1, deleted: false, revision: 1 },
  ];
  const fake = new FakeClient([], states, new Map([['sha256:h1', '# A\n#tag']]));
  const manager = new VaultManager(
    asClient(fake),
    makeConfig({ vaultId: 'v1', indexTtlMs: 100 }),
    () => clock,
  );

  const s1 = await manager.getSnapshot();
  const s2 = await manager.getSnapshot();
  assert.equal(s1, s2, 'same snapshot within TTL');
  assert.equal(fake.listStatesCalls, 1);

  clock = 200; // advance past the TTL
  const s3 = await manager.getSnapshot();
  assert.notEqual(s3, s1, 'rebuilt after TTL');
  assert.equal(fake.listStatesCalls, 2);
  // sanity: the rebuilt index contains the note.
  assert.ok(s3.contentByPath.has('a.md'));
});

test('bindTools wires the manager to handlers and refreshes the snapshot', async () => {
  const states: FileState[] = [
    { path: 'a.md', hash: 'sha256:h1', size: 1, mtime: 1, deleted: false, revision: 1 },
  ];
  const fake = new FakeClient([], states, new Map([['sha256:h1', '# A\n\nbody text']]));
  const manager = new VaultManager(asClient(fake), makeConfig({ vaultId: 'v1' }));
  const tools = bindTools(manager);

  const list = await tools.listNotes({});
  assert.deepEqual(
    list.map((n) => n.path),
    ['a.md'],
  );
  assert.equal(await tools.readNote('a.md'), '# A\n\nbody text');
  const stats = await tools.vaultStats();
  assert.equal(stats.notes, 1);
});
