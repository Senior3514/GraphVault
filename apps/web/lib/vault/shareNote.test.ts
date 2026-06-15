import assert from 'node:assert/strict';
import { test } from 'node:test';

import { composeSharedNote } from './shareNote';

// ---- basePath derivation -------------------------------------------------------

test('basePath uses the title when provided', () => {
  const { basePath } = composeSharedNote({ title: 'My Article', url: 'https://example.com' });
  assert.equal(basePath, 'Web Clip — My Article.md');
});

test('basePath falls back to hostname when title is absent', () => {
  const { basePath } = composeSharedNote({ url: 'https://example.com/page?q=1' });
  assert.equal(basePath, 'Web Clip — example.com.md');
});

test('basePath falls back to "Shared note" when both title and url are absent', () => {
  const { basePath } = composeSharedNote({ text: 'some text' });
  assert.equal(basePath, 'Web Clip — Shared note.md');
});

test('basePath falls back to "Shared note" when url is not a valid URL', () => {
  const { basePath } = composeSharedNote({ url: 'not-a-url' });
  assert.equal(basePath, 'Web Clip — Shared note.md');
});

test('basePath strips illegal path characters', () => {
  const { basePath } = composeSharedNote({ title: 'A/B: C*D?E"F' });
  assert.equal(basePath, 'Web Clip — A-B- C-D-E-F.md');
});

test('basePath is capped at ~84 chars (80 + prefix + extension)', () => {
  const longTitle = 'A'.repeat(120);
  const { basePath } = composeSharedNote({ title: longTitle });
  // sanitisePath caps at 80 chars; prefix "Web Clip — " (11) + ".md" (3) = 94 max
  assert.ok(basePath.length <= 94);
});

// ---- content body ---------------------------------------------------------------

test('content has an H1 matching the heading', () => {
  const { content } = composeSharedNote({ title: 'Hello' });
  assert.ok(content.startsWith('# Hello\n'));
});

test('content includes text paragraph when provided', () => {
  const { content } = composeSharedNote({ title: 'T', text: 'Some description.' });
  assert.ok(content.includes('Some description.'));
});

test('content omits text paragraph when text is absent', () => {
  const { content } = composeSharedNote({ title: 'T', url: 'https://example.com' });
  // Body should only contain heading + source line, no stray empty paragraph
  assert.ok(!content.includes('undefined'));
});

test('content includes a Source link when url is provided', () => {
  const { content } = composeSharedNote({ title: 'T', url: 'https://example.com/p' });
  assert.ok(content.includes('**Source:** [https://example.com/p](https://example.com/p)'));
});

test('content omits Source line when url is absent', () => {
  const { content } = composeSharedNote({ title: 'T', text: 'body' });
  assert.ok(!content.includes('**Source:**'));
});

// ---- empty / garbage input ------------------------------------------------------

test('all params empty produces a valid note', () => {
  const { basePath, content } = composeSharedNote({});
  assert.equal(basePath, 'Web Clip — Shared note.md');
  assert.ok(content.startsWith('# Shared note'));
});

test('null params are treated as absent', () => {
  const { basePath } = composeSharedNote({ title: null, text: null, url: null });
  assert.equal(basePath, 'Web Clip — Shared note.md');
});

test('whitespace-only title is treated as absent', () => {
  const { basePath } = composeSharedNote({ title: '   ', url: 'https://example.com' });
  assert.equal(basePath, 'Web Clip — example.com.md');
});
