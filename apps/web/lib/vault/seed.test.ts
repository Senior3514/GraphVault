/**
 * Seed vault integrity tests.
 *
 * Asserts that the sample notes form a well-connected graph:
 *   - No orphan notes (every note has at least one outgoing wikilink
 *     OR is linked to by another note).
 *   - No broken wikilinks (all [[targets]] resolve to an existing note).
 *   - Sufficient coverage (≥ 10 notes, ≥ 3 unique tags).
 *   - Every note has a non-empty title (from frontmatter or H1).
 *   - Note paths are unique.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { parseNote } from './parse';
import { buildLinkResolver } from './links';
import { indexNotes } from './vault';
import { seedNotes } from './seed';

const raw = seedNotes();

// Build indexed notes (parse frontmatter, links, tags)
const indexed = raw.map((n) => ({ ...n, parsed: parseNote(n.path, n.content) }));
const resolver = buildLinkResolver(indexed);

test('seed vault has at least 10 notes', () => {
  assert.ok(raw.length >= 10, `Expected ≥10 notes, got ${raw.length}`);
});

test('seed vault note paths are unique', () => {
  const paths = raw.map((n) => n.path);
  const unique = new Set(paths);
  assert.equal(unique.size, paths.length, 'Duplicate note paths detected');
});

test('all notes have a non-empty title', () => {
  for (const note of indexed) {
    assert.ok(note.parsed.title.trim().length > 0, `Note "${note.path}" has an empty title`);
  }
});

test('seed vault covers at least 3 unique tags', () => {
  const tags = new Set<string>();
  for (const note of indexed) {
    for (const tag of note.parsed.tags) tags.add(tag);
  }
  assert.ok(tags.size >= 3, `Expected ≥3 unique tags, got ${tags.size}`);
});

test('all wikilink targets resolve to an existing note (no broken links)', () => {
  const broken: string[] = [];
  for (const note of indexed) {
    for (const link of note.parsed.links) {
      const resolved = resolver.resolve(link.target);
      if (!resolved) {
        broken.push(`"${note.path}" → [[${link.target}]]`);
      }
    }
  }
  assert.deepEqual(broken, [], `Broken wikilinks found:\n${broken.join('\n')}`);
});

test('no orphan notes: every note is reachable (has inbound or outbound links)', () => {
  // Build sets of all outbound-linked targets and all source notes.
  const outboundPaths = new Set<string>();
  const inboundPaths = new Set<string>();

  for (const note of indexed) {
    for (const link of note.parsed.links) {
      const resolved = resolver.resolve(link.target);
      if (resolved) {
        outboundPaths.add(note.path); // this note has outbound links
        inboundPaths.add(resolved); // the target has inbound links
      }
    }
  }

  const orphans: string[] = [];
  for (const note of indexed) {
    const hasOutbound = outboundPaths.has(note.path);
    const hasInbound = inboundPaths.has(note.path);
    if (!hasOutbound && !hasInbound) {
      orphans.push(note.path);
    }
  }

  assert.deepEqual(orphans, [], `Orphan notes (no links in or out):\n${orphans.join('\n')}`);
});

test('seed vault notes have realistic timestamps (ctime ≤ mtime)', () => {
  for (const note of raw) {
    assert.ok(
      note.ctime <= note.mtime,
      `Note "${note.path}": ctime (${note.ctime}) > mtime (${note.mtime})`,
    );
  }
});

test('seed notes use indexNotes without throwing', () => {
  // indexNotes is the full vault indexing pipeline — exercises parse + link resolution.
  assert.doesNotThrow(() => indexNotes(raw));
});
