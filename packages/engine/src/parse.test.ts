import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import type { FilePath } from '@graphvault/shared';
import { parseNote, splitFrontmatter } from './parse.js';

const p = (s: string): FilePath => s as FilePath;

test('title falls back to filename without extension', () => {
  const note = parseNote(p('notes/ideas/Graph Thinking.md'), 'no heading here');
  assert.equal(note.title, 'Graph Thinking');
});

test('title prefers first H1 over filename', () => {
  const note = parseNote(p('notes/a.md'), '# My Heading\n\nbody');
  assert.equal(note.title, 'My Heading');
});

test('title prefers frontmatter title over H1', () => {
  const note = parseNote(p('notes/a.md'), '---\ntitle: From Frontmatter\n---\n# H1\n');
  assert.equal(note.title, 'From Frontmatter');
});

test('frontmatter scalars, lists and nested maps parse', () => {
  const md = [
    '---',
    'title: "Quoted Title"',
    'count: 3',
    'ratio: 0.5',
    'draft: true',
    'tags: [alpha, beta]',
    'authors:',
    '  - Ada',
    '  - Grace',
    'relations:',
    '  references:',
    '    - [[Note X]]',
    '    - notes/y.md',
    '---',
    'body',
  ].join('\n');
  const { frontmatter } = splitFrontmatter(md);
  assert.equal(frontmatter['title'], 'Quoted Title');
  assert.equal(frontmatter['count'], 3);
  assert.equal(frontmatter['ratio'], 0.5);
  assert.equal(frontmatter['draft'], true);
  assert.deepEqual(frontmatter['tags'], ['alpha', 'beta']);
  assert.deepEqual(frontmatter['authors'], ['Ada', 'Grace']);
  assert.deepEqual((frontmatter['relations'] as Record<string, unknown>)['references'], [
    '[[Note X]]',
    'notes/y.md',
  ]);
});

test('wikilink with alias and heading', () => {
  const note = parseNote(p('a.md'), 'see [[Target Note#Section One|the alias]] here');
  assert.equal(note.links.length, 1);
  const link = note.links[0]!;
  assert.equal(link.type, 'wikilink');
  assert.equal(link.target, 'Target Note');
  assert.equal(link.alias, 'the alias');
  assert.equal(link.heading, 'Section One');
});

test('bare wikilink', () => {
  const note = parseNote(p('a.md'), '[[Just A Target]]');
  assert.equal(note.links[0]!.target, 'Just A Target');
  assert.equal(note.links[0]!.alias, undefined);
  assert.equal(note.links[0]!.heading, undefined);
});

test('standard markdown link parses text, target and heading', () => {
  const note = parseNote(p('a.md'), '[Display](../other/y.md#a-heading)');
  const link = note.links[0]!;
  assert.equal(link.type, 'markdown');
  assert.equal(link.target, '../other/y.md');
  assert.equal(link.alias, 'Display');
  assert.equal(link.heading, 'a-heading');
});

test('external links and images are ignored', () => {
  const note = parseNote(
    p('a.md'),
    '[site](https://example.com) and ![img](pic.png) and [anchor](#top)',
  );
  assert.equal(note.links.length, 0);
});

test('links inside code spans and fences are ignored', () => {
  const md = [
    '`[[not a link]]`',
    '',
    '```',
    '[[also not]]',
    '[md](x.md)',
    '```',
    '',
    '[[real link]]',
  ].join('\n');
  const note = parseNote(p('a.md'), md);
  assert.equal(note.links.length, 1);
  assert.equal(note.links[0]!.target, 'real link');
});

test('inline tags extracted, deduped, hash stripped', () => {
  const note = parseNote(p('a.md'), 'about #graphs and #graphs and #note/sub here');
  assert.deepEqual(note.tags, ['graphs', 'note/sub']);
});

test('a # inside a word is not a tag', () => {
  const note = parseNote(p('a.md'), 'C#sharp issue#42');
  assert.deepEqual(note.tags, []);
});

test('frontmatter tags merge with inline tags', () => {
  const note = parseNote(p('a.md'), '---\ntags: [fm1, fm2]\n---\n#inline');
  assert.deepEqual(note.tags, ['inline', 'fm1', 'fm2']);
});

test('typed relations become links with the relation name as type', () => {
  const md = [
    '---',
    'relations:',
    '  supports:',
    '    - [[Claim A]]',
    '  refutes: [[Claim B]]',
    '---',
    'body',
  ].join('\n');
  const note = parseNote(p('a.md'), md);
  const supports = note.links.find((l) => l.type === 'supports');
  const refutes = note.links.find((l) => l.type === 'refutes');
  assert.ok(supports, 'supports relation present');
  assert.equal(supports!.target, 'Claim A');
  assert.ok(refutes, 'refutes relation present');
  assert.equal(refutes!.target, 'Claim B');
});

test('links preserve document order', () => {
  const note = parseNote(p('a.md'), 'first [[One]] then [two](two.md) then [[Three]]');
  assert.deepEqual(
    note.links.map((l) => l.target),
    ['One', 'two.md', 'Three'],
  );
});

test('note without frontmatter yields empty frontmatter object', () => {
  const { frontmatter, body } = splitFrontmatter('# Heading\nbody');
  assert.deepEqual(frontmatter, {});
  assert.equal(body, '# Heading\nbody');
});
