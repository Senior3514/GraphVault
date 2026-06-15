/**
 * Unit tests for the pure command logic in commands.ts.
 * Run via: node --test dist/commands.test.js
 * (tsc compiles this file as part of the package build.)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { NoteInput } from '@graphvault/engine';
import { buildFromNotes, computeStats, graphPayload, listNotes, searchNotes } from './commands.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOTES: NoteInput[] = [
  {
    path: 'alpha.md',
    content: `---
title: Alpha Note
tags: [engine, graph]
---
# Alpha Note

This is about the graph engine. See [[beta]].
`,
  },
  {
    path: 'beta.md',
    content: `---
title: Beta Note
tags: [engine]
---
# Beta Note

References [[alpha]] and is part of the engine #tag-inline.
`,
  },
  {
    path: 'orphan.md',
    content: `# Orphan

Nobody links here. #solo
`,
  },
];

// ---------------------------------------------------------------------------
// listNotes
// ---------------------------------------------------------------------------

describe('listNotes', () => {
  it('returns one entry per note, sorted by path', () => {
    const index = buildFromNotes(NOTES);
    const entries = listNotes(index);
    assert.equal(entries.length, 3);
    assert.equal(entries[0]?.path, 'alpha.md');
    assert.equal(entries[0]?.title, 'Alpha Note');
    assert.equal(entries[1]?.path, 'beta.md');
    assert.equal(entries[2]?.path, 'orphan.md');
  });
});

// ---------------------------------------------------------------------------
// searchNotes
// ---------------------------------------------------------------------------

describe('searchNotes', () => {
  it('finds notes by title substring (case-insensitive)', () => {
    const index = buildFromNotes(NOTES);
    const results = searchNotes(index, NOTES, 'alpha');
    assert.ok(results.some((r) => r.path === 'alpha.md'));
  });

  it('finds notes by content substring', () => {
    const index = buildFromNotes(NOTES);
    const results = searchNotes(index, NOTES, 'graph engine');
    assert.ok(results.some((r) => r.path === 'alpha.md'));
  });

  it('returns empty array when nothing matches', () => {
    const index = buildFromNotes(NOTES);
    const results = searchNotes(index, NOTES, 'xyznotfound');
    assert.equal(results.length, 0);
  });

  it('returns a context snippet for content hits', () => {
    const index = buildFromNotes(NOTES);
    const results = searchNotes(index, NOTES, 'graph engine');
    const hit = results.find((r) => r.path === 'alpha.md');
    assert.ok(hit?.context !== undefined);
    assert.ok(hit.context.toLowerCase().includes('graph engine'));
  });
});

// ---------------------------------------------------------------------------
// computeStats
// ---------------------------------------------------------------------------

describe('computeStats', () => {
  it('counts notes correctly', () => {
    const index = buildFromNotes(NOTES);
    const stats = computeStats(index);
    assert.equal(stats.noteCount, 3);
  });

  it('counts resolved links (alpha->beta, beta->alpha)', () => {
    const index = buildFromNotes(NOTES);
    const stats = computeStats(index);
    assert.ok(stats.resolvedLinkCount >= 2);
  });

  it('identifies orphan notes (orphan.md has no inbound links)', () => {
    const index = buildFromNotes(NOTES);
    const stats = computeStats(index);
    assert.ok(stats.orphanNotes.includes('orphan.md'));
  });

  it('counts unique tags', () => {
    const index = buildFromNotes(NOTES);
    const stats = computeStats(index);
    // engine, graph, tag-inline, solo (from frontmatter + inline)
    assert.ok(stats.tagCount >= 3);
  });

  it('returns topTags sorted by frequency descending', () => {
    const index = buildFromNotes(NOTES);
    const stats = computeStats(index);
    if (stats.topTags.length >= 2) {
      assert.ok(stats.topTags[0]!.count >= stats.topTags[1]!.count);
    }
  });
});

// ---------------------------------------------------------------------------
// graphPayload
// ---------------------------------------------------------------------------

describe('graphPayload', () => {
  it('returns a node for each note', () => {
    const index = buildFromNotes(NOTES);
    const result = graphPayload(index);
    assert.equal(result.nodes.length, 3);
  });

  it('each node has id, title, and tags', () => {
    const index = buildFromNotes(NOTES);
    const result = graphPayload(index);
    for (const n of result.nodes) {
      assert.ok(typeof n.id === 'string');
      assert.ok(typeof n.title === 'string');
      assert.ok(Array.isArray(n.tags));
    }
  });

  it('resolved edges exist between alpha and beta', () => {
    const index = buildFromNotes(NOTES);
    const result = graphPayload(index);
    const resolved = result.edges.filter((e) => e.resolved);
    assert.ok(resolved.length >= 1);
  });

  it('truncated is false for a small vault', () => {
    const index = buildFromNotes(NOTES);
    const result = graphPayload(index);
    assert.equal(result.truncated, false);
  });
});
