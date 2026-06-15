import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { GraphEdge, GraphNode } from '@graphvault/engine';

import {
  buildRenderModel,
  categorizeUnresolvedTarget,
  colorForCategory,
  colorForKey,
  distinctSorted,
  GRAPH_NEUTRAL,
  notesToInputs,
} from './model';

function node(id: string, tags: string[] = []): GraphNode {
  return { id, path: id, title: id.replace(/\.md$/, ''), tags, folder: '' };
}

function edge(source: string, target: string, resolved: boolean, type = 'wikilink'): GraphEdge {
  return { source, target, type, resolved };
}

test('notesToInputs maps ctime/mtime onto createdAt/updatedAt', () => {
  const inputs = notesToInputs([
    { path: 'a.md', content: '# A', ctime: 100, mtime: 200 },
    { path: 'notes/b.md', content: '# B', ctime: 5, mtime: 9 },
  ]);
  assert.deepEqual(inputs, [
    { path: 'a.md', content: '# A', createdAt: 100, updatedAt: 200 },
    { path: 'notes/b.md', content: '# B', createdAt: 5, updatedAt: 9 },
  ]);
});

test('colorForKey is deterministic and falls back to neutral', () => {
  assert.equal(colorForKey('project'), colorForKey('project'));
  assert.equal(colorForKey(undefined), GRAPH_NEUTRAL);
  assert.equal(colorForKey(''), GRAPH_NEUTRAL);
  assert.match(colorForKey('project'), /^#[0-9a-f]{6}$/i);
});

test('distinctSorted de-duplicates and sorts', () => {
  assert.deepEqual(distinctSorted(['b', 'a', 'b', 'c', 'a']), ['a', 'b', 'c']);
});

test('categorizeUnresolvedTarget treats non-markdown files as attachments', () => {
  assert.equal(categorizeUnresolvedTarget('assets/diagram.png'), 'attachment');
  assert.equal(categorizeUnresolvedTarget('paper.pdf'), 'attachment');
  // Bare names and markdown paths are missing *notes*, not attachments.
  assert.equal(categorizeUnresolvedTarget('Some Missing Note'), 'unresolved');
  assert.equal(categorizeUnresolvedTarget('notes/ghost.md'), 'unresolved');
});

test('buildRenderModel marks real notes as category note and counts degree', () => {
  const nodes = [node('a.md'), node('b.md')];
  const edges = [edge('a.md', 'b.md', true)];
  const model = buildRenderModel(nodes, edges);

  const a = model.nodes.find((n) => n.id === 'a.md')!;
  const b = model.nodes.find((n) => n.id === 'b.md')!;
  assert.equal(a.category, 'note');
  assert.equal(a.color, colorForCategory('note'));
  assert.equal(a.degree, 1);
  assert.equal(b.degree, 1);
  assert.equal(a.path, 'a.md');
  assert.deepEqual(model.presentCategories, ['note']);
});

test('buildRenderModel synthesizes attachment and missing-note placeholders', () => {
  const nodes = [node('a.md')];
  const edges = [
    edge('a.md', 'assets/img.png', false, 'markdown'),
    edge('a.md', 'Ghost Note', false, 'wikilink'),
  ];
  const model = buildRenderModel(nodes, edges, { includeUnresolved: true });

  const attachment = model.nodes.find((n) => n.category === 'attachment');
  const missing = model.nodes.find((n) => n.category === 'unresolved');
  assert.ok(attachment, 'attachment placeholder created');
  assert.ok(missing, 'missing-note placeholder created');
  assert.equal(attachment!.title, 'img.png');
  assert.equal(missing!.title, 'Ghost Note');
  // The source note links to both placeholders.
  assert.equal(model.links.length, 2);
  assert.deepEqual(model.presentCategories, ['note', 'attachment', 'unresolved']);
});

test('buildRenderModel omits unresolved placeholders when includeUnresolved is false', () => {
  const nodes = [node('a.md')];
  const edges = [edge('a.md', 'Ghost', false)];
  const model = buildRenderModel(nodes, edges, { includeUnresolved: false });
  assert.equal(model.links.length, 0);
  assert.deepEqual(model.presentCategories, ['note']);
});

test('buildRenderModel collapses many notes pointing at the same missing target', () => {
  const nodes = [node('a.md'), node('b.md')];
  const edges = [edge('a.md', 'Ghost', false), edge('b.md', 'Ghost', false)];
  const model = buildRenderModel(nodes, edges);
  const placeholders = model.nodes.filter((n) => n.category === 'unresolved');
  assert.equal(placeholders.length, 1);
  assert.equal(placeholders[0].degree, 2);
});

test('buildRenderModel colour-by-tag uses the first tag, placeholders stay typed', () => {
  const nodes = [node('a.md', ['project'])];
  const edges = [edge('a.md', 'Ghost', false)];
  const model = buildRenderModel(nodes, edges, { colorMode: 'tag' });
  const a = model.nodes.find((n) => n.id === 'a.md')!;
  const ghost = model.nodes.find((n) => n.category === 'unresolved')!;
  assert.equal(a.color, colorForKey('project'));
  assert.equal(ghost.color, colorForCategory('unresolved'));
});
