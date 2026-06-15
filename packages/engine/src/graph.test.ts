import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { NoteInput } from './types.js';
import { buildIndex } from './index-build.js';
import { DEFAULT_NODE_CAP, filterGraph, getGraph, getLocalGraph } from './graph.js';

const note = (path: string, content: string, extra?: Partial<NoteInput>): NoteInput => ({
  path: path as NoteInput['path'],
  content,
  ...extra,
});

/** A small chain: a -> b -> c -> d, plus an unrelated node e. */
function chainIndex() {
  return buildIndex([
    note('a.md', '[[b]]'),
    note('b.md', '[[c]]'),
    note('c.md', '[[d]]'),
    note('d.md', 'end'),
    note('e.md', 'island'),
  ]);
}

test('getGraph returns all nodes and resolved edges when under cap', () => {
  const g = getGraph(chainIndex());
  assert.equal(g.nodes.length, 5);
  assert.equal(g.edges.length, 3);
  assert.equal(g.truncated, false);
});

test('getGraph truncates past the node cap', () => {
  const notes = Array.from({ length: 10 }, (_, i) => note(`n${i}.md`, 'x'));
  const g = getGraph(buildIndex(notes), { nodeCap: 4 });
  assert.equal(g.nodes.length, 4);
  assert.equal(g.truncated, true);
});

test('getGraph excludes unresolved edges by default but can include them', () => {
  const index = buildIndex([note('a.md', '[[ghost]]')]);
  assert.equal(getGraph(index).edges.length, 0);
  const withGhost = getGraph(index, { includeUnresolved: true });
  assert.equal(withGhost.edges.length, 1);
  assert.equal(withGhost.edges[0]!.resolved, false);
});

test('DEFAULT_NODE_CAP is exported and positive', () => {
  assert.ok(DEFAULT_NODE_CAP > 0);
});

test('getLocalGraph depth 0 returns just the note', () => {
  const g = getLocalGraph(chainIndex(), 'b.md', 0);
  assert.deepEqual(g.nodes.map((n) => n.id), ['b.md']);
  assert.equal(g.edges.length, 0);
});

test('getLocalGraph depth 1 includes forward and backward neighbours', () => {
  const g = getLocalGraph(chainIndex(), 'b.md', 1);
  // b connects forward to c and backward (backlink) to a.
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ['a.md', 'b.md', 'c.md']);
});

test('getLocalGraph honours BFS depth', () => {
  const g2 = getLocalGraph(chainIndex(), 'a.md', 2, { includeBacklinks: false });
  assert.deepEqual(g2.nodes.map((n) => n.id).sort(), ['a.md', 'b.md', 'c.md']);
  const g3 = getLocalGraph(chainIndex(), 'a.md', 3, { includeBacklinks: false });
  assert.deepEqual(g3.nodes.map((n) => n.id).sort(), ['a.md', 'b.md', 'c.md', 'd.md']);
});

test('getLocalGraph returns empty payload for unknown note', () => {
  const g = getLocalGraph(chainIndex(), 'nope.md', 3);
  assert.deepEqual(g, { nodes: [], edges: [], truncated: false });
});

test('getLocalGraph without backlinks only follows outbound', () => {
  const g = getLocalGraph(chainIndex(), 'b.md', 1, { includeBacklinks: false });
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ['b.md', 'c.md']);
});

function taggedIndex() {
  return buildIndex([
    note('work/a.md', '#project [[work/b]]', { updatedAt: 100 }),
    note('work/b.md', '#project', { updatedAt: 200 }),
    note('personal/c.md', '#journal', { updatedAt: 300 }),
    note('personal/sub/d.md', '#journal #project', { updatedAt: 400 }),
  ]);
}

test('filterGraph by tag', () => {
  const g = filterGraph(taggedIndex(), { tags: ['journal'] });
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ['personal/c.md', 'personal/sub/d.md']);
});

test('filterGraph by tag is case-insensitive', () => {
  const g = filterGraph(taggedIndex(), { tags: ['PROJECT'] });
  assert.deepEqual(
    g.nodes.map((n) => n.id).sort(),
    ['personal/sub/d.md', 'work/a.md', 'work/b.md'],
  );
});

test('filterGraph by folder includes nested folders', () => {
  const g = filterGraph(taggedIndex(), { folders: ['personal'] });
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ['personal/c.md', 'personal/sub/d.md']);
});

test('filterGraph by updated date range', () => {
  const g = filterGraph(taggedIndex(), { updatedFrom: 150, updatedTo: 350 });
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ['personal/c.md', 'work/b.md']);
});

test('filterGraph keeps only retained-node edges', () => {
  // Only work/* nodes; the a -> b edge is between two retained nodes.
  const g = filterGraph(taggedIndex(), { folders: ['work'] });
  assert.equal(g.nodes.length, 2);
  assert.equal(g.edges.length, 1);
  assert.equal(g.edges[0]!.source, 'work/a.md');
  assert.equal(g.edges[0]!.target, 'work/b.md');
});

test('filterGraph by link type', () => {
  const index = buildIndex([
    note('a.md', '[[b]]\n\n[c](c.md)'),
    note('b.md', 'x'),
    note('c.md', 'y'),
  ]);
  const onlyWiki = filterGraph(index, { linkTypes: ['wikilink'] });
  assert.equal(onlyWiki.edges.length, 1);
  assert.equal(onlyWiki.edges[0]!.type, 'wikilink');
  const onlyMd = filterGraph(index, { linkTypes: ['markdown'] });
  assert.equal(onlyMd.edges.length, 1);
  assert.equal(onlyMd.edges[0]!.type, 'markdown');
});

test('filterGraph combines criteria with AND', () => {
  const g = filterGraph(taggedIndex(), { tags: ['project'], folders: ['work'] });
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ['work/a.md', 'work/b.md']);
});

test('filterGraph truncates at nodeCap', () => {
  const g = filterGraph(taggedIndex(), { nodeCap: 1 });
  assert.equal(g.nodes.length, 1);
  assert.equal(g.truncated, true);
});
