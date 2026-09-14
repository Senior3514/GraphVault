/**
 * Tests for TauriStorageAdapter.
 *
 * The real `@tauri-apps/api` / `@tauri-apps/plugin-fs` packages only work
 * inside an actual Tauri webview (they throw when the native IPC bridge is
 * absent), so load/save/clear/pickFolder are exercised here against an
 * in-memory fake filesystem installed via the `_setFsForTesting` /
 * `_setInvokeForTesting` test seams - the same override-for-testing pattern
 * already used elsewhere in this module (e.g. `_resetRegistry` in
 * `./index.ts`).
 */

import assert from 'node:assert/strict';
import { test, beforeEach, afterEach } from 'node:test';
import {
  TauriStorageAdapter,
  isTauriRuntime,
  _setFsForTesting,
  _setInvokeForTesting,
} from './tauriAdapter';
import type { Note } from '../types';

// ---------------------------------------------------------------------------
// In-memory fake `@tauri-apps/plugin-fs`
// ---------------------------------------------------------------------------

interface FakeEntry {
  name: string;
  isDirectory: boolean;
  isFile: boolean;
}

function makeFakeFs(initial: Record<string, string> = {}) {
  // path -> content, directories are implicit from path segments.
  const files = new Map<string, string>(Object.entries(initial));

  function childrenOf(dir: string): FakeEntry[] {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    const seen = new Map<string, FakeEntry>();
    for (const path of files.keys()) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const [name, ...more] = rest.split('/');
      if (!seen.has(name)) {
        seen.set(name, { name, isDirectory: more.length > 0, isFile: more.length === 0 });
      }
    }
    return [...seen.values()];
  }

  const watchCalls: Array<{ path: string; cb: () => void; options?: unknown }> = [];
  const unwatchCalls: number[] = [];

  const fake = {
    async readDir(dir: string) {
      return childrenOf(dir);
    },
    async readTextFile(path: string) {
      if (!files.has(path)) throw new Error(`ENOENT: ${path}`);
      return files.get(path)!;
    },
    async mkdir() {
      // Directories are implicit; nothing to track.
    },
    async writeTextFile(path: string, content: string) {
      files.set(path, content);
    },
    async remove(path: string) {
      if (!files.delete(path)) throw new Error(`ENOENT: ${path}`);
    },
    async watch(path: string, cb: () => void, options?: unknown) {
      watchCalls.push({ path, cb, options });
      return () => {
        unwatchCalls.push(watchCalls.length - 1);
      };
    },
  };

  return { fake, files, watchCalls, unwatchCalls };
}

function makeNote(path: string, content = '# Test'): Note {
  return { path, content, mtime: 1_000_000, ctime: 1_000_000 };
}

beforeEach(() => {
  (globalThis as Record<string, unknown>)['window'] = {};
});

afterEach(() => {
  _setFsForTesting(null);
  _setInvokeForTesting(null);
  delete (globalThis as Record<string, unknown>)['window'];
});

// ---------------------------------------------------------------------------
// isTauriRuntime
// ---------------------------------------------------------------------------

test('isTauriRuntime is false without window.__TAURI__', () => {
  assert.equal(isTauriRuntime(), false);
});

test('isTauriRuntime is true once __TAURI__ is present on window', () => {
  (globalThis as Record<string, unknown>)['window'] = { __TAURI__: {} };
  assert.equal(isTauriRuntime(), true);
});

// ---------------------------------------------------------------------------
// isAvailable
// ---------------------------------------------------------------------------

test('isAvailable is false outside Tauri even with a vault path set', () => {
  const adapter = new TauriStorageAdapter('/home/user/vault');
  assert.equal(adapter.isAvailable(), false);
});

test('isAvailable is false inside Tauri until a vault path is set', () => {
  (globalThis as Record<string, unknown>)['window'] = { __TAURI__: {} };
  const adapter = new TauriStorageAdapter();
  assert.equal(adapter.isAvailable(), false);
});

test('isAvailable is true inside Tauri once a vault path is set', () => {
  (globalThis as Record<string, unknown>)['window'] = { __TAURI__: {} };
  const adapter = new TauriStorageAdapter('/home/user/vault');
  assert.equal(adapter.isAvailable(), true);
});

// ---------------------------------------------------------------------------
// pickFolder
// ---------------------------------------------------------------------------

test('pickFolder returns null when the user dismisses the dialog', async () => {
  _setInvokeForTesting(async () => null);
  const adapter = await TauriStorageAdapter.pickFolder();
  assert.equal(adapter, null);
});

test('pickFolder returns a configured adapter with the chosen path', async () => {
  _setInvokeForTesting(async () => '/home/user/MyVault');
  const adapter = await TauriStorageAdapter.pickFolder();
  assert.ok(adapter);
  assert.equal(adapter!.path, '/home/user/MyVault');
});

// ---------------------------------------------------------------------------
// load / save / clear round-trip
// ---------------------------------------------------------------------------

test('save then load round-trips nested notes intact', async () => {
  const { fake } = makeFakeFs();
  _setFsForTesting(fake as unknown as Parameters<typeof _setFsForTesting>[0]);

  const adapter = new TauriStorageAdapter('/vault');
  const notes = [makeNote('root.md', '# Root'), makeNote('ideas/brainstorm.md', '# Ideas')];
  await adapter.save(notes);

  const loaded = await adapter.load();
  const byPath = new Map(loaded.map((n) => [n.path, n.content]));
  assert.equal(byPath.get('root.md'), '# Root');
  assert.equal(byPath.get('ideas/brainstorm.md'), '# Ideas');
  assert.equal(loaded.length, 2);
});

test('load surfaces an unreadable file as an error-marker note instead of dropping it', async () => {
  const { fake, files } = makeFakeFs({ '/vault/broken.md': 'placeholder' });
  const brokenRead = fake.readTextFile;
  fake.readTextFile = async (path: string) => {
    if (path === '/vault/broken.md') throw new Error('permission denied');
    return brokenRead(path);
  };
  _setFsForTesting(fake as unknown as Parameters<typeof _setFsForTesting>[0]);
  void files;

  const adapter = new TauriStorageAdapter('/vault');
  const loaded = await adapter.load();
  assert.equal(loaded.length, 1);
  assert.match(loaded[0]!.content, /failed to read file "broken\.md"/);
});

test('clear removes every previously-loaded file', async () => {
  const { fake, files } = makeFakeFs();
  _setFsForTesting(fake as unknown as Parameters<typeof _setFsForTesting>[0]);

  const adapter = new TauriStorageAdapter('/vault');
  await adapter.save([makeNote('a.md'), makeNote('b.md')]);
  assert.equal(files.size, 2);

  await adapter.clear();
  assert.equal(files.size, 0);
});

test('load/save/clear throw a clear error when no vault path is configured', async () => {
  const { fake } = makeFakeFs();
  _setFsForTesting(fake as unknown as Parameters<typeof _setFsForTesting>[0]);

  const adapter = new TauriStorageAdapter();
  await assert.rejects(() => adapter.load(), /no vault path configured/);
  await assert.rejects(() => adapter.save([makeNote('a.md')]), /no vault path configured/);
  // clear() swallows load() failures (partial-clear-is-better contract), so it
  // resolves rather than rejecting when there's no path configured yet.
  await adapter.clear();
});

// ---------------------------------------------------------------------------
// setVaultPath
// ---------------------------------------------------------------------------

test('setVaultPath replaces the configured path', () => {
  const adapter = new TauriStorageAdapter('/old');
  adapter.setVaultPath('/new');
  assert.equal(adapter.path, '/new');
  adapter.setVaultPath(null);
  assert.equal(adapter.path, null);
});

// ---------------------------------------------------------------------------
// watch
// ---------------------------------------------------------------------------

test('watch registers a recursive, debounced watch on the vault root', async () => {
  const { fake, watchCalls } = makeFakeFs();
  _setFsForTesting(fake as unknown as Parameters<typeof _setFsForTesting>[0]);

  const adapter = new TauriStorageAdapter('/vault');
  await adapter.watch(() => {});

  assert.equal(watchCalls.length, 1);
  assert.equal(watchCalls[0]!.path, '/vault');
  assert.deepEqual(watchCalls[0]!.options, { recursive: true, delayMs: 800 });
});

test('watch invokes onChange when the underlying fs event fires', async () => {
  const { fake, watchCalls } = makeFakeFs();
  _setFsForTesting(fake as unknown as Parameters<typeof _setFsForTesting>[0]);

  const adapter = new TauriStorageAdapter('/vault');
  let changeCount = 0;
  await adapter.watch(() => {
    changeCount += 1;
  });

  watchCalls[0]!.cb();
  watchCalls[0]!.cb();
  assert.equal(changeCount, 2);
});

test('watch returns a working unwatch function', async () => {
  const { fake, unwatchCalls } = makeFakeFs();
  _setFsForTesting(fake as unknown as Parameters<typeof _setFsForTesting>[0]);

  const adapter = new TauriStorageAdapter('/vault');
  const unwatch = await adapter.watch(() => {});
  assert.equal(unwatchCalls.length, 0);
  unwatch();
  assert.equal(unwatchCalls.length, 1);
});

test('watch throws a clear error when no vault path is configured', async () => {
  const { fake } = makeFakeFs();
  _setFsForTesting(fake as unknown as Parameters<typeof _setFsForTesting>[0]);

  const adapter = new TauriStorageAdapter();
  await assert.rejects(() => adapter.watch(() => {}), /no vault path configured/);
});
