import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  deriveTitle,
  extractInlineTags,
  extractWikiLinks,
  parseNote,
  setFrontmatterField,
  splitFrontmatter,
} from './parse';

test('splitFrontmatter parses scalars and lists', () => {
  const { frontmatter, body } = splitFrontmatter(
    `---\ntitle: Hello\ntags: [a, b]\nstatus:\n  - draft\n  - pinned\n---\n# Body\n`,
  );
  assert.equal(frontmatter.title, 'Hello');
  assert.deepEqual(frontmatter.tags, ['a', 'b']);
  assert.deepEqual(frontmatter.status, ['draft', 'pinned']);
  assert.equal(body.trim(), '# Body');
});

test('splitFrontmatter returns whole content when no frontmatter', () => {
  const { frontmatter, body } = splitFrontmatter('# Just a note\n');
  assert.deepEqual(frontmatter, {});
  assert.equal(body, '# Just a note\n');
});

test('extractInlineTags finds hashtags, lowercased and de-duplicated', () => {
  const tags = extractInlineTags('Some #Idea and #idea plus #multi-word/sub #notatend');
  assert.deepEqual(tags, ['idea', 'multi-word/sub', 'notatend']);
});

test('extractInlineTags ignores hashes inside words', () => {
  const tags = extractInlineTags('color #fff is a hex but c#sharp is not a tag');
  // `#fff` is a valid tag; the `#sharp` is mid-word so excluded.
  assert.deepEqual(tags, ['fff']);
});

test('extractWikiLinks parses targets and aliases, de-duplicated', () => {
  const links = extractWikiLinks('See [[Note A]] and [[Note A]] and [[path/b|Alias B]].');
  assert.deepEqual(links, [{ target: 'Note A' }, { target: 'path/b', alias: 'Alias B' }]);
});

test('deriveTitle prefers frontmatter, then H1, then filename', () => {
  assert.equal(deriveTitle('a.md', { title: 'FM' }, '# H1'), 'FM');
  assert.equal(deriveTitle('a.md', {}, '# H1 Title\nbody'), 'H1 Title');
  assert.equal(deriveTitle('notes/my-note.md', {}, 'no heading'), 'my-note');
});

test('parseNote merges frontmatter tags with inline tags', () => {
  const parsed = parseNote(
    'n.md',
    `---\ntitle: T\ntags: [alpha]\n---\nbody with #beta and #alpha\n`,
  );
  assert.equal(parsed.title, 'T');
  assert.deepEqual([...parsed.tags].sort(), ['alpha', 'beta']);
});

// ---------------------------------------------------------------------------
// setFrontmatterField
// ---------------------------------------------------------------------------

test('setFrontmatterField adds a frontmatter block to a note that has none', () => {
  const result = setFrontmatterField('# Just a note\n', 'parent', 'Project.md');
  assert.equal(result, '---\nparent: Project.md\n---\n\n# Just a note\n');
  // Round-trips through the real reader.
  assert.equal(splitFrontmatter(result).frontmatter.parent, 'Project.md');
});

test('setFrontmatterField adds a new key to existing frontmatter, preserving the rest', () => {
  const result = setFrontmatterField('---\ntitle: T\n---\nbody\n', 'parent', 'Project.md');
  const { frontmatter, body } = splitFrontmatter(result);
  assert.equal(frontmatter.title, 'T');
  assert.equal(frontmatter.parent, 'Project.md');
  assert.equal(body, 'body\n');
});

test('setFrontmatterField replaces an existing key in place, preserving other fields', () => {
  const result = setFrontmatterField(
    '---\ntitle: T\nparent: Old.md\ntags: [a]\n---\nbody\n',
    'parent',
    'New.md',
  );
  const { frontmatter } = splitFrontmatter(result);
  assert.equal(frontmatter.title, 'T');
  assert.equal(frontmatter.parent, 'New.md');
  assert.deepEqual(frontmatter.tags, ['a']);
});

test('setFrontmatterField(null) removes an existing key, preserving other fields', () => {
  const result = setFrontmatterField('---\ntitle: T\nparent: Old.md\n---\nbody\n', 'parent', null);
  const { frontmatter } = splitFrontmatter(result);
  assert.equal(frontmatter.title, 'T');
  assert.equal(frontmatter.parent, undefined);
});

test('setFrontmatterField(null) on a note with no frontmatter is a no-op', () => {
  const result = setFrontmatterField('# Just a note\n', 'parent', null);
  assert.equal(result, '# Just a note\n');
});

test('setFrontmatterField(null) on a note whose frontmatter never had the key is a no-op change', () => {
  const result = setFrontmatterField('---\ntitle: T\n---\nbody\n', 'parent', null);
  assert.equal(splitFrontmatter(result).frontmatter.title, 'T');
  assert.equal(splitFrontmatter(result).frontmatter.parent, undefined);
});

test('setFrontmatterField quotes a value containing a colon so it round-trips', () => {
  const result = setFrontmatterField('# n\n', 'parent', 'Chapter 1: Intro');
  assert.equal(splitFrontmatter(result).frontmatter.parent, 'Chapter 1: Intro');
});

test('setFrontmatterField quotes a value with leading/trailing whitespace', () => {
  const result = setFrontmatterField('# n\n', 'parent', '  padded  ');
  assert.equal(splitFrontmatter(result).frontmatter.parent, '  padded  ');
});
