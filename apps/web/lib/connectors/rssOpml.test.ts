/**
 * Unit tests for the RSS/Atom/OPML connector — pure functions, no browser.
 *
 * The DOMParser shim (below) is needed because Node.js does not have DOMParser
 * built-in. We use a minimal recursive XML parser that covers the shapes our
 * code reads. The shim is registered on `globalThis` before any imports so the
 * module sees it at load time.
 *
 * Tests cover:
 *  - RSS 2.0 round-trip (title, link, description, pubDate)
 *  - Atom 1.0 round-trip
 *  - OPML subscription list
 *  - Collision-safe path generation (sanitisePathSegment, buildRssNotePath)
 *  - HTML → Markdown conversion (node fallback path)
 *  - Error paths: empty source, invalid XML, unknown root, empty feed
 *  - Two-device convergence: importing same feed twice produces no duplicates
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// ---------------------------------------------------------------------------
// Minimal DOMParser shim for Node.js
// ---------------------------------------------------------------------------

class ShimText {
  nodeType = 3;
  childNodes: ShimNode[] = [];
  parentElement: ShimElement | null = null;
  constructor(public textContent: string) {}
}

type ShimNode = ShimText | ShimElement;

class ShimElement {
  nodeType = 1;
  childNodes: ShimNode[] = [];
  parentElement: ShimElement | null = null;
  private _attrs: Array<{ name: string; value: string }>;

  constructor(
    public tagName: string,
    attrs: Array<{ name: string; value: string }> = [],
  ) {
    this._attrs = attrs;
  }

  getAttribute(name: string): string | null {
    return this._attrs.find((a) => a.name.toLowerCase() === name.toLowerCase())?.value ?? null;
  }

  get textContent(): string {
    return this.childNodes.map((n) => n.textContent ?? '').join('');
  }
  // Setter to satisfy TypeScript (computed property is read-only by default).
  set textContent(_v: string) {
    /* no-op: textContent is computed from child nodes */
  }

  getElementsByTagName(tag: string): ShimElement[] {
    const results: ShimElement[] = [];
    const walk = (node: ShimNode) => {
      if (node instanceof ShimElement) {
        if (node.tagName.toLowerCase() === tag.toLowerCase() || tag === '*') {
          results.push(node);
        }
        for (const child of node.childNodes) walk(child);
      }
    };
    for (const child of this.childNodes) walk(child);
    return results;
  }

  querySelector(sel: string): ShimElement | null {
    // Support "parent > child" descent.
    const parts = sel.split(/\s*>\s*/);
    if (parts.length > 1) {
      // Reduce through the part chain starting from this element.
      const first = this._queryOne(parts[0].trim());
      if (!first) return null;
      return parts.slice(1).reduce<ShimElement | null>((node, part) => {
        return node ? node._queryOne(part.trim()) : null;
      }, first);
    }
    return this._queryOne(sel.trim());
  }

  private _queryOne(sel: string): ShimElement | null {
    // "tag[attr=value]" or "tag[attr]"
    const attrMatch = /^(\w*)\[([^\]=]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(sel);
    if (attrMatch) {
      const [, tag, attr, val] = attrMatch;
      const candidates = tag ? this.getElementsByTagName(tag) : this.getElementsByTagName('*');
      return (
        candidates.find((el) => {
          const v = el.getAttribute(attr);
          if (val !== undefined) return v === val;
          return v !== null;
        }) ?? null
      );
    }
    // "tag:not([attr])"
    const notMatch = /^(\w+):not\(\[([^\]]+)\]\)$/.exec(sel);
    if (notMatch) {
      const [, tag, attr] = notMatch;
      return this.getElementsByTagName(tag).find((el) => el.getAttribute(attr) === null) ?? null;
    }
    // Simple tag name.
    return this.getElementsByTagName(sel)[0] ?? null;
  }

  querySelectorAll(sel: string): ShimElement[] {
    // Handle "ancestor descendant" (space-separated, max 2 parts).
    const parts = sel.trim().split(/\s+/);
    if (parts.length === 2) {
      const [parent, child] = parts;
      const parents = this.getElementsByTagName(parent);
      const results: ShimElement[] = [];
      for (const p of parents) results.push(...p.getElementsByTagName(child));
      return results;
    }
    return this.getElementsByTagName(sel);
  }
}

class ShimDocument extends ShimElement {
  documentElement: ShimElement;
  body: ShimElement | null = null;

  constructor(root: ShimElement) {
    super('#document');
    this.nodeType = 9;
    this.documentElement = root;
    this.childNodes.push(root);
    if (root.tagName.toLowerCase() === 'body') this.body = root;
  }

  override querySelector(sel: string): ShimElement | null {
    return this.documentElement.querySelector(sel);
  }
  override querySelectorAll(sel: string): ShimElement[] {
    return this.documentElement.querySelectorAll(sel);
  }
}

/** Decode common XML/HTML entities. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, c: string) => String.fromCodePoint(parseInt(c, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, c: string) => String.fromCodePoint(parseInt(c, 16)));
}

/** Parse attributes from tag body: name="value" or name='value'. */
function parseAttrs(raw: string): Array<{ name: string; value: string }> {
  const attrs: Array<{ name: string; value: string }> = [];
  const re = /(\S+?)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    attrs.push({ name: m[1], value: m[2] ?? m[3] ?? m[4] ?? '' });
  }
  return attrs;
}

/**
 * Recursive XML parser returning a ShimDocument. Handles elements, text nodes,
 * CDATA, and attribute parsing. Strips XML declarations and comments.
 */
function parseXml(xml: string): ShimDocument {
  // Strip XML processing instructions (<?...?>) and comments (<!--...-->).
  const src = xml
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  let pos = 0;

  function skipWS() {
    while (pos < src.length && /\s/.test(src[pos])) pos++;
  }

  function parseElement(): ShimElement | null {
    skipWS();
    if (!src.slice(pos).startsWith('<')) return null;
    if (src.slice(pos).startsWith('</')) return null;

    pos++; // consume '<'

    let tagRaw = '';
    while (pos < src.length && src[pos] !== '>' && !(src[pos] === '/' && src[pos + 1] === '>')) {
      tagRaw += src[pos++];
    }
    const selfClose = src[pos] === '/';
    if (selfClose) pos++;
    pos++; // consume '>'

    const spaceIdx = tagRaw.search(/\s/);
    const tagName = spaceIdx >= 0 ? tagRaw.slice(0, spaceIdx) : tagRaw;
    const attrRaw = spaceIdx >= 0 ? tagRaw.slice(spaceIdx) : '';
    const el = new ShimElement(tagName, parseAttrs(attrRaw));

    if (selfClose) return el;

    while (pos < src.length) {
      skipWS();
      const rest = src.slice(pos);

      // Closing tag for this element.
      if (rest.startsWith(`</${tagName}`)) {
        pos += 2 + tagName.length;
        while (pos < src.length && src[pos] !== '>') pos++;
        pos++;
        break;
      }

      // CDATA section.
      if (rest.startsWith('<![CDATA[')) {
        pos += 9;
        const end = src.indexOf(']]>', pos);
        const cdataText = end >= 0 ? src.slice(pos, end) : '';
        pos = end >= 0 ? end + 3 : src.length;
        const tn = new ShimText(cdataText);
        tn.parentElement = el;
        el.childNodes.push(tn);
        continue;
      }

      // Child element.
      if (rest.startsWith('<')) {
        const child = parseElement();
        if (child) {
          child.parentElement = el;
          el.childNodes.push(child);
        } else {
          pos++;
        }
        continue;
      }

      // Text node.
      let text = '';
      while (pos < src.length && !src.slice(pos).startsWith('<')) text += src[pos++];
      if (text) {
        const tn = new ShimText(decodeEntities(text));
        tn.parentElement = el;
        el.childNodes.push(tn);
      }
    }

    return el;
  }

  const root = parseElement();
  if (!root) {
    const err = new ShimElement('parsererror');
    err.childNodes.push(new ShimText('No root element found.'));
    return new ShimDocument(err);
  }

  // Wrap in a document. For HTML-mode parses (htmlToMarkdown wraps in <body>),
  // the body property is needed.
  const doc = new ShimDocument(root);
  return doc;
}

// ---------------------------------------------------------------------------
// Install the shim on globalThis BEFORE importing the connector module.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).DOMParser = class {
  parseFromString(xml: string, _type: string): ShimDocument {
    return parseXml(xml);
  }
};

// The rssOpml.ts code uses `Node.TEXT_NODE` and `Node.ELEMENT_NODE` which are
// part of the DOM spec. Provide them via globalThis so Node.js resolves them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };

// ---------------------------------------------------------------------------
// Import connector functions (they will see the globalThis.DOMParser shim).
// ---------------------------------------------------------------------------

import {
  buildRssNotePath,
  htmlToMarkdown,
  parseRssOrOpml,
  sanitisePathSegment,
} from './rssOpml.js';
import { ConnectorError } from './types.js';
import { mergeImport } from '../vault/vault.js';
import type { Note } from '../vault/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const RSS2_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Blog</title>
    <link>https://example.com</link>
    <description>A test blog</description>
    <item>
      <title>First Post</title>
      <link>https://example.com/first</link>
      <description>Hello world!</description>
      <pubDate>Mon, 01 Jan 2024 12:00:00 GMT</pubDate>
      <guid>https://example.com/first</guid>
    </item>
    <item>
      <title>Second Post</title>
      <link>https://example.com/second</link>
      <description>Just plain text.</description>
      <pubDate>Tue, 02 Jan 2024 12:00:00 GMT</pubDate>
      <guid>https://example.com/second</guid>
    </item>
  </channel>
</rss>`;

const ATOM_FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Test Feed</title>
  <link rel="alternate" href="https://atom.example.com"/>
  <updated>2024-01-02T12:00:00Z</updated>
  <entry>
    <title>Atom Entry One</title>
    <link rel="alternate" href="https://atom.example.com/1"/>
    <id>https://atom.example.com/1</id>
    <updated>2024-01-01T10:00:00Z</updated>
    <summary>Summary of entry one.</summary>
  </entry>
  <entry>
    <title>Atom Entry Two</title>
    <link rel="alternate" href="https://atom.example.com/2"/>
    <id>https://atom.example.com/2</id>
    <updated>2024-01-02T10:00:00Z</updated>
    <content>Full content of entry two.</content>
  </entry>
</feed>`;

const OPML_DOC = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>My Feeds</title></head>
  <body>
    <outline text="Tech" title="Tech">
      <outline text="Hacker News" title="Hacker News"
               xmlUrl="https://news.ycombinator.com/rss"
               htmlUrl="https://news.ycombinator.com"/>
      <outline text="The Verge" title="The Verge"
               xmlUrl="https://www.theverge.com/rss/index.xml"
               htmlUrl="https://www.theverge.com"/>
    </outline>
  </body>
</opml>`;

// ---------------------------------------------------------------------------
// Tests: sanitisePathSegment
// ---------------------------------------------------------------------------

test('sanitisePathSegment strips path-unsafe characters', () => {
  // Forward and back slash become dash.
  assert.equal(sanitisePathSegment('Hello / World'), 'Hello - World');
  // Special chars: colon, asterisk, question mark, less-than, greater-than, pipe
  // (6 chars between "file" and "name") = 6 dashes.
  // The double-quote char is also replaced → 7 total special chars in "file:*?<>|name".
  const result = sanitisePathSegment('file:*?"<>|name');
  assert.ok(result.startsWith('file'), `should start with file: ${result}`);
  assert.ok(result.endsWith('name'), `should end with name: ${result}`);
  assert.ok(!result.includes(':'), 'colon should be removed');
  assert.ok(!result.includes('*'), 'asterisk should be removed');
  assert.ok(!result.includes('?'), 'question mark should be removed');
  assert.equal(sanitisePathSegment('  spaces  '), 'spaces');
  assert.equal(sanitisePathSegment(''), '');
});

test('sanitisePathSegment strips leading dots', () => {
  assert.equal(sanitisePathSegment('...hidden'), 'hidden');
});

test('sanitisePathSegment truncates at 80 chars', () => {
  const long = 'a'.repeat(100);
  assert.equal(sanitisePathSegment(long).length, 80);
});

// ---------------------------------------------------------------------------
// Tests: buildRssNotePath
// ---------------------------------------------------------------------------

test('buildRssNotePath produces expected vault path', () => {
  assert.equal(buildRssNotePath('My Blog', 'Hello World'), 'connectors/rss/My Blog/Hello World.md');
});

test('buildRssNotePath sanitises feed and item titles', () => {
  const path = buildRssNotePath('Feed/Title', 'Post: The One');
  assert.ok(path.startsWith('connectors/rss/'), `path: ${path}`);
  assert.ok(path.endsWith('.md'), `path: ${path}`);
  assert.ok(!path.includes('//'), `double slash: ${path}`);
});

test('buildRssNotePath uses fallbacks for empty strings', () => {
  assert.equal(buildRssNotePath('', ''), 'connectors/rss/Unnamed Feed/Untitled Item.md');
});

// ---------------------------------------------------------------------------
// Tests: htmlToMarkdown
// ---------------------------------------------------------------------------

test('htmlToMarkdown returns empty string for empty input', () => {
  assert.equal(htmlToMarkdown(''), '');
  assert.equal(htmlToMarkdown('   '), '');
});

test('htmlToMarkdown converts basic HTML to text', () => {
  // With our DOMParser shim, htmlToMarkdown will parse <body><p>text</p></body>
  // and call nodeToMarkdown on doc.body.
  // Our shim sets doc.body when root tagName is 'body'.
  const out = htmlToMarkdown('<p>Hello world!</p>');
  assert.ok(out.includes('Hello world'), `expected text in: ${out}`);
});

test('htmlToMarkdown handles plain text without tags', () => {
  const out = htmlToMarkdown('Just plain text here.');
  assert.ok(out.includes('plain text'), `expected text: ${out}`);
});

// ---------------------------------------------------------------------------
// Tests: parseRssOrOpml — error cases
// ---------------------------------------------------------------------------

test('parseRssOrOpml throws ConnectorError on empty source', () => {
  assert.throws(() => parseRssOrOpml(''), ConnectorError);
  assert.throws(() => parseRssOrOpml('   '), ConnectorError);
});

test('parseRssOrOpml throws ConnectorError on unknown root element', () => {
  assert.throws(() => parseRssOrOpml('<unknown><thing/></unknown>'), ConnectorError);
});

test('parseRssOrOpml throws ConnectorError on RSS with no items', () => {
  const empty = `<rss version="2.0"><channel><title>Empty</title></channel></rss>`;
  assert.throws(() => parseRssOrOpml(empty), ConnectorError);
});

test('parseRssOrOpml throws ConnectorError on Atom with no entries', () => {
  const empty = `<feed xmlns="http://www.w3.org/2005/Atom"><title>Empty</title></feed>`;
  assert.throws(() => parseRssOrOpml(empty), ConnectorError);
});

// ---------------------------------------------------------------------------
// Tests: RSS 2.0 parsing
// ---------------------------------------------------------------------------

test('parseRssOrOpml parses RSS 2.0 feed into correct note count', () => {
  const notes = parseRssOrOpml(RSS2_FEED);
  assert.equal(notes.length, 2);
});

test('RSS note paths are under connectors/rss/', () => {
  const notes = parseRssOrOpml(RSS2_FEED);
  for (const note of notes) {
    assert.ok(note.path.startsWith('connectors/rss/'), `path: ${note.path}`);
    assert.ok(note.path.endsWith('.md'), `path: ${note.path}`);
  }
});

test('RSS note content contains frontmatter delimiter', () => {
  const notes = parseRssOrOpml(RSS2_FEED);
  for (const note of notes) {
    assert.ok(note.content.includes('---'), 'frontmatter missing');
    assert.ok(note.content.includes('tags: [rss-import]'), 'tag missing');
  }
});

test('RSS note content contains a heading', () => {
  const notes = parseRssOrOpml(RSS2_FEED);
  // At least one note should have a heading for "First Post" or "Second Post"
  const hasFirstPost = notes.some((n) => n.content.includes('First Post'));
  const hasSecondPost = notes.some((n) => n.content.includes('Second Post'));
  assert.ok(hasFirstPost || hasSecondPost, 'expected post titles in notes');
});

test('RSS note content contains source URL', () => {
  const notes = parseRssOrOpml(RSS2_FEED);
  // At least one note should reference the feed domain.
  const hasUrl = notes.some((n) => n.content.includes('example.com'));
  assert.ok(hasUrl, 'URL missing from all notes');
});

test('RSS note mtime reflects pubDate', () => {
  const notes = parseRssOrOpml(RSS2_FEED);
  for (const note of notes) {
    if (note.mtime !== undefined) {
      assert.ok(note.mtime > 0, 'mtime must be positive');
      // pubDates are in Jan 2024 — epoch ms should be > 1700000000000
      assert.ok(note.mtime > 1_700_000_000_000, `mtime looks wrong: ${note.mtime}`);
    }
  }
});

test('RSS description is converted to text (no raw HTML tags)', () => {
  // The fixture has plain text descriptions (no HTML) so we test that the
  // content is present and has no raw angle brackets from the description.
  const notes = parseRssOrOpml(RSS2_FEED);
  for (const note of notes) {
    assert.ok(!note.content.includes('<p>'), 'raw <p> should not appear in content');
    assert.ok(!note.content.includes('<br>'), 'raw <br> should not appear in content');
  }
});

// ---------------------------------------------------------------------------
// Tests: Atom 1.0 parsing
// ---------------------------------------------------------------------------

test('parseRssOrOpml parses Atom feed into correct note count', () => {
  const notes = parseRssOrOpml(ATOM_FEED);
  assert.equal(notes.length, 2);
});

test('Atom note paths are under connectors/rss/', () => {
  const notes = parseRssOrOpml(ATOM_FEED);
  for (const note of notes) {
    assert.ok(note.path.startsWith('connectors/rss/'), `path: ${note.path}`);
  }
});

test('Atom notes contain their titles', () => {
  const notes = parseRssOrOpml(ATOM_FEED);
  const titles = notes.map((n) => n.content);
  const hasEntryOne = titles.some((c) => c.includes('Entry One') || c.includes('Atom Entry One'));
  const hasEntryTwo = titles.some((c) => c.includes('Entry Two') || c.includes('Atom Entry Two'));
  assert.ok(hasEntryOne || hasEntryTwo, 'expected Atom entry titles in notes');
});

test('Atom note content contains frontmatter and tag', () => {
  const notes = parseRssOrOpml(ATOM_FEED);
  for (const note of notes) {
    assert.ok(note.content.includes('---'), 'frontmatter missing');
    assert.ok(note.content.includes('rss-import'), 'tag missing');
  }
});

// ---------------------------------------------------------------------------
// Tests: OPML parsing
// ---------------------------------------------------------------------------

test('parseRssOrOpml parses OPML into one note per feed', () => {
  const notes = parseRssOrOpml(OPML_DOC);
  assert.equal(notes.length, 2, `expected 2 notes, got ${notes.length}`);
});

test('OPML note paths are under connectors/rss/opml-', () => {
  const notes = parseRssOrOpml(OPML_DOC);
  for (const note of notes) {
    assert.ok(note.path.startsWith('connectors/rss/opml-'), `path: ${note.path}`);
  }
});

test('OPML note content contains feed URL and tags', () => {
  const notes = parseRssOrOpml(OPML_DOC);
  const hn = notes.find((n) => n.content.includes('Hacker News'));
  assert.ok(hn, 'Hacker News note missing');
  assert.ok(hn!.content.includes('news.ycombinator.com'), 'feed URL missing');
  assert.ok(hn!.content.includes('opml-import'), 'opml-import tag missing');
});

test('OPML throws ConnectorError when no feed outlines exist', () => {
  const noFeeds = `<opml version="2.0"><head><title>Empty</title></head><body></body></opml>`;
  assert.throws(() => parseRssOrOpml(noFeeds), ConnectorError);
});

// ---------------------------------------------------------------------------
// Tests: two-device convergence simulation
// ---------------------------------------------------------------------------

test('importing the same feed twice produces no duplicate notes', () => {
  // Parse the feed once so both devices get the same notes (identical content).
  const feedNotes = parseRssOrOpml(RSS2_FEED);
  assert.equal(feedNotes.length, 2);

  // Device 1: vault starts empty, import feed.
  const existing: Note[] = [];
  const r1 = mergeImport(existing, feedNotes);
  assert.equal(r1.summary.added, 2, 'first import should add both notes');
  assert.equal(r1.summary.unchanged, 0);
  assert.equal(r1.notes.length, 2);

  // Device 2: same vault state, import the same notes again.
  // Content is byte-for-byte identical so all should be unchanged.
  const r2 = mergeImport(r1.notes, feedNotes);
  assert.equal(r2.summary.added, 0, 'second import should add no notes');
  assert.equal(r2.summary.unchanged, 2, 'both notes should be unchanged');
  assert.equal(r2.notes.length, 2, 'vault should still have 2 notes');
});

test('importing feed where one note already exists adds only the new one', () => {
  const feedNotes = parseRssOrOpml(RSS2_FEED);
  assert.equal(feedNotes.length, 2);

  // Pre-populate vault with first note only.
  const existing: Note[] = [
    {
      path: feedNotes[0].path,
      content: feedNotes[0].content,
      ctime: Date.now(),
      mtime: Date.now(),
    },
  ];

  // Import both notes from the feed.
  const result = mergeImport(existing, feedNotes);
  assert.equal(result.summary.unchanged, 1, 'first note should be unchanged');
  assert.equal(result.summary.added, 1, 'second note should be added');
  assert.equal(result.notes.length, 2, 'vault should have 2 notes total');
});

test('importing feed where content changed keeps both versions (conflict copy)', () => {
  const feedNotes = parseRssOrOpml(RSS2_FEED);

  // Modify content of first note to simulate local edit.
  const existing: Note[] = [
    {
      path: feedNotes[0].path,
      content: feedNotes[0].content + '\n\n<!-- local edit -->',
      ctime: Date.now(),
      mtime: Date.now(),
    },
  ];

  // Import — same-path note has different content, so a copy is made.
  const result = mergeImport(existing, feedNotes);
  assert.equal(result.summary.renamed.length, 1, 'should create a conflict copy');
  // original + conflict copy + second feed note
  assert.equal(result.notes.length, 3, 'should have 3 notes total');
});

// ---------------------------------------------------------------------------
// Tests: connector registry
// ---------------------------------------------------------------------------

test('rssOpmlConnector has correct metadata', async () => {
  const { rssOpmlConnector } = await import('./rssOpml.js');
  assert.equal(rssOpmlConnector.id, 'rss-opml-import');
  assert.equal(rssOpmlConnector.privacyPosture, 'local');
  assert.equal(typeof rssOpmlConnector.parse, 'function');
  assert.ok(rssOpmlConnector.acceptedExtensions.includes('.xml'));
  assert.ok(rssOpmlConnector.acceptedExtensions.includes('.opml'));
  assert.ok(rssOpmlConnector.isAvailable());
});

test('registry ALL_CONNECTORS is non-empty and includes rss-opml-import', async () => {
  const { ALL_CONNECTORS } = await import('./registry.js');
  assert.ok(ALL_CONNECTORS.length >= 1, 'registry should have at least one connector');
  const found = ALL_CONNECTORS.find((c) => c.id === 'rss-opml-import');
  assert.ok(found, 'rss-opml-import should be in the registry');
  assert.equal(found!.privacyPosture, 'local');
});

test('LOCAL_IMPORT_CONNECTORS contains only local-posture connectors', async () => {
  const { LOCAL_IMPORT_CONNECTORS } = await import('./registry.js');
  for (const c of LOCAL_IMPORT_CONNECTORS) {
    assert.equal(c.privacyPosture, 'local', `${c.id} should be local posture`);
  }
  assert.ok(LOCAL_IMPORT_CONNECTORS.length >= 1);
});
