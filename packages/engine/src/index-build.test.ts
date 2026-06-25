import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { NoteInput } from './types.js';
import { buildIndex, getBacklinks, getOutbound } from './index-build.js';

const note = (path: string, content: string, extra?: Partial<NoteInput>): NoteInput => ({
  path: path as NoteInput['path'],
  content,
  ...extra,
});

test('nodes carry path, folder, title and timestamps', () => {
  const index = buildIndex([
    note('notes/ideas/a.md', '# Alpha', { createdAt: 1, updatedAt: 2 }),
    note('b.md', 'no heading'),
  ]);
  const a = index.nodes.get('notes/ideas/a.md')!;
  assert.equal(a.title, 'Alpha');
  assert.equal(a.folder, 'notes/ideas');
  assert.equal(a.createdAt, 1);
  assert.equal(a.updatedAt, 2);
  const b = index.nodes.get('b.md')!;
  assert.equal(b.folder, '');
  assert.equal(b.title, 'b');
});

test('wikilink resolves by title and by basename', () => {
  const index = buildIndex([
    note('a.md', 'link to [[Beta]] and [[c]]'),
    note('notes/beta.md', '# Beta'),
    note('notes/c.md', 'plain'),
  ]);
  const out = getOutbound(index, 'a.md');
  assert.equal(out.length, 2);
  assert.ok(out.every((e) => e.resolved));
  assert.deepEqual(out.map((e) => e.target).sort(), ['notes/beta.md', 'notes/c.md']);
});

test('markdown relative link resolves against source folder', () => {
  const index = buildIndex([
    note('notes/sub/a.md', 'see [y](../y.md)'),
    note('notes/y.md', 'target'),
  ]);
  const out = getOutbound(index, 'notes/sub/a.md');
  assert.equal(out.length, 1);
  assert.equal(out[0]!.target, 'notes/y.md');
  assert.equal(out[0]!.resolved, true);
});

test('unresolved link is flagged and keeps raw target', () => {
  const index = buildIndex([note('a.md', 'link to [[Ghost Note]]')]);
  const out = getOutbound(index, 'a.md');
  assert.equal(out.length, 1);
  assert.equal(out[0]!.resolved, false);
  assert.equal(out[0]!.target, 'Ghost Note');
  assert.equal(index.edges.filter((e) => !e.resolved).length, 1);
});

test('backlinks are computed for resolved edges only', () => {
  const index = buildIndex([
    note('a.md', '[[Target]] and [[Missing]]'),
    note('b.md', '[[Target]]'),
    note('target.md', '# Target'),
  ]);
  const back = getBacklinks(index, 'target.md');
  assert.equal(back.length, 2);
  assert.deepEqual(back.map((e) => e.source).sort(), ['a.md', 'b.md']);
  // Missing target has no node and therefore no backlinks entry.
  assert.equal(index.backlinks.get('Missing'), undefined);
});

test('duplicate identical edges are de-duplicated', () => {
  const index = buildIndex([note('a.md', '[[B]] [[B]] [[B]]'), note('b.md', 'x')]);
  assert.equal(getOutbound(index, 'a.md').length, 1);
});

test('duplicate paths keep only the surviving note edges (no phantom edges)', () => {
  // Two notes at the SAME path with different links. Last-write-wins on the
  // node; the discarded duplicate's links must NOT survive as phantom edges.
  const index = buildIndex([
    note('a.md', '[[old-target]]'),
    note('a.md', '[[new-target]]'),
    note('old-target.md', 'x'),
    note('new-target.md', 'y'),
  ]);

  const out = getOutbound(index, 'a.md');
  assert.equal(out.length, 1);
  assert.equal(out[0]!.target, 'new-target.md');

  // The discarded note pointed at old-target; that backlink must not exist.
  assert.equal(getBacklinks(index, 'old-target.md').length, 0);
  assert.equal(getBacklinks(index, 'new-target.md').length, 1);
  // And no stray edge anywhere references old-target.
  assert.equal(index.edges.filter((e) => e.target === 'old-target.md').length, 0);
});

test('empty wikilink target [[]] produces no junk edge', () => {
  const index = buildIndex([note('a.md', 'before [[]] after [[Real]]'), note('real.md', 'x')]);
  const out = getOutbound(index, 'a.md');
  assert.equal(out.length, 1);
  assert.equal(out[0]!.target, 'real.md');
  // No edge with an empty target text.
  assert.equal(index.edges.filter((e) => e.target.trim() === '').length, 0);
});

test('typed relation edges use the relation name as type', () => {
  const index = buildIndex([
    note('a.md', '---\nrelations:\n  references:\n    - [[B]]\n---\nbody'),
    note('b.md', '# B'),
  ]);
  const out = getOutbound(index, 'a.md');
  assert.equal(out.length, 1);
  assert.equal(out[0]!.type, 'references');
  assert.equal(out[0]!.target, 'b.md');
  assert.equal(out[0]!.resolved, true);
});

test('NFD wikilink resolves to an NFC note path (Unicode normalization)', () => {
  // `café` written two ways: NFD (e + combining acute) in the link, NFC
  // (precomposed é) in the note path. They must be treated as the same note.
  const nfdCafe = 'café'; // c a f e + U+0301
  const nfcCafe = 'café'; // c a f é
  assert.notEqual(nfdCafe, nfcCafe); // distinct code-point sequences

  const index = buildIndex([
    note('a.md', `link to [[${nfdCafe}]]`),
    note(`${nfcCafe}.md`, '# Cafe'),
  ]);

  const out = getOutbound(index, 'a.md');
  assert.equal(out.length, 1);
  assert.equal(out[0]!.resolved, true);
  assert.equal(out[0]!.target, `${nfcCafe}.md`);
});

test('wikilink alias and heading survive into the edge', () => {
  const index = buildIndex([note('a.md', '[[B#sec|alias]]'), note('b.md', 'x')]);
  const edge = getOutbound(index, 'a.md')[0]!;
  assert.equal(edge.alias, 'alias');
  assert.equal(edge.heading, 'sec');
});
