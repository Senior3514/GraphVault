import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  deriveTitle,
  extractInlineTags,
  extractWikiLinks,
  parseNote,
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
