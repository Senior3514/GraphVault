import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { parseNote } from './parse.js';
import { buildNoteHierarchy, type HierarchyNode } from './hierarchy.js';
import type { NoteInput } from './types.js';

const note = (path: string, content: string): NoteInput => ({
  path: path as NoteInput['path'],
  content,
});

function parseAll(inputs: NoteInput[]) {
  return inputs.map((n) => parseNote(n.path, n.content));
}

function findByPath(nodes: HierarchyNode[], path: string): HierarchyNode | undefined {
  for (const n of nodes) {
    if (n.path === path) return n;
    const found = findByPath(n.children, path);
    if (found) return found;
  }
  return undefined;
}

test('a note with no parent frontmatter is a root', () => {
  const notes = parseAll([note('a.md', '# A')]);
  const forest = buildNoteHierarchy(notes);
  assert.equal(forest.length, 1);
  assert.equal(forest[0]?.path, 'a.md');
  assert.equal(forest[0]?.parentUnresolved, false);
});

test('a note declares a parent by path, becomes a child', () => {
  const notes = parseAll([
    note('parent.md', '# Parent'),
    note('child.md', '---\nparent: parent.md\n---\n# Child'),
  ]);
  const forest = buildNoteHierarchy(notes);
  assert.equal(forest.length, 1);
  assert.equal(forest[0]?.path, 'parent.md');
  assert.equal(forest[0]?.children.length, 1);
  assert.equal(forest[0]?.children[0]?.path, 'child.md');
  assert.equal(forest[0]?.children[0]?.parentUnresolved, false);
});

test('a note declares a parent by title (case-insensitive), resolves the same way', () => {
  const notes = parseAll([
    note('notes/parent.md', '---\ntitle: My Parent\n---\n# ignored'),
    note('child.md', '---\nparent: my parent\n---\n# Child'),
  ]);
  const forest = buildNoteHierarchy(notes);
  const parent = findByPath(forest, 'notes/parent.md');
  assert.ok(parent);
  assert.equal(parent!.children.length, 1);
  assert.equal(parent!.children[0]?.path, 'child.md');
});

test('a parent value with a .md extension resolves against a path without one, and vice versa', () => {
  const notes = parseAll([note('a.md', '# A'), note('b.md', '---\nparent: a\n---\n# B')]);
  const forest = buildNoteHierarchy(notes);
  const a = findByPath(forest, 'a.md');
  assert.equal(a?.children[0]?.path, 'b.md');
});

test('grandchildren nest correctly (multi-level tree)', () => {
  const notes = parseAll([
    note('a.md', '# A'),
    note('b.md', '---\nparent: a.md\n---\n# B'),
    note('c.md', '---\nparent: b.md\n---\n# C'),
  ]);
  const forest = buildNoteHierarchy(notes);
  assert.equal(forest.length, 1);
  const a = forest[0]!;
  assert.equal(a.children[0]?.path, 'b.md');
  assert.equal(a.children[0]?.children[0]?.path, 'c.md');
});

test('an unresolvable parent falls back to root and is flagged', () => {
  const notes = parseAll([note('a.md', '---\nparent: does-not-exist\n---\n# A')]);
  const forest = buildNoteHierarchy(notes);
  assert.equal(forest.length, 1);
  assert.equal(forest[0]?.path, 'a.md');
  assert.equal(forest[0]?.parentUnresolved, true);
});

test('a note declaring itself as its own parent falls back to root, not an infinite loop', () => {
  const notes = parseAll([note('a.md', '---\nparent: a.md\n---\n# A')]);
  const forest = buildNoteHierarchy(notes);
  assert.equal(forest.length, 1);
  assert.equal(forest[0]?.parentUnresolved, true);
});

test('a 2-note cycle (a -> b -> a) never infinite-loops and drops no notes', () => {
  const notes = parseAll([
    note('a.md', '---\nparent: b.md\n---\n# A'),
    note('b.md', '---\nparent: a.md\n---\n# B'),
  ]);
  const forest = buildNoteHierarchy(notes);
  // Every note still appears somewhere - none silently dropped.
  assert.ok(findByPath(forest, 'a.md'));
  assert.ok(findByPath(forest, 'b.md'));
});

test('a 3-note cycle (a -> b -> c -> a) never infinite-loops and drops no notes', () => {
  const notes = parseAll([
    note('a.md', '---\nparent: b.md\n---\n# A'),
    note('b.md', '---\nparent: c.md\n---\n# B'),
    note('c.md', '---\nparent: a.md\n---\n# C'),
  ]);
  const forest = buildNoteHierarchy(notes);
  assert.ok(findByPath(forest, 'a.md'));
  assert.ok(findByPath(forest, 'b.md'));
  assert.ok(findByPath(forest, 'c.md'));
});

test('multiple independent roots produce a forest, not a single tree', () => {
  const notes = parseAll([note('a.md', '# A'), note('b.md', '# B')]);
  const forest = buildNoteHierarchy(notes);
  assert.equal(forest.length, 2);
});

test('a note can have multiple children under the same parent', () => {
  const notes = parseAll([
    note('a.md', '# A'),
    note('b.md', '---\nparent: a.md\n---\n# B'),
    note('c.md', '---\nparent: a.md\n---\n# C'),
  ]);
  const forest = buildNoteHierarchy(notes);
  assert.equal(forest[0]?.children.length, 2);
  const childPaths = forest[0]!.children.map((c) => c.path).sort();
  assert.deepEqual(childPaths, ['b.md', 'c.md']);
});

test('an empty notes array returns an empty forest', () => {
  assert.deepEqual(buildNoteHierarchy([]), []);
});

test('a blank parent frontmatter value is treated as no parent', () => {
  const notes = parseAll([note('a.md', '---\nparent: ""\n---\n# A')]);
  const forest = buildNoteHierarchy(notes);
  assert.equal(forest[0]?.parentUnresolved, false);
});
