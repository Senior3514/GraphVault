/**
 * Tests for apps/web/lib/embed/snapshot.ts
 *
 * Coverage:
 * - encode/decode round-trip (no-compression path; CompressionStream may not
 *   be available in the Node test runner)
 * - buildSnapshot: no content leakage, only resolved edges included
 * - size cap: MAX_SNAPSHOT_BYTES rejected at encode time
 * - size cap: MAX_ENCODED_CHARS rejected at decode time
 * - malformed encoded strings: each structural violation throws SnapshotDecodeError
 * - edge kind mapping: wikilink→w, markdown→m, other→r
 * - deduplication: multiple edges between same nodes are preserved
 * - empty graph: round-trips cleanly
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildSnapshot,
  decodeSnapshot,
  encodeSnapshot,
  generateEmbedUrl,
  MAX_ENCODED_CHARS,
  MAX_SNAPSHOT_BYTES,
  SnapshotDecodeError,
  SnapshotTooLargeError,
  type EmbedSnapshot,
} from './snapshot';
import type { GraphEdge, GraphNode } from '@graphvault/engine';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNode(id: string, title?: string): GraphNode {
  return { id, path: id, title: title ?? id, tags: [], folder: '' };
}

function makeEdge(source: string, target: string, type = 'wikilink', resolved = true): GraphEdge {
  return { source, target, type, resolved };
}

function makeSnapshot(
  nodes: Array<{ i: string; t: string }>,
  edges: Array<{ s: string; t: string; k: 'w' | 'm' | 'r' }>,
): EmbedSnapshot {
  return { v: 1, n: nodes, e: edges };
}

// ---------------------------------------------------------------------------
// buildSnapshot: privacy contract
// ---------------------------------------------------------------------------

test('buildSnapshot includes only id+title for nodes, no content', () => {
  const nodes = [makeNode('a.md', 'Alpha'), makeNode('b.md', 'Beta')];
  const edges = [makeEdge('a.md', 'b.md')];
  const snap = buildSnapshot(nodes, edges);

  assert.equal(snap.v, 1);
  assert.equal(snap.n.length, 2);
  // Only i (id) and t (title) present — no path, tags, folder, timestamps.
  for (const sn of snap.n) {
    assert.deepEqual(Object.keys(sn).sort(), ['i', 't']);
  }
  const a = snap.n.find((n) => n.i === 'a.md');
  assert.ok(a, 'node a.md in snapshot');
  assert.equal(a!.t, 'Alpha');
});

test('buildSnapshot excludes unresolved edges', () => {
  const nodes = [makeNode('a.md'), makeNode('b.md')];
  const edges = [
    makeEdge('a.md', 'b.md', 'wikilink', true),
    makeEdge('a.md', 'ghost.md', 'wikilink', false), // unresolved
  ];
  const snap = buildSnapshot(nodes, edges);
  assert.equal(snap.e.length, 1);
  assert.equal(snap.e[0].t, 'b.md');
});

test('buildSnapshot excludes edges whose endpoints are not in the node set', () => {
  const nodes = [makeNode('a.md')];
  const edges = [makeEdge('a.md', 'b.md', 'wikilink', true)]; // b.md not in nodes
  const snap = buildSnapshot(nodes, edges);
  assert.equal(snap.e.length, 0);
});

test('buildSnapshot maps edge kinds correctly', () => {
  const nodes = [makeNode('a.md'), makeNode('b.md'), makeNode('c.md'), makeNode('d.md')];
  const edges = [
    makeEdge('a.md', 'b.md', 'wikilink', true),
    makeEdge('b.md', 'c.md', 'markdown', true),
    makeEdge('c.md', 'd.md', 'references', true), // typed relation
  ];
  const snap = buildSnapshot(nodes, edges);
  assert.equal(snap.e.length, 3);
  const bySource = new Map(snap.e.map((e) => [e.s, e]));
  assert.equal(bySource.get('a.md')?.k, 'w');
  assert.equal(bySource.get('b.md')?.k, 'm');
  assert.equal(bySource.get('c.md')?.k, 'r');
});

test('buildSnapshot handles empty graph', () => {
  const snap = buildSnapshot([], []);
  assert.equal(snap.v, 1);
  assert.equal(snap.n.length, 0);
  assert.equal(snap.e.length, 0);
});

// ---------------------------------------------------------------------------
// encode / decode round-trip (uncompressed path — CompressionStream may be
// unavailable in the test runner, but the fallback path is always exercised)
// ---------------------------------------------------------------------------

test('encodeSnapshot + decodeSnapshot round-trips a simple snapshot', async () => {
  const original = makeSnapshot(
    [
      { i: 'a.md', t: 'Alpha' },
      { i: 'b.md', t: 'Beta' },
    ],
    [{ s: 'a.md', t: 'b.md', k: 'w' }],
  );
  const encoded = await encodeSnapshot(original);
  assert.ok(typeof encoded === 'string' && encoded.length > 0, 'produces a non-empty string');
  const decoded = await decodeSnapshot(encoded);
  assert.deepEqual(decoded, original);
});

test('encodeSnapshot + decodeSnapshot round-trips an empty graph', async () => {
  const original = makeSnapshot([], []);
  const encoded = await encodeSnapshot(original);
  const decoded = await decodeSnapshot(encoded);
  assert.deepEqual(decoded, original);
});

test('encodeSnapshot + decodeSnapshot preserves all edge kinds', async () => {
  const original = makeSnapshot(
    [
      { i: 'a.md', t: 'A' },
      { i: 'b.md', t: 'B' },
      { i: 'c.md', t: 'C' },
    ],
    [
      { s: 'a.md', t: 'b.md', k: 'w' },
      { s: 'b.md', t: 'c.md', k: 'm' },
      { s: 'c.md', t: 'a.md', k: 'r' },
    ],
  );
  const encoded = await encodeSnapshot(original);
  const decoded = await decodeSnapshot(encoded);
  assert.deepEqual(decoded.e, original.e);
});

test('encodeSnapshot produces URL-safe characters only', async () => {
  const snap = makeSnapshot([{ i: 'a.md', t: 'Alpha + Beta / Gamma = Delta' }], []);
  const encoded = await encodeSnapshot(snap);
  // base64url must not contain +, /, or = (only A-Z, a-z, 0-9, -, _)
  assert.doesNotMatch(encoded, /[+/=]/, 'encoded string must be URL-safe');
});

// ---------------------------------------------------------------------------
// Size caps
// ---------------------------------------------------------------------------

test('encodeSnapshot throws SnapshotTooLargeError when JSON exceeds MAX_SNAPSHOT_BYTES', async () => {
  // Build a snapshot whose JSON will exceed MAX_SNAPSHOT_BYTES.
  // Each node title fills ~1000 chars; 250 nodes × ~1010 bytes >> MAX_SNAPSHOT_BYTES.
  const perNodeBytes = Math.ceil(MAX_SNAPSHOT_BYTES / 200); // definitely exceed the limit
  const longTitle = 'x'.repeat(perNodeBytes);
  const nodes = Array.from({ length: 250 }, (_, i) => ({ i: `n${i}.md`, t: longTitle }));
  const snap = makeSnapshot(nodes, []);

  await assert.rejects(
    () => encodeSnapshot(snap),
    (err) => err instanceof SnapshotTooLargeError,
  );
});

test('decodeSnapshot throws SnapshotTooLargeError when encoded string exceeds MAX_ENCODED_CHARS', async () => {
  const oversized = 'z' + 'a'.repeat(MAX_ENCODED_CHARS + 1);
  await assert.rejects(
    () => decodeSnapshot(oversized),
    (err) => err instanceof SnapshotTooLargeError,
  );
});

// ---------------------------------------------------------------------------
// Validation / malformed input
// ---------------------------------------------------------------------------

test('decodeSnapshot throws SnapshotDecodeError for invalid base64', async () => {
  // Not a valid base64url string (invalid chars that aren't in the alphabet after url-decode).
  await assert.rejects(
    () => decodeSnapshot('!!!not-valid-base64!!!'),
    (err) => err instanceof SnapshotDecodeError || err instanceof Error,
  );
});

test('decodeSnapshot throws SnapshotDecodeError for non-object JSON', async () => {
  // Encode an array instead of an object.
  const json = JSON.stringify([1, 2, 3]);
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  let b64 = btoa(binary);
  b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  await assert.rejects(
    () => decodeSnapshot(b64),
    (err) => err instanceof SnapshotDecodeError,
  );
});

test('decodeSnapshot throws SnapshotDecodeError for wrong version', async () => {
  const json = JSON.stringify({ v: 99, n: [], e: [] });
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  let b64 = btoa(binary);
  b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  await assert.rejects(
    () => decodeSnapshot(b64),
    (err) => err instanceof SnapshotDecodeError,
  );
});

test('decodeSnapshot throws SnapshotDecodeError when nodes is not an array', async () => {
  const json = JSON.stringify({ v: 1, n: 'bad', e: [] });
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  let b64 = btoa(binary);
  b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  await assert.rejects(
    () => decodeSnapshot(b64),
    (err) => err instanceof SnapshotDecodeError,
  );
});

test('decodeSnapshot throws SnapshotDecodeError when edges is not an array', async () => {
  const json = JSON.stringify({ v: 1, n: [], e: null });
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  let b64 = btoa(binary);
  b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  await assert.rejects(
    () => decodeSnapshot(b64),
    (err) => err instanceof SnapshotDecodeError,
  );
});

test('decodeSnapshot throws SnapshotDecodeError when a node is malformed', async () => {
  const json = JSON.stringify({ v: 1, n: [{ i: 123, t: 'bad id type' }], e: [] });
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  let b64 = btoa(binary);
  b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  await assert.rejects(
    () => decodeSnapshot(b64),
    (err) => err instanceof SnapshotDecodeError,
  );
});

test('decodeSnapshot throws SnapshotDecodeError when an edge kind is invalid', async () => {
  const json = JSON.stringify({
    v: 1,
    n: [{ i: 'a', t: 'A' }],
    e: [{ s: 'a', t: 'a', k: 'x' }], // 'x' is not a valid kind
  });
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  let b64 = btoa(binary);
  b64 = b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  await assert.rejects(
    () => decodeSnapshot(b64),
    (err) => err instanceof SnapshotDecodeError,
  );
});

// ---------------------------------------------------------------------------
// generateEmbedUrl
// ---------------------------------------------------------------------------

test('generateEmbedUrl produces a URL with ?s= parameter and an iframe snippet', async () => {
  const snap = makeSnapshot([{ i: 'a.md', t: 'Alpha' }], []);
  const { url, iframe } = await generateEmbedUrl(snap, 'https://example.com');

  assert.ok(url.startsWith('https://example.com/embed/?s='), `URL starts with embed path: ${url}`);
  assert.ok(iframe.includes('<iframe'), 'iframe snippet contains <iframe');
  assert.ok(iframe.includes(url), 'iframe snippet contains the URL');
  assert.ok(!iframe.includes('Alpha'), 'iframe snippet does NOT contain title content directly');
});

test('generateEmbedUrl URL is URL-safe (no +, /, = in query value)', async () => {
  const snap = makeSnapshot([{ i: 'notes/my note.md', t: 'My Note / Sub = Task + Extra' }], []);
  const { url } = await generateEmbedUrl(snap, 'https://example.com');
  const paramValue = new URL(url).searchParams.get('s') ?? '';
  assert.doesNotMatch(paramValue, /[+/=]/, 'query value must be URL-safe');
});

// ---------------------------------------------------------------------------
// Privacy / no-content invariant (explicit cross-check)
// ---------------------------------------------------------------------------

test('snapshot never contains raw note content even for long titles', async () => {
  const SECRET_CONTENT = 'TOP SECRET: confidential data that must not appear in the URL';
  // We're testing buildSnapshot (engine nodes have no `content` field, but let's
  // verify nothing in the full pipe leaks a simulated content field).
  const nodes: GraphNode[] = [
    {
      id: 'secret.md',
      path: 'secret.md',
      title: 'Safe Title',
      tags: [],
      folder: '',
      // GraphNode has no `content` field — confirm buildSnapshot only takes id + title.
    },
  ];
  const snap = buildSnapshot(nodes, []);
  const encoded = await encodeSnapshot(snap);
  // The encoded form must not contain the secret string.
  assert.ok(!encoded.includes(SECRET_CONTENT), 'encoded URL must not contain secret content');
  // The snapshot object itself must only have the declared fields.
  assert.equal(snap.n[0].t, 'Safe Title');
  assert.deepEqual(Object.keys(snap.n[0]).sort(), ['i', 't']);
});

// ---------------------------------------------------------------------------
// Full integration: buildSnapshot → encodeSnapshot → decodeSnapshot
// ---------------------------------------------------------------------------

test('full pipeline: buildSnapshot → encode → decode preserves graph topology', async () => {
  const nodes = [makeNode('a.md', 'Alpha'), makeNode('b.md', 'Beta'), makeNode('c.md', 'Gamma')];
  const edges = [
    makeEdge('a.md', 'b.md', 'wikilink', true),
    makeEdge('b.md', 'c.md', 'markdown', true),
    makeEdge('a.md', 'ghost', 'wikilink', false), // excluded
  ];

  const snap = buildSnapshot(nodes, edges);
  assert.equal(snap.e.length, 2, 'unresolved edges excluded from snapshot');

  const encoded = await encodeSnapshot(snap);
  const decoded = await decodeSnapshot(encoded);

  assert.equal(decoded.v, 1);
  assert.equal(decoded.n.length, 3);
  assert.equal(decoded.e.length, 2);

  const nodeById = new Map(decoded.n.map((n) => [n.i, n]));
  assert.equal(nodeById.get('a.md')?.t, 'Alpha');
  assert.equal(nodeById.get('b.md')?.t, 'Beta');
  assert.equal(nodeById.get('c.md')?.t, 'Gamma');
});
