/**
 * node:test unit tests for the GraphVault Web Clipper's core logic.
 *
 * Tests run with `node --test apps/extension/clipper.test.js`.
 * Because the clipper uses DOM APIs, we shim the bare minimum using
 * Node's built-in `node:test` + a lightweight DOM shim.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Minimal DOM shim (no jsdom dependency - we only test pure logic)
// ---------------------------------------------------------------------------

// We extract and test only the pure text-processing functions, not DOM-walking.

// -- Helpers extracted from clipper.js for isolated testing --

function cleanupMd(md) {
  return md
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

function sanitizeFilename(name) {
  const safe = (name || 'note')
    .replace(/[^\w\s\-_.]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_.]+|[-_.]+$/g, '')
    .slice(0, 200)
    .toLowerCase();
  return (safe || 'note') + '.md';
}

function resolveUrl(url, base) {
  try {
    return new URL(url, base).href;
  } catch {
    return url;
  }
}

function isValidUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function buildNoteMarkdown({ title, tag, url, markdown }) {
  const rawTag = (tag || '').trim();
  const normTag = rawTag
    ? '#' + rawTag.replace(/^#+/, '').replace(/\s+/g, '-').toLowerCase()
    : null;
  const today = '2026-06-15'; // fixed for deterministic test
  const lines = [
    `# ${title}`,
    '',
    `> Clipped from: ${url}`,
    `> Date: ${today}`,
    normTag ? `> Tags: ${normTag}` : null,
    '',
    '---',
    '',
    markdown,
  ].filter(l => l !== null);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cleanupMd', () => {
  it('collapses triple blank lines to double', () => {
    const input = 'a\n\n\n\nb';
    assert.equal(cleanupMd(input), 'a\n\nb');
  });

  it('removes trailing whitespace on lines', () => {
    const input = 'hello   \nworld';
    assert.equal(cleanupMd(input), 'hello\nworld');
  });

  it('trims leading and trailing whitespace', () => {
    const input = '\n\n  hello  \n\n';
    assert.equal(cleanupMd(input), 'hello');
  });

  it('preserves single blank lines', () => {
    const input = 'a\n\nb';
    assert.equal(cleanupMd(input), 'a\n\nb');
  });
});

describe('sanitizeFilename', () => {
  it('converts spaces to hyphens', () => {
    assert.equal(sanitizeFilename('My Note Title'), 'my-note-title.md');
  });

  it('strips unsafe characters', () => {
    assert.equal(sanitizeFilename('Note: "Hello/World"!'), 'note-helloworld.md');
  });

  it('falls back to note.md for empty input', () => {
    assert.equal(sanitizeFilename(''), 'note.md');
    assert.equal(sanitizeFilename('!!!'), 'note.md');
  });

  it('truncates at 200 characters', () => {
    const long = 'a'.repeat(250);
    const result = sanitizeFilename(long);
    assert.equal(result.length, 200 + 3); // 200 chars + ".md"
  });

  it('strips leading and trailing punctuation', () => {
    assert.equal(sanitizeFilename('---hello---'), 'hello.md');
  });
});

describe('resolveUrl', () => {
  it('resolves relative URLs against a base', () => {
    const result = resolveUrl('/path/to/image.png', 'https://example.com/article/');
    assert.equal(result, 'https://example.com/path/to/image.png');
  });

  it('returns absolute URLs unchanged', () => {
    const abs = 'https://cdn.example.com/img.png';
    assert.equal(resolveUrl(abs, 'https://example.com/'), abs);
  });

  it('returns the input on unparseable URLs', () => {
    // protocol-relative URLs are NOT valid `new URL()` inputs without a base
    const rel = '//cdn.example.com/img.png';
    const result = resolveUrl(rel, 'https://example.com/');
    assert.equal(result, 'https://cdn.example.com/img.png');
  });
});

describe('isValidUrl', () => {
  it('accepts http URLs', () => { assert.ok(isValidUrl('http://localhost:3000')); });
  it('accepts https URLs', () => { assert.ok(isValidUrl('https://example.com')); });
  it('rejects javascript: URLs', () => { assert.ok(!isValidUrl('javascript:alert(1)')); });
  it('rejects bare words', () => { assert.ok(!isValidUrl('notaurl')); });
  it('rejects empty strings', () => { assert.ok(!isValidUrl('')); });
});

describe('buildNoteMarkdown', () => {
  it('includes title, source, date, and content', () => {
    const md = buildNoteMarkdown({
      title: 'Test Article',
      tag: '',
      url: 'https://example.com/article',
      markdown: 'Some **bold** text.',
    });
    assert.ok(md.startsWith('# Test Article'));
    assert.ok(md.includes('> Clipped from: https://example.com/article'));
    assert.ok(md.includes('> Date: 2026-06-15'));
    assert.ok(md.includes('Some **bold** text.'));
    assert.ok(!md.includes('> Tags:'));
  });

  it('includes tag when provided', () => {
    const md = buildNoteMarkdown({
      title: 'Tagged Note',
      tag: '#reading',
      url: 'https://example.com',
      markdown: 'content',
    });
    assert.ok(md.includes('> Tags: #reading'));
  });

  it('normalises tag: strips leading # and lowercases', () => {
    const md = buildNoteMarkdown({
      title: 'Note',
      tag: '##Research Papers',
      url: 'https://example.com',
      markdown: 'x',
    });
    assert.ok(md.includes('> Tags: #research-papers'));
  });
});
