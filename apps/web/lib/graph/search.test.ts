import assert from 'node:assert/strict';
import { test } from 'node:test';

import { matchNodes, matchSummary } from './search';
import type { RenderNode } from './model';

function node(id: string, title: string, tagKey?: string): RenderNode {
  return {
    id,
    title,
    category: 'note',
    color: '#7aa2f7',
    degree: 0,
    tagKey,
  };
}

const nodes: RenderNode[] = [
  node('a.md', 'Alpha Project', 'work'),
  node('b.md', 'Beta Notes', 'personal'),
  node('c.md', 'Gamma Reference'),
  node('d.md', 'project planning', 'work'),
];

test('matchNodes returns null for blank query', () => {
  assert.equal(matchNodes(nodes, ''), null);
  assert.equal(matchNodes(nodes, '   '), null);
});

test('matchNodes matches title case-insensitively', () => {
  const result = matchNodes(nodes, 'ALPHA');
  assert.ok(result !== null);
  assert.ok(result.has('a.md'));
  assert.equal(result.size, 1);
});

test('matchNodes matches tag key', () => {
  const result = matchNodes(nodes, 'work');
  assert.ok(result !== null);
  assert.ok(result.has('a.md'));
  assert.ok(result.has('d.md'));
  assert.equal(result.size, 2);
});

test('matchNodes matches substring in title', () => {
  const result = matchNodes(nodes, 'project');
  assert.ok(result !== null);
  // 'Alpha Project' and 'project planning'
  assert.ok(result.has('a.md'));
  assert.ok(result.has('d.md'));
  assert.equal(result.size, 2);
});

test('matchNodes returns empty set for no matches', () => {
  const result = matchNodes(nodes, 'xyznotfound');
  assert.ok(result !== null);
  assert.equal(result.size, 0);
});

test('matchNodes handles nodes with no tagKey', () => {
  const result = matchNodes(nodes, 'gamma');
  assert.ok(result !== null);
  assert.ok(result.has('c.md'));
});

test('matchSummary produces correct strings', () => {
  assert.equal(matchSummary(0), 'No matches');
  assert.equal(matchSummary(1), '1 match');
  assert.equal(matchSummary(3), '3 matches');
  assert.equal(matchSummary(100), '100 matches');
});
