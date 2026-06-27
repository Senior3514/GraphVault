/**
 * Tests for registerFlushOnExit (fix #3 - flush-on-close listeners wired).
 *
 * We stub minimal `window`/`document` event targets so the helper's listener
 * wiring is exercised in Node.
 */

import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';

import { registerFlushOnExit } from './flushOnExit';

interface FakeTarget {
  listeners: Map<string, Set<(e: unknown) => void>>;
  addEventListener(type: string, fn: (e: unknown) => void): void;
  removeEventListener(type: string, fn: (e: unknown) => void): void;
  dispatch(type: string, e?: unknown): void;
}

function makeTarget(): FakeTarget {
  const listeners = new Map<string, Set<(e: unknown) => void>>();
  return {
    listeners,
    addEventListener(type, fn) {
      let set = listeners.get(type);
      if (!set) {
        set = new Set();
        listeners.set(type, set);
      }
      set.add(fn);
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    dispatch(type, e) {
      for (const fn of listeners.get(type) ?? []) fn(e);
    },
  };
}

const g = globalThis as Record<string, unknown>;

afterEach(() => {
  delete g.window;
  delete g.document;
});

test('flushes on beforeunload', () => {
  const win = makeTarget();
  const doc = makeTarget();
  (doc as unknown as { visibilityState: string }).visibilityState = 'visible';
  g.window = win;
  g.document = doc;

  let flushed = 0;
  const cleanup = registerFlushOnExit(() => flushed++);

  win.dispatch('beforeunload');
  assert.equal(flushed, 1, 'beforeunload should flush');

  cleanup();
});

test('flushes on visibilitychange when hidden, not when visible', () => {
  const win = makeTarget();
  const doc = makeTarget() as FakeTarget & { visibilityState: string };
  g.window = win;
  g.document = doc;

  let flushed = 0;
  const cleanup = registerFlushOnExit(() => flushed++);

  doc.visibilityState = 'visible';
  doc.dispatch('visibilitychange');
  assert.equal(flushed, 0, 'no flush while visible');

  doc.visibilityState = 'hidden';
  doc.dispatch('visibilitychange');
  assert.equal(flushed, 1, 'flush when hidden');

  cleanup();
});

test('cleanup removes both listeners', () => {
  const win = makeTarget();
  const doc = makeTarget() as FakeTarget & { visibilityState: string };
  doc.visibilityState = 'hidden';
  g.window = win;
  g.document = doc;

  let flushed = 0;
  const cleanup = registerFlushOnExit(() => flushed++);
  cleanup();

  win.dispatch('beforeunload');
  doc.dispatch('visibilitychange');
  assert.equal(flushed, 0, 'no flush after cleanup');
  assert.equal(win.listeners.get('beforeunload')?.size ?? 0, 0);
  assert.equal(doc.listeners.get('visibilitychange')?.size ?? 0, 0);
});

test('SSR-safe: returns a no-op when window/document are absent', () => {
  delete g.window;
  delete g.document;
  const cleanup = registerFlushOnExit(() => {
    throw new Error('should not be called');
  });
  assert.equal(typeof cleanup, 'function');
  cleanup(); // must not throw
});
