/**
 * Prompt-builder tests against an in-memory snapshot (no network, no server).
 *
 * Each test asserts the built messages embed the expected note content/context,
 * and that an unknown path errors cleanly.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildIndex, type NoteInput } from '@graphvault/engine';
import type { FilePath } from '@graphvault/shared';
import type { VaultSnapshot } from './vault.js';
import {
  findConnectionsPrompt,
  searchAndSynthesizePrompt,
  summarizeNotePrompt,
} from './prompts.js';

const NOTES: Array<{ path: string; content: string; mtime: number }> = [
  {
    path: 'index.md',
    content: '---\ntitle: Home\n---\n# Home\n\nSee [[graphs]] and [[missing-note]]. #start',
    mtime: 10,
  },
  {
    path: 'notes/graphs.md',
    content: '# Graph Theory\n\nDijkstra notes about graphs and edges. #math\n\nBack to [[Home]].',
    mtime: 20,
  },
  {
    path: 'notes/algorithms.md',
    content: '# Algorithms\n\nMore Dijkstra over a [[graphs|graph]]. #math',
    mtime: 30,
  },
];

function makeSnapshot(): VaultSnapshot {
  const inputs: NoteInput[] = NOTES.map((n) => ({
    path: n.path as FilePath,
    content: n.content,
    updatedAt: n.mtime,
  }));
  const index = buildIndex(inputs);
  const contentByPath = new Map<string, string>(NOTES.map((n) => [n.path, n.content]));
  return {
    index,
    contentByPath,
    notes: NOTES.map((n) => ({ path: n.path as FilePath, content: n.content, mtime: n.mtime })),
    builtAt: 0,
  };
}

/** Concatenate all text content of a prompt result for substring assertions. */
function allText(result: {
  messages: Array<{ content: { type: string; text?: string } }>;
}): string {
  return result.messages
    .map((m) => (m.content.type === 'text' ? (m.content.text ?? '') : ''))
    .join('\n');
}

test('summarizeNotePrompt embeds the note content and a summarize instruction', () => {
  const result = summarizeNotePrompt(makeSnapshot(), 'notes/graphs.md');
  const text = allText(result);
  assert.match(text, /# Graph Theory/);
  assert.match(text, /graphs and edges/);
  assert.match(text, /[Ss]ummariz/);
  assert.match(text, /notes\/graphs\.md/);
});

test('summarizeNotePrompt errors cleanly on an unknown path', () => {
  assert.throws(() => summarizeNotePrompt(makeSnapshot(), 'nope.md'), /Note not found/);
});

test('findConnectionsPrompt embeds the note, its backlinks and neighbors', () => {
  const result = findConnectionsPrompt(makeSnapshot(), 'notes/graphs.md');
  const text = allText(result);
  // Note body is embedded.
  assert.match(text, /Graph Theory/);
  // Backlinks: index.md and algorithms.md both link to graphs.
  assert.match(text, /index\.md/);
  assert.match(text, /notes\/algorithms\.md/);
  // It asks for missing links.
  assert.match(text, /missing/i);
});

test('findConnectionsPrompt errors cleanly on an unknown path', () => {
  assert.throws(() => findConnectionsPrompt(makeSnapshot(), 'ghost.md'), /Note not found/);
});

test('searchAndSynthesizePrompt embeds the top matching notes for a query', () => {
  const result = searchAndSynthesizePrompt(makeSnapshot(), 'Dijkstra');
  const text = allText(result);
  // Both notes mentioning Dijkstra are embedded, with their paths as headings.
  assert.match(text, /notes\/graphs\.md/);
  assert.match(text, /notes\/algorithms\.md/);
  assert.match(text, /[Ss]ynthesize/);
});

test('searchAndSynthesizePrompt handles a query with no matches gracefully', () => {
  const result = searchAndSynthesizePrompt(makeSnapshot(), 'zzz-nonexistent-term');
  const text = allText(result);
  assert.match(text, /no matching notes|related search terms/);
});
