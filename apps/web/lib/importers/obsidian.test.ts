/**
 * Unit tests for the Obsidian importer.
 * Pure functions — no browser APIs needed (all regex-based).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  normaliseCallouts,
  normaliseEmbeds,
  normaliseObsidianContent,
  obsidianImporter,
  stripObsidianComments,
} from './obsidian';

// ---------------------------------------------------------------------------
// stripObsidianComments
// ---------------------------------------------------------------------------

test('stripObsidianComments removes inline comment', () => {
  assert.equal(stripObsidianComments('Hello %%world%% there'), 'Hello  there');
});

test('stripObsidianComments removes multi-line comment', () => {
  const input = 'Before\n%%\nthis is a\nmulti-line comment\n%%\nAfter';
  const result = stripObsidianComments(input);
  assert.ok(!result.includes('multi-line comment'));
  assert.ok(result.includes('Before'));
  assert.ok(result.includes('After'));
});

test('stripObsidianComments leaves content without comments unchanged', () => {
  const input = '# Title\n\nSome content with [[wikilink]] and #tag';
  assert.equal(stripObsidianComments(input), input);
});

// ---------------------------------------------------------------------------
// normaliseEmbeds
// ---------------------------------------------------------------------------

test('normaliseEmbeds converts ![[embed]] to [[embed]]', () => {
  assert.equal(normaliseEmbeds('![[MyNote]]'), '[[MyNote]]');
});

test('normaliseEmbeds converts ![[embed|alias]] to [[embed|alias]]', () => {
  assert.equal(normaliseEmbeds('![[MyNote|Display Text]]'), '[[MyNote|Display Text]]');
});

test('normaliseEmbeds leaves regular [[wikilinks]] alone', () => {
  assert.equal(normaliseEmbeds('[[Regular Link]]'), '[[Regular Link]]');
});

test('normaliseEmbeds handles multiple embeds in one line', () => {
  const result = normaliseEmbeds('See ![[A]] and ![[B]]');
  assert.equal(result, 'See [[A]] and [[B]]');
});

// ---------------------------------------------------------------------------
// normaliseCallouts
// ---------------------------------------------------------------------------

test('normaliseCallouts converts [!NOTE] callout', () => {
  const input = '> [!NOTE] This is a note';
  const result = normaliseCallouts(input);
  assert.ok(result.includes('**Note:**'));
  assert.ok(result.includes('This is a note'));
});

test('normaliseCallouts converts [!WARNING] callout', () => {
  const result = normaliseCallouts('> [!WARNING] Be careful');
  assert.ok(result.includes('**Warning:**'));
  assert.ok(result.includes('Be careful'));
});

test('normaliseCallouts handles [!TIP] without title', () => {
  const result = normaliseCallouts('> [!TIP]');
  assert.ok(result.includes('**Tip:**'));
});

test('normaliseCallouts handles foldable callout [!NOTE]+', () => {
  const result = normaliseCallouts('> [!NOTE]+ Foldable');
  assert.ok(result.includes('**Note:**'));
  assert.ok(result.includes('Foldable'));
});

test('normaliseCallouts leaves normal blockquotes unchanged', () => {
  const input = '> Normal blockquote';
  assert.equal(normaliseCallouts(input), input);
});

test('normaliseCallouts handles nested arrows', () => {
  const result = normaliseCallouts('>> [!NOTE] Nested');
  assert.ok(result.includes('**Note:**'));
});

// ---------------------------------------------------------------------------
// normaliseObsidianContent (combined)
// ---------------------------------------------------------------------------

test('normaliseObsidianContent applies all transforms', () => {
  const input = [
    '# My Note',
    '',
    '%%This is a comment%%',
    '',
    'See ![[EmbeddedNote]]',
    '',
    '> [!WARNING] Watch out',
    '',
    '[[Wikilink]] and #tag preserved',
  ].join('\n');

  const result = normaliseObsidianContent(input);

  assert.ok(!result.includes('%%'));
  assert.ok(!result.includes('![['));
  assert.ok(result.includes('[[EmbeddedNote]]'));
  assert.ok(result.includes('**Warning:**'));
  assert.ok(result.includes('[[Wikilink]]'));
  assert.ok(result.includes('#tag'));
});

// ---------------------------------------------------------------------------
// obsidianImporter.convert (single .md file)
// ---------------------------------------------------------------------------

test('obsidianImporter converts single .md file', async () => {
  const content = '# Hello\n\n%%comment%%\n\n![[embedded]]\n\n> [!NOTE] A note';
  const bytes = new TextEncoder().encode(content);
  const entries = await obsidianImporter.convert(bytes, 'hello.md');

  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, 'hello.md');
  assert.ok(!entries[0].content.includes('%%'));
  assert.ok(!entries[0].content.includes('![['));
  assert.ok(entries[0].content.includes('[[embedded]]'));
  assert.ok(entries[0].content.includes('**Note:**'));
});

test('obsidianImporter rejects unsupported file type', async () => {
  const bytes = new Uint8Array(0);
  await assert.rejects(() => obsidianImporter.convert(bytes, 'file.rtf'), /unsupported file type/i);
});

test('obsidianImporter returns empty array for unsafe path', async () => {
  const bytes = new TextEncoder().encode('content');
  // A path with ../ is unsafe and should return empty.
  const entries = await obsidianImporter.convert(bytes, '../escape.md');
  assert.equal(entries.length, 0);
});

// ---------------------------------------------------------------------------
// Two-device convergence: importing same vault twice produces no duplicates
// (The collision-safe merge is in vault.mergeImport; here we verify the
//  importer yields stable, idempotent paths for the same input.)
// ---------------------------------------------------------------------------

test('obsidianImporter stable paths across two runs', async () => {
  const content = '# Meeting notes\n\n![[diagram]]';
  const bytes = new TextEncoder().encode(content);
  const a = await obsidianImporter.convert(bytes, 'meeting.md');
  const b = await obsidianImporter.convert(bytes, 'meeting.md');
  assert.deepEqual(a[0].path, b[0].path);
  assert.deepEqual(a[0].content, b[0].content);
});
