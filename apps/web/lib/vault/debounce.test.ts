/**
 * Tests for the `debounce` function.
 *
 * `useDebounce` is a React hook tested via render behaviour; it is covered
 * by the SearchBox integration. Here we exercise the pure `debounce` helper
 * that can be tested synchronously using fake timers.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { debounce } from './debounce';

// Minimal fake-timer harness that works in Node without any dependency.
function withFakeTimers(fn: (clock: { tick(ms: number): void }) => void): void {
  const callbacks: { at: number; cb: () => void }[] = [];
  let now = 0;

  const origSetTimeout = global.setTimeout;
  const origClearTimeout = global.clearTimeout;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).setTimeout = (cb: () => void, delay: number) => {
    const id = { at: now + delay, cb } as (typeof callbacks)[0] & { _id: symbol };
    id._id = Symbol();
    callbacks.push(id);
    // Return something clearable by matching reference.
    return id as unknown as ReturnType<typeof setTimeout>;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (global as any).clearTimeout = (id: unknown) => {
    const idx = callbacks.indexOf(id as (typeof callbacks)[0]);
    if (idx !== -1) callbacks.splice(idx, 1);
  };

  try {
    fn({
      tick(ms: number) {
        now += ms;
        const due = callbacks.filter((c) => c.at <= now);
        for (const d of due) {
          const idx = callbacks.indexOf(d);
          if (idx !== -1) {
            callbacks.splice(idx, 1);
            d.cb();
          }
        }
      },
    });
  } finally {
    global.setTimeout = origSetTimeout;
    global.clearTimeout = origClearTimeout;
  }
}

test('debounce: fires after delay with the last args', () => {
  withFakeTimers(({ tick }) => {
    const calls: number[] = [];
    const fn = debounce((n: number) => calls.push(n), 100);

    fn(1);
    fn(2);
    fn(3);

    // No call yet (timer still pending).
    assert.deepEqual(calls, []);

    tick(100);
    assert.deepEqual(calls, [3]);
  });
});

test('debounce: resets timer on each call', () => {
  withFakeTimers(({ tick }) => {
    const calls: number[] = [];
    const fn = debounce((n: number) => calls.push(n), 100);

    fn(1);
    tick(50); // 50 ms in — not fired
    fn(2); // reset
    tick(50); // 100 ms from start, only 50 from last call — not fired
    assert.deepEqual(calls, []);
    tick(50); // now 100 ms from the second call
    assert.deepEqual(calls, [2]);
  });
});

test('debounce: cancel prevents the queued call', () => {
  withFakeTimers(({ tick }) => {
    const calls: number[] = [];
    const fn = debounce((n: number) => calls.push(n), 100);

    fn(1);
    fn.cancel();
    tick(200);

    assert.deepEqual(calls, []);
  });
});

test('debounce: fires again after cancel if called again', () => {
  withFakeTimers(({ tick }) => {
    const calls: number[] = [];
    const fn = debounce((n: number) => calls.push(n), 100);

    fn(1);
    fn.cancel();
    fn(2);
    tick(100);

    assert.deepEqual(calls, [2]);
  });
});

test('debounce: multiple independent invocations in series', () => {
  withFakeTimers(({ tick }) => {
    const calls: string[] = [];
    const fn = debounce((s: string) => calls.push(s), 50);

    fn('a');
    tick(50);
    fn('b');
    tick(50);

    assert.deepEqual(calls, ['a', 'b']);
  });
});
