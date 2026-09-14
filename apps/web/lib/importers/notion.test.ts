/**
 * Unit tests for the Notion importer.
 * Pure functions - no browser APIs or network calls.
 *
 * Notion UUIDs are exactly 32 lowercase hex characters, preceded by a space.
 * Example: "My Page abc1234567890abcdef1234567890ab" (32 hex chars at end).
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  notionImporter,
  notionPathToVaultPath,
  rewriteNotionLinks,
  stripNotionUuid,
} from './notion';

// Notion UUIDs are exactly 32 hex chars (no hyphens) preceded by a space.
const UUID32 = 'abc1234567890abcdef1234567890abc'; // 32 hex chars
const UUID32B = '9876fedc5432109876fedc5432109876'; // another 32 hex chars
const UUID32C = 'fedcba9876543210fedcba9876543210'; // another 32 hex chars
const UUID32D = 'deadbeef1234567890abcdef12345678'; // another 32 hex chars

// ---------------------------------------------------------------------------
// stripNotionUuid
// ---------------------------------------------------------------------------

test('stripNotionUuid removes a 32-char hex UUID suffix', () => {
  assert.equal(stripNotionUuid(`My Meeting Notes ${UUID32}`), 'My Meeting Notes');
});

test('stripNotionUuid leaves a title without UUID unchanged', () => {
  assert.equal(stripNotionUuid('Clean Title'), 'Clean Title');
});

test('stripNotionUuid handles a UUID-only title (space+UUID)', () => {
  // After stripping, trim() should produce an empty string.
  const result = stripNotionUuid(` ${UUID32}`);
  assert.equal(result, '');
});

test('stripNotionUuid is case-insensitive for hex', () => {
  assert.equal(stripNotionUuid(`Page ${UUID32.toUpperCase()}`), 'Page');
});

// Short strings that look like UUIDs but are NOT 32 chars are left alone.
test('stripNotionUuid does not strip 31-char suffix', () => {
  const short = UUID32.slice(0, 31); // 31 chars
  const input = `Page ${short}`;
  assert.equal(stripNotionUuid(input), input);
});

// ---------------------------------------------------------------------------
// notionPathToVaultPath
// ---------------------------------------------------------------------------

test('notionPathToVaultPath strips UUID from filename', () => {
  const result = notionPathToVaultPath(`My Page ${UUID32}.md`);
  assert.equal(result, 'My Page.md');
});

test('notionPathToVaultPath strips UUID from nested path', () => {
  const result = notionPathToVaultPath(`Parent ${UUID32}/Child ${UUID32B}.md`);
  assert.ok(result !== null);
  assert.ok(result!.includes('Parent'));
  assert.ok(result!.includes('Child'));
  assert.ok(!result!.includes(UUID32));
  assert.ok(!result!.includes(UUID32B));
});

test('notionPathToVaultPath returns null for .csv files', () => {
  const result = notionPathToVaultPath(`Database ${UUID32}.csv`);
  assert.equal(result, null);
});

test('notionPathToVaultPath returns null for unsafe paths', () => {
  const result = notionPathToVaultPath('../escape.md');
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// rewriteNotionLinks
// ---------------------------------------------------------------------------

test('rewriteNotionLinks strips UUID from local link', () => {
  const input = `[My Page](My%20Page%20${UUID32}.md)`;
  const result = rewriteNotionLinks(input);
  assert.ok(!result.includes(UUID32));
  assert.ok(result.includes('[My Page]'));
  assert.ok(result.includes('.md'));
});

test('rewriteNotionLinks leaves external URLs unchanged', () => {
  const input = '[Google](https://google.com)';
  assert.equal(rewriteNotionLinks(input), input);
});

test('rewriteNotionLinks leaves anchors unchanged', () => {
  const input = '[Section](#section-title)';
  assert.equal(rewriteNotionLinks(input), input);
});

test('rewriteNotionLinks handles nested path links', () => {
  const input = `[Child](Parent%20${UUID32}/Child%20${UUID32D}.md)`;
  const result = rewriteNotionLinks(input);
  assert.ok(!result.includes(UUID32));
  assert.ok(!result.includes(UUID32D));
});

test('rewriteNotionLinks handles multiple links in one document', () => {
  const input = [
    `[Page 1](Page%201%20${UUID32}.md)`,
    `[Page 2](Page%202%20${UUID32C}.md)`,
    '[External](https://example.com)',
  ].join(' ');

  const result = rewriteNotionLinks(input);
  assert.ok(!result.includes(UUID32));
  assert.ok(!result.includes(UUID32C));
  assert.ok(result.includes('https://example.com'));
});

// ---------------------------------------------------------------------------
// notionImporter.convert
// ---------------------------------------------------------------------------

test('notionImporter rejects non-zip file', async () => {
  const bytes = new TextEncoder().encode('{}');
  await assert.rejects(() => notionImporter.convert(bytes, 'export.json'), /\.zip/i);
});

// ---------------------------------------------------------------------------
// Two-device convergence: same Notion export, same vault paths
// ---------------------------------------------------------------------------

test('Notion path stripping is deterministic (convergence)', () => {
  // Two devices import the same Notion export; they must end up with same paths.
  const path1 = notionPathToVaultPath(`Meeting Notes ${UUID32}.md`);
  const path2 = notionPathToVaultPath(`Meeting Notes ${UUID32}.md`);
  assert.equal(path1, path2);
  assert.equal(path1, 'Meeting Notes.md');
});
