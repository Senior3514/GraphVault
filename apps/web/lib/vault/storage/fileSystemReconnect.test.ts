import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  clearDirectoryHandle,
  loadDirectoryHandle,
  saveDirectoryHandle,
} from './handleStore';

// ---------------------------------------------------------------------------
// handleStore — must degrade gracefully without IndexedDB (Node / SSR).
// ---------------------------------------------------------------------------

test('handleStore degrades gracefully when IndexedDB is unavailable', async () => {
  // Node has no global indexedDB; all ops are best-effort no-ops.
  assert.equal(typeof (globalThis as { indexedDB?: unknown }).indexedDB, 'undefined');
  assert.equal(await saveDirectoryHandle({ fake: true }), false);
  assert.equal(await loadDirectoryHandle(), null);
  await clearDirectoryHandle(); // must not throw
});

// ---------------------------------------------------------------------------
// verifyPermission — reconnect permission logic for a stored handle.
// ---------------------------------------------------------------------------

type Perm = 'granted' | 'denied' | 'prompt';

function fakeHandle(opts: {
  query?: Perm;
  request?: Perm;
  hasQuery?: boolean;
  throwOnQuery?: boolean;
}): unknown {
  return {
    kind: 'directory',
    name: 'vault',
    queryPermission:
      opts.hasQuery === false
        ? undefined
        : async () => {
            if (opts.throwOnQuery) throw new Error('boom');
            return opts.query ?? 'prompt';
          },
    requestPermission: async () => opts.request ?? 'prompt',
  };
}

test('verifyPermission returns granted when already granted (no request needed)', async () => {
  const { verifyPermission } = await import('./fileSystemAdapter');
  const state = await verifyPermission(
    fakeHandle({ query: 'granted' }) as never,
    /* request */ false,
  );
  assert.equal(state, 'granted');
});

test('verifyPermission stays prompt when not requesting', async () => {
  const { verifyPermission } = await import('./fileSystemAdapter');
  const state = await verifyPermission(fakeHandle({ query: 'prompt' }) as never, false);
  assert.equal(state, 'prompt');
});

test('verifyPermission requests when prompt + request=true and returns the grant', async () => {
  const { verifyPermission } = await import('./fileSystemAdapter');
  const state = await verifyPermission(
    fakeHandle({ query: 'prompt', request: 'granted' }) as never,
    true,
  );
  assert.equal(state, 'granted');
});

test('verifyPermission returns denied when query is denied', async () => {
  const { verifyPermission } = await import('./fileSystemAdapter');
  const state = await verifyPermission(fakeHandle({ query: 'denied' }) as never, true);
  assert.equal(state, 'denied');
});

test('verifyPermission assumes granted when the permission API is absent', async () => {
  const { verifyPermission } = await import('./fileSystemAdapter');
  const state = await verifyPermission(fakeHandle({ hasQuery: false }) as never, false);
  assert.equal(state, 'granted');
});

test('verifyPermission treats a thrown query as denied (no crash)', async () => {
  const { verifyPermission } = await import('./fileSystemAdapter');
  const state = await verifyPermission(fakeHandle({ throwOnQuery: true }) as never, true);
  assert.equal(state, 'denied');
});

// ---------------------------------------------------------------------------
// restore() — returns null when nothing is persisted (no IDB in Node).
// ---------------------------------------------------------------------------

test('FileSystemAdapter.restore returns null with no API / no stored handle', async () => {
  const { FileSystemAdapter } = await import('./fileSystemAdapter');
  assert.equal(await FileSystemAdapter.restore(false), null);
  assert.equal(await FileSystemAdapter.hasPersistedHandle(), false);
});
