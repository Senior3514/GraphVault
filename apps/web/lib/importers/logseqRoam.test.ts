/**
 * Unit tests for the Logseq / Roam Research importer.
 * Pure functions — no browser APIs needed.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  convertBlockRefs,
  extractLogseqProperties,
  logseqRoamImporter,
  normaliseLogseqMarkdown,
  normaliseLogseqPath,
  parseRoamJson,
} from './logseqRoam';

// ---------------------------------------------------------------------------
// convertBlockRefs
// ---------------------------------------------------------------------------

test('convertBlockRefs converts ((ref)) to [[ref]]', () => {
  assert.equal(convertBlockRefs('See ((block-id-123))'), 'See [[block-id-123]]');
});

test('convertBlockRefs handles multiple refs', () => {
  const result = convertBlockRefs('((a)) and ((b))');
  assert.equal(result, '[[a]] and [[b]]');
});

test('convertBlockRefs leaves [[wikilinks]] unchanged', () => {
  const input = '[[Page Title]]';
  assert.equal(convertBlockRefs(input), input);
});

test('convertBlockRefs leaves content without refs unchanged', () => {
  const input = 'Regular paragraph with no refs.';
  assert.equal(convertBlockRefs(input), input);
});

// ---------------------------------------------------------------------------
// extractLogseqProperties
// ---------------------------------------------------------------------------

test('extractLogseqProperties extracts tags:: property', () => {
  const content = '- tags:: zettelkasten, project\n- Some content';
  const { cleaned, meta } = extractLogseqProperties(content);
  assert.deepEqual(meta.tags, ['zettelkasten', 'project']);
  assert.ok(!cleaned.includes('tags::'));
});

test('extractLogseqProperties extracts title:: property', () => {
  const content = '- title:: "My Note"\n- Content here';
  const { cleaned, meta } = extractLogseqProperties(content);
  assert.equal(meta.title, 'My Note');
  assert.ok(!cleaned.includes('title::'));
});

test('extractLogseqProperties strips unknown properties', () => {
  const content = '- alias:: another-name\n- Content';
  const { cleaned, meta } = extractLogseqProperties(content);
  assert.ok(!cleaned.includes('alias::'));
  assert.equal(meta.tags.length, 0);
});

test('extractLogseqProperties handles wikilink tags', () => {
  const content = '- tags:: [[project]], [[work]]\n- Body';
  const { meta } = extractLogseqProperties(content);
  assert.deepEqual(meta.tags, ['project', 'work']);
});

test('extractLogseqProperties returns empty meta for plain content', () => {
  const content = '- Just a bullet\n- Another bullet';
  const { meta } = extractLogseqProperties(content);
  assert.equal(meta.tags.length, 0);
  assert.equal(meta.title, null);
});

// ---------------------------------------------------------------------------
// normaliseLogseqPath
// ---------------------------------------------------------------------------

test('normaliseLogseqPath converts journal date filename', () => {
  const result = normaliseLogseqPath('journals/2024_06_15.md');
  assert.equal(result, 'journals/2024-06-15.md');
});

test('normaliseLogseqPath leaves regular paths unchanged', () => {
  const result = normaliseLogseqPath('pages/My Note.md');
  assert.equal(result, 'pages/My Note.md');
});

test('normaliseLogseqPath handles root-level journal date', () => {
  const result = normaliseLogseqPath('2023_01_31.md');
  assert.equal(result, 'journals/2023-01-31.md');
});

// ---------------------------------------------------------------------------
// normaliseLogseqMarkdown
// ---------------------------------------------------------------------------

test('normaliseLogseqMarkdown converts block refs and strips props', () => {
  const input = [
    '- title:: "My Meeting"',
    '- tags:: work, project',
    '- First item with ((block-ref))',
    '- Second item with [[wiki]]',
  ].join('\n');

  const result = normaliseLogseqMarkdown(input);
  assert.ok(!result.includes('title::'));
  assert.ok(!result.includes('tags::'));
  assert.ok(result.includes('[[block-ref]]'));
  assert.ok(result.includes('[[wiki]]'));
  assert.ok(result.includes('work'));
  assert.ok(result.includes('project'));
});

test('normaliseLogseqMarkdown adds frontmatter when tags found', () => {
  const input = '- tags:: zettelkasten\n- Content';
  const result = normaliseLogseqMarkdown(input);
  assert.ok(result.startsWith('---'));
  assert.ok(result.includes('tags:'));
  assert.ok(result.includes('zettelkasten'));
});

test('normaliseLogseqMarkdown skips frontmatter when no meta', () => {
  const input = '- Just some bullets\n- More bullets';
  const result = normaliseLogseqMarkdown(input);
  assert.ok(!result.startsWith('---'));
});

// ---------------------------------------------------------------------------
// parseRoamJson
// ---------------------------------------------------------------------------

const SAMPLE_ROAM_JSON = JSON.stringify([
  {
    title: 'Meeting Notes',
    children: [
      { string: 'First point', children: [] },
      { string: 'Second point with ((block-ref))', children: [] },
      { string: '[[Page Link]] here', children: [] },
    ],
    'create-time': 1700000000000,
    'edit-time': 1700001000000,
  },
  {
    title: 'Empty Page',
    children: [],
  },
]);

test('parseRoamJson converts pages to import entries', () => {
  const entries = parseRoamJson(SAMPLE_ROAM_JSON);
  assert.ok(entries.length >= 1);
  const meeting = entries.find((e) => e.path.includes('Meeting'));
  assert.ok(meeting, 'Should have a Meeting Notes entry');
  assert.ok(meeting!.content.includes('Meeting Notes'));
  assert.ok(meeting!.content.includes('First point'));
});

test('parseRoamJson converts block refs to wikilinks', () => {
  const entries = parseRoamJson(SAMPLE_ROAM_JSON);
  const meeting = entries.find((e) => e.path.includes('Meeting'))!;
  assert.ok(meeting.content.includes('[[block-ref]]'));
  assert.ok(!meeting.content.includes('((block-ref))'));
});

test('parseRoamJson preserves wikilinks', () => {
  const entries = parseRoamJson(SAMPLE_ROAM_JSON);
  const meeting = entries.find((e) => e.path.includes('Meeting'))!;
  assert.ok(meeting.content.includes('[[Page Link]]'));
});

test('parseRoamJson preserves timestamps', () => {
  const entries = parseRoamJson(SAMPLE_ROAM_JSON);
  const meeting = entries.find((e) => e.path.includes('Meeting'))!;
  assert.equal(meeting.ctime, 1700000000000);
  assert.equal(meeting.mtime, 1700001000000);
});

test('parseRoamJson throws on invalid JSON', () => {
  assert.throws(() => parseRoamJson('not json'), /not valid json/i);
});

test('parseRoamJson throws on non-array JSON', () => {
  assert.throws(() => parseRoamJson('{"key": "val"}'), /array of pages/i);
});

test('parseRoamJson handles empty array', () => {
  const entries = parseRoamJson('[]');
  assert.equal(entries.length, 0);
});

// ---------------------------------------------------------------------------
// logseqRoamImporter.convert — single .json file
// ---------------------------------------------------------------------------

test('logseqRoamImporter converts Roam JSON file', async () => {
  const bytes = new TextEncoder().encode(SAMPLE_ROAM_JSON);
  const entries = await logseqRoamImporter.convert(bytes, 'roam-export.json');
  assert.ok(entries.length >= 1);
  assert.ok(entries[0].path.startsWith('roam/'));
});

test('logseqRoamImporter rejects unsupported extension', async () => {
  await assert.rejects(
    () => logseqRoamImporter.convert(new Uint8Array(0), 'export.rtf'),
    /unsupported file type/i,
  );
});

// ---------------------------------------------------------------------------
// Two-device convergence: same Roam export, same vault paths
// ---------------------------------------------------------------------------

test('parseRoamJson produces deterministic paths (convergence)', () => {
  const entries1 = parseRoamJson(SAMPLE_ROAM_JSON);
  const entries2 = parseRoamJson(SAMPLE_ROAM_JSON);
  assert.equal(entries1.length, entries2.length);
  for (let i = 0; i < entries1.length; i++) {
    assert.equal(entries1[i].path, entries2[i].path);
    assert.equal(entries1[i].content, entries2[i].content);
  }
});
