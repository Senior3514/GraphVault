/**
 * AiResponseCache tests - the Backend DNA in-memory cache for buffered AI
 * chat responses (see services/aiCache.ts).
 *
 * Tests:
 *  1. get() returns undefined for a key that was never set
 *  2. set() then get() returns the exact cached value
 *  3. key() is deterministic for identical inputs
 *  4. key() differs when userId, model, or messages differ (no cross-user or
 *     cross-model bleed)
 *  5. an entry expires after its TTL elapses
 *  6. a bounded cache evicts the oldest entry once at capacity (FIFO)
 *  7. size reflects the current entry count, including after eviction/expiry
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { AiResponseCache } from '../src/services/aiCache.js';

test('get returns undefined for a key that was never set', () => {
  const cache = new AiResponseCache();
  assert.equal(cache.get('missing'), undefined);
});

test('set then get returns the exact cached value', () => {
  const cache = new AiResponseCache();
  const key = AiResponseCache.key('user-1', 'gpt-4', [{ role: 'user', content: 'hi' }]);
  const value = { content: 'hello back', model: 'gpt-4', usage: { costUsd: 0.001 } };
  cache.set(key, value);
  assert.deepEqual(cache.get(key), value);
});

test('key() is deterministic for identical inputs', () => {
  const messages = [{ role: 'user', content: 'summarise this note' }];
  const a = AiResponseCache.key('user-1', 'gpt-4', messages);
  const b = AiResponseCache.key('user-1', 'gpt-4', messages);
  assert.equal(a, b);
});

test('key() differs across users, models, and messages', () => {
  const messages = [{ role: 'user', content: 'summarise this note' }];
  const base = AiResponseCache.key('user-1', 'gpt-4', messages);
  assert.notEqual(base, AiResponseCache.key('user-2', 'gpt-4', messages));
  assert.notEqual(base, AiResponseCache.key('user-1', 'gpt-3.5', messages));
  assert.notEqual(
    base,
    AiResponseCache.key('user-1', 'gpt-4', [{ role: 'user', content: 'different prompt' }]),
  );
});

test('an entry expires after its TTL elapses', async () => {
  const cache = new AiResponseCache(30); // 30ms TTL
  const key = AiResponseCache.key('user-1', 'gpt-4', ['hi']);
  cache.set(key, { content: 'x' });
  assert.deepEqual(cache.get(key), { content: 'x' });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(cache.get(key), undefined);
});

test('a bounded cache evicts the oldest entry once at capacity (FIFO)', () => {
  const cache = new AiResponseCache(60_000, 2);
  const k1 = AiResponseCache.key('user-1', 'gpt-4', ['one']);
  const k2 = AiResponseCache.key('user-1', 'gpt-4', ['two']);
  const k3 = AiResponseCache.key('user-1', 'gpt-4', ['three']);

  cache.set(k1, { content: '1' });
  cache.set(k2, { content: '2' });
  assert.equal(cache.size, 2);

  cache.set(k3, { content: '3' });
  assert.equal(cache.size, 2);
  assert.equal(cache.get(k1), undefined, 'oldest entry should have been evicted');
  assert.deepEqual(cache.get(k2), { content: '2' });
  assert.deepEqual(cache.get(k3), { content: '3' });
});

test('size reflects the current entry count, including after expiry', async () => {
  const cache = new AiResponseCache(30);
  const key = AiResponseCache.key('user-1', 'gpt-4', ['hi']);
  assert.equal(cache.size, 0);
  cache.set(key, { content: 'x' });
  assert.equal(cache.size, 1);
  await new Promise((r) => setTimeout(r, 60));
  // get() lazily evicts the expired entry.
  cache.get(key);
  assert.equal(cache.size, 0);
});
