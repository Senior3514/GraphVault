import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RenderNode } from './model';
import {
  computeGroupColors,
  groupLegendEntries,
  loadGroups,
  matchesQuery,
  matchGroup,
  nextGroupColor,
  GROUP_COLOR_PRESETS,
  saveGroups,
  type NodeGroup,
} from './groups';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function node(
  id: string,
  title: string,
  opts: { tagKey?: string; path?: string } = {},
): RenderNode {
  return {
    id,
    title,
    category: 'note',
    color: '#7aa2f7',
    degree: 0,
    tagKey: opts.tagKey,
    path: opts.path,
  };
}

function group(id: string, query: string, color = '#f43f5e', name = ''): NodeGroup {
  return { id, name: name || id, query, color };
}

// ---------------------------------------------------------------------------
// matchesQuery
// ---------------------------------------------------------------------------

test('matchesQuery: empty query never matches', () => {
  const n = node('a.md', 'Alpha');
  assert.equal(matchesQuery(n, ''), false);
  assert.equal(matchesQuery(n, '   '), false);
});

test('matchesQuery: title substring match (case-insensitive)', () => {
  const n = node('a.md', 'Alpha Project');
  assert.equal(matchesQuery(n, 'alpha'), true);
  assert.equal(matchesQuery(n, 'ALPHA'), true);
  assert.equal(matchesQuery(n, 'Project'), true);
  assert.equal(matchesQuery(n, 'project'), true);
  assert.equal(matchesQuery(n, 'beta'), false);
});

test('matchesQuery: tag match with # prefix', () => {
  const n = node('a.md', 'A Note', { tagKey: 'project' });
  assert.equal(matchesQuery(n, '#project'), true);
  assert.equal(matchesQuery(n, '#PROJECT'), true);
  assert.equal(matchesQuery(n, '#proj'), true); // substring
  assert.equal(matchesQuery(n, '#work'), false);
});

test('matchesQuery: tag match on node with no tagKey returns false', () => {
  const n = node('a.md', 'A Note');
  assert.equal(matchesQuery(n, '#project'), false);
});

test('matchesQuery: path prefix with path: prefix', () => {
  const n = node('a.md', 'A Note', { path: 'work/projects/plan.md' });
  assert.equal(matchesQuery(n, 'path:work/'), true);
  assert.equal(matchesQuery(n, 'path:WORK/'), true); // case-insensitive
  assert.equal(matchesQuery(n, 'path:work/projects/'), true);
  assert.equal(matchesQuery(n, 'path:personal/'), false);
});

test('matchesQuery: path: with no prefix never matches', () => {
  const n = node('a.md', 'A Note', { path: 'notes/a.md' });
  assert.equal(matchesQuery(n, 'path:'), false);
});

test('matchesQuery: path: on node with no path returns false', () => {
  const n = node('a.md', 'A Note');
  assert.equal(matchesQuery(n, 'path:notes/'), false);
});

test('matchesQuery: bare # with nothing after it does not match', () => {
  const n = node('a.md', 'A Note', { tagKey: 'project' });
  assert.equal(matchesQuery(n, '#'), false);
});

// ---------------------------------------------------------------------------
// matchGroup
// ---------------------------------------------------------------------------

test('matchGroup: returns undefined when groups list is empty', () => {
  const n = node('a.md', 'Alpha');
  assert.equal(matchGroup(n, []), undefined);
});

test('matchGroup: returns first matching group colour', () => {
  const n = node('a.md', 'Alpha Project', { tagKey: 'work' });
  const groups = [group('g1', '#work', '#ff0000'), group('g2', 'alpha', '#00ff00')];
  // g1 matches first (tag)
  assert.equal(matchGroup(n, groups), '#ff0000');
});

test('matchGroup: skips non-matching groups, returns second match', () => {
  const n = node('a.md', 'Alpha Project');
  const groups = [group('g1', '#work', '#ff0000'), group('g2', 'alpha', '#00ff00')];
  // g1 doesn't match (no tagKey), g2 does
  assert.equal(matchGroup(n, groups), '#00ff00');
});

test('matchGroup: returns undefined when no group matches', () => {
  const n = node('a.md', 'Beta Note');
  const groups = [group('g1', 'alpha', '#ff0000')];
  assert.equal(matchGroup(n, groups), undefined);
});

test('matchGroup: first-matching-group-wins when multiple groups match', () => {
  const n = node('a.md', 'Alpha Work', { tagKey: 'work' });
  const groups = [group('g1', 'alpha', '#aaaaaa'), group('g2', '#work', '#bbbbbb')];
  // Both match; first wins
  assert.equal(matchGroup(n, groups), '#aaaaaa');
});

// ---------------------------------------------------------------------------
// computeGroupColors
// ---------------------------------------------------------------------------

test('computeGroupColors: empty groups returns empty map', () => {
  const nodes = [node('a.md', 'Alpha'), node('b.md', 'Beta')];
  const map = computeGroupColors(nodes, []);
  assert.equal(map.size, 0);
});

test('computeGroupColors: maps matched nodes to correct colour', () => {
  const nodes = [
    node('a.md', 'Alpha', { tagKey: 'work' }),
    node('b.md', 'Beta', { tagKey: 'personal' }),
    node('c.md', 'Gamma'),
  ];
  const groups = [group('g1', '#work', '#ff0000')];
  const map = computeGroupColors(nodes, groups);
  assert.equal(map.get('a.md'), '#ff0000');
  assert.equal(map.has('b.md'), false);
  assert.equal(map.has('c.md'), false);
});

test('computeGroupColors: first-matching-group wins per node', () => {
  const nodes = [node('a.md', 'Alpha', { tagKey: 'work' })];
  const groups = [group('g1', '#work', '#ff0000'), group('g2', 'alpha', '#00ff00')];
  const map = computeGroupColors(nodes, groups);
  // Both match; first group (g1) wins
  assert.equal(map.get('a.md'), '#ff0000');
});

test('computeGroupColors: multiple groups apply to different nodes', () => {
  const nodes = [node('a.md', 'Alpha', { tagKey: 'work' }), node('b.md', 'Beta Notes')];
  const groups = [group('g1', '#work', '#ff0000'), group('g2', 'beta', '#0000ff')];
  const map = computeGroupColors(nodes, groups);
  assert.equal(map.get('a.md'), '#ff0000');
  assert.equal(map.get('b.md'), '#0000ff');
});

test('computeGroupColors: nodes matching no group are absent from map', () => {
  const nodes = [node('a.md', 'Unrelated')];
  const groups = [group('g1', '#work', '#ff0000')];
  const map = computeGroupColors(nodes, groups);
  assert.equal(map.has('a.md'), false);
});

// ---------------------------------------------------------------------------
// nextGroupColor
// ---------------------------------------------------------------------------

test('nextGroupColor: cycles through presets', () => {
  const first = nextGroupColor(0);
  assert.equal(first, GROUP_COLOR_PRESETS[0]);
  const wrapped = nextGroupColor(GROUP_COLOR_PRESETS.length);
  assert.equal(wrapped, GROUP_COLOR_PRESETS[0]);
});

test('nextGroupColor: each index in range returns a preset colour', () => {
  for (let i = 0; i < GROUP_COLOR_PRESETS.length; i++) {
    const c = nextGroupColor(i);
    assert.ok(GROUP_COLOR_PRESETS.includes(c as (typeof GROUP_COLOR_PRESETS)[number]));
  }
});

// ---------------------------------------------------------------------------
// groupLegendEntries
// ---------------------------------------------------------------------------

test('groupLegendEntries: empty groups returns empty array', () => {
  assert.deepEqual(groupLegendEntries([]), []);
});

test('groupLegendEntries: uses group name as label', () => {
  const groups = [group('g1', '#work', '#ff0000', 'Work')];
  const entries = groupLegendEntries(groups);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.label, 'Work');
  assert.equal(entries[0]!.color, '#ff0000');
});

test('groupLegendEntries: falls back to query when name is blank', () => {
  const g: NodeGroup = { id: 'g1', name: '  ', query: '#work', color: '#ff0000' };
  const entries = groupLegendEntries([g]);
  assert.equal(entries[0]!.label, '#work');
});

test('groupLegendEntries: preserves group order', () => {
  const groups = [group('g1', 'alpha', '#ff0000', 'Alpha'), group('g2', 'beta', '#00ff00', 'Beta')];
  const entries = groupLegendEntries(groups);
  assert.equal(entries[0]!.label, 'Alpha');
  assert.equal(entries[1]!.label, 'Beta');
});

// ---------------------------------------------------------------------------
// localStorage persistence (mocked)
// ---------------------------------------------------------------------------

// Set up a minimal in-memory localStorage shim so the pure helpers can be
// tested in the Node.js test runner without a browser environment.
const _storage: Record<string, string> = {};
const _localStorage = {
  getItem: (k: string) => _storage[k] ?? null,
  setItem: (k: string, v: string) => {
    _storage[k] = v;
  },
  removeItem: (k: string) => {
    delete _storage[k];
  },
};
// @ts-expect-error - patching globalThis for test environment
globalThis.localStorage = _localStorage;

test('saveGroups + loadGroups round-trips correctly', () => {
  const groups: NodeGroup[] = [
    { id: 'g1', name: 'Work', query: '#work', color: '#ff0000' },
    { id: 'g2', name: 'Personal', query: 'path:personal/', color: '#00ff00' },
  ];
  saveGroups(groups);
  const loaded = loadGroups();
  assert.deepEqual(loaded, groups);
});

test('loadGroups returns empty array when nothing stored', () => {
  _localStorage.removeItem('gv:graph:groups');
  const loaded = loadGroups();
  assert.deepEqual(loaded, []);
});

test('loadGroups returns empty array for invalid JSON', () => {
  _storage['gv:graph:groups'] = 'not-json{{{';
  const loaded = loadGroups();
  assert.deepEqual(loaded, []);
});

test('loadGroups returns empty array for non-array JSON', () => {
  _storage['gv:graph:groups'] = JSON.stringify({ foo: 'bar' });
  const loaded = loadGroups();
  assert.deepEqual(loaded, []);
});

test('loadGroups silently skips malformed entries', () => {
  _storage['gv:graph:groups'] = JSON.stringify([
    { id: 'g1', name: 'Good', query: '#work', color: '#ff0000' },
    { bad: true },
    null,
    42,
  ]);
  const loaded = loadGroups();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0]!.id, 'g1');
});
