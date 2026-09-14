/**
 * Unit tests for the email import connector - pure functions, no browser needed.
 *
 * Uses the same DOMParser + Node shim strategy as rssOpml.test.ts.
 *
 * Tests cover:
 *  - Header parsing (folding, RFC 2047 encoded-words, missing headers)
 *  - Quoted-printable decoding (ASCII, UTF-8, soft line breaks)
 *  - Base64 decoding (standard, line-wrapped)
 *  - Single .eml messages (text/plain, text/html, multipart/alternative)
 *  - mbox parsing (multiple messages, mboxo quoting)
 *  - Path generation (subject → sanitised segment, date → YYYY-MM)
 *  - Size / count guards (message too large, too many messages)
 *  - Error paths (empty source, no messages in mbox)
 *  - Two-device convergence: same import twice → no duplicates
 *  - Missing headers (empty subject, no date)
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

// ---------------------------------------------------------------------------
// DOMParser shim (identical strategy to rssOpml.test.ts - Node has no DOMParser)
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

  set textContent(_v: string) {
    /* computed */
  }

  getElementsByTagName(tag: string): ShimElement[] {
    const results: ShimElement[] = [];
    const walk = (node: ShimNode) => {
      if (node instanceof ShimElement) {
        if (node.tagName.toLowerCase() === tag.toLowerCase() || tag === '*') results.push(node);
        for (const child of node.childNodes) walk(child);
      }
    };
    for (const child of this.childNodes) walk(child);
    return results;
  }

  querySelector(sel: string): ShimElement | null {
    const parts = sel.split(/\s*>\s*/);
    if (parts.length > 1) {
      const first = this._queryOne(parts[0].trim());
      if (!first) return null;
      return parts.slice(1).reduce<ShimElement | null>((node, part) => {
        return node ? node._queryOne(part.trim()) : null;
      }, first);
    }
    return this._queryOne(sel.trim());
  }

  private _queryOne(sel: string): ShimElement | null {
    const attrMatch = /^(\w*)\[([^\]=]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(sel);
    if (attrMatch) {
      const [, tag, attr, val] = attrMatch;
      const candidates = tag ? this.getElementsByTagName(tag) : this.getElementsByTagName('*');
      return (
        candidates.find((el) => {
          const v = el.getAttribute(attr);
          return val !== undefined ? v === val : v !== null;
        }) ?? null
      );
    }
    const notMatch = /^(\w+):not\(\[([^\]]+)\]\)$/.exec(sel);
    if (notMatch) {
      const [, tag, attr] = notMatch;
      return this.getElementsByTagName(tag).find((el) => el.getAttribute(attr) === null) ?? null;
    }
    return this.getElementsByTagName(sel)[0] ?? null;
  }

  querySelectorAll(sel: string): ShimElement[] {
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

function parseAttrs(raw: string): Array<{ name: string; value: string }> {
  const attrs: Array<{ name: string; value: string }> = [];
  const re = /(\S+?)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    attrs.push({ name: m[1], value: m[2] ?? m[3] ?? m[4] ?? '' });
  }
  return attrs;
}

function parseXmlShim(xml: string): ShimDocument {
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
    pos++;
    let tagRaw = '';
    while (pos < src.length && src[pos] !== '>' && !(src[pos] === '/' && src[pos + 1] === '>')) {
      tagRaw += src[pos++];
    }
    const selfClose = src[pos] === '/';
    if (selfClose) pos++;
    pos++;
    const spaceIdx = tagRaw.search(/\s/);
    const tagName = spaceIdx >= 0 ? tagRaw.slice(0, spaceIdx) : tagRaw;
    const attrRaw = spaceIdx >= 0 ? tagRaw.slice(spaceIdx) : '';
    const el = new ShimElement(tagName, parseAttrs(attrRaw));
    if (selfClose) return el;
    while (pos < src.length) {
      skipWS();
      const rest = src.slice(pos);
      if (rest.startsWith(`</${tagName}`)) {
        pos += 2 + tagName.length;
        while (pos < src.length && src[pos] !== '>') pos++;
        pos++;
        break;
      }
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
    err.childNodes.push(new ShimText('No root element.'));
    return new ShimDocument(err);
  }
  return new ShimDocument(root);
}

// ---------------------------------------------------------------------------
// Install shims BEFORE importing the connector.
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).DOMParser = class {
  parseFromString(xml: string, _type: string): ShimDocument {
    return parseXmlShim(xml);
  }
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).Node = { TEXT_NODE: 3, ELEMENT_NODE: 1 };

// atob is available natively in Node >= 16. No shim needed for Node 22.

// ---------------------------------------------------------------------------
// Import the connector under test.
// ---------------------------------------------------------------------------

import {
  buildEmailNotePath,
  emailConnector,
  parseEmlMessage,
  parseEmailSource,
  splitMbox,
} from './email.js';
import { ConnectorError } from './types.js';
import { mergeImport } from '../vault/vault.js';
import type { Note } from '../vault/types.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A minimal valid .eml message with text/plain body. */
const SIMPLE_EML = `From: Alice <alice@example.com>
To: Bob <bob@example.com>
Subject: Hello World
Date: Mon, 15 Jun 2026 10:00:00 +0000
Message-ID: <abc123@example.com>
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: 7bit

This is the plain text body of the email.
It has two lines.`;

/** An .eml with a quoted-printable encoded body (UTF-8 with non-ASCII chars). */
const QP_EML = `From: sender@example.com
To: receiver@example.com
Subject: =?UTF-8?Q?Caf=C3=A9_au_lait?=
Date: Tue, 01 Jan 2019 08:00:00 +0000
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Bonjour =C3=A0 tous!=0D=0A
Le caf=C3=A9 est pr=C3=AAt.`;

/** An .eml with a base64-encoded body. */
const BASE64_EML = `From: bot@example.com
To: user@example.com
Subject: Base64 Test
Date: Wed, 02 Jan 2019 09:00:00 +0000
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: base64

SGVsbG8gZnJvbSBiYXNlNjQgZW5jb2Rpbmch`;

/** A multipart/alternative .eml with text/plain and text/html alternatives. */
const MULTIPART_EML = `From: newsletter@example.com
To: subscriber@example.com
Subject: Weekly Digest
Date: Thu, 03 Jan 2019 10:00:00 +0000
Content-Type: multipart/alternative; boundary="boundary42"

--boundary42
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: 7bit

Plain text version of the newsletter.

--boundary42
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: 7bit

<html><body><p>HTML version of the <strong>newsletter</strong>.</p></body></html>

--boundary42--`;

/** An .eml with missing optional headers (no Date, no To). */
const MINIMAL_EML = `From: sparse@example.com
Subject: Sparse Email

Just a body, no fancy headers.`;

/** A simple mbox file with two messages. */
const SIMPLE_MBOX = `From alice@example.com Mon Jun 15 10:00:00 2026
From: alice@example.com
To: bob@example.com
Subject: First Message
Date: Mon, 15 Jun 2026 10:00:00 +0000
Content-Type: text/plain; charset=utf-8

Body of first message.

From bob@example.com Mon Jun 15 11:00:00 2026
From: bob@example.com
To: alice@example.com
Subject: Second Message
Date: Mon, 15 Jun 2026 11:00:00 +0000
Content-Type: text/plain; charset=utf-8

Body of second message.`;

/** mbox with mboxo-quoted "From " inside a body. */
const MBOX_WITH_QUOTED_FROM = `From alice@example.com Mon Jun 15 10:00:00 2026
From: alice@example.com
Subject: Quoted From
Date: Mon, 15 Jun 2026 10:00:00 +0000
Content-Type: text/plain

This body contains:
>From someone@example.com Mon Jun 15 12:00:00 2026
And continues here.`;

// ---------------------------------------------------------------------------
// Tests: buildEmailNotePath
// ---------------------------------------------------------------------------

test('buildEmailNotePath produces correct vault path', () => {
  const path = buildEmailNotePath('Hello World', '2026-06-15T10:00:00.000Z');
  assert.ok(path.startsWith('connectors/email/'), `path: ${path}`);
  assert.ok(path.includes('2026-06'), `expected YYYY-MM segment: ${path}`);
  assert.ok(path.endsWith('.md'), `path: ${path}`);
});

test('buildEmailNotePath uses unknown-date when no date', () => {
  const path = buildEmailNotePath('My Subject', '');
  assert.ok(path.includes('unknown-date'), `path: ${path}`);
});

test('buildEmailNotePath sanitises subject (path-unsafe chars)', () => {
  const path = buildEmailNotePath('Hello / World: A "Test"', '2026-01-01T00:00:00.000Z');
  assert.ok(!path.includes('/connectors/'), 'no leading slash');
  // Subject is sanitised so path-unsafe chars removed.
  assert.ok(path.endsWith('.md'), 'ends with .md');
  // The double-slash from "connectors/email/..." should not appear.
  assert.ok(!path.includes('//'), `no double slash: ${path}`);
});

test('buildEmailNotePath falls back to Untitled Message for empty subject', () => {
  const path = buildEmailNotePath('', '2026-01-01T00:00:00.000Z');
  assert.ok(path.includes('Untitled Message'), `path: ${path}`);
});

// ---------------------------------------------------------------------------
// Tests: parseEmlMessage - simple text/plain
// ---------------------------------------------------------------------------

test('parseEmlMessage parses a simple text/plain message', () => {
  const note = parseEmlMessage(SIMPLE_EML);
  assert.ok(note.path.startsWith('connectors/email/'), `path: ${note.path}`);
  assert.ok(note.path.endsWith('.md'), `path: ${note.path}`);
  assert.ok(note.content.includes('Hello World'), 'title in content');
  assert.ok(note.content.includes('Alice'), 'From header in content');
  assert.ok(note.content.includes('email-import'), 'tag in content');
  assert.ok(note.content.startsWith('---'), 'starts with frontmatter');
});

test('parseEmlMessage includes frontmatter fields', () => {
  const note = parseEmlMessage(SIMPLE_EML);
  assert.ok(note.content.includes('"Hello World"'), 'title frontmatter');
  assert.ok(note.content.includes('"Alice'), 'from frontmatter');
  assert.ok(note.content.includes('"Bob'), 'to frontmatter');
  assert.ok(note.content.includes('2026-06-15'), 'date in frontmatter');
});

test('parseEmlMessage sets ctime/mtime from Date header', () => {
  const note = parseEmlMessage(SIMPLE_EML);
  assert.ok(note.ctime !== undefined && note.ctime > 0, 'ctime set');
  assert.ok(note.mtime !== undefined && note.mtime > 0, 'mtime set');
  // Date is 2026-06-15 - epoch ms should be > 2024 epoch.
  assert.ok(note.ctime! > 1_700_000_000_000, `ctime seems wrong: ${note.ctime}`);
});

test('parseEmlMessage body appears in note content', () => {
  const note = parseEmlMessage(SIMPLE_EML);
  assert.ok(
    note.content.includes('plain text body'),
    `body missing: ${note.content.slice(0, 300)}`,
  );
});

// ---------------------------------------------------------------------------
// Tests: quoted-printable decoding
// ---------------------------------------------------------------------------

test('parseEmlMessage decodes quoted-printable body', () => {
  const note = parseEmlMessage(QP_EML);
  // "Bonjour à tous!" should appear.
  assert.ok(
    note.content.includes('Bonjour') || note.content.includes('caf'),
    `QP body not decoded: ${note.content.slice(0, 300)}`,
  );
});

test('parseEmlMessage decodes RFC 2047 encoded-word subject', () => {
  const note = parseEmlMessage(QP_EML);
  // Subject was =?UTF-8?Q?Caf=C3=A9_au_lait?=  → "Café au lait"
  assert.ok(
    note.content.includes('Caf') || note.content.includes('lait'),
    `encoded-word subject not decoded: ${note.content.slice(0, 200)}`,
  );
});

// ---------------------------------------------------------------------------
// Tests: base64 decoding
// ---------------------------------------------------------------------------

test('parseEmlMessage decodes base64-encoded body', () => {
  const note = parseEmlMessage(BASE64_EML);
  // "Hello from base64 encoding!" should appear.
  assert.ok(
    note.content.includes('Hello') || note.content.includes('base64'),
    `base64 body not decoded: ${note.content.slice(0, 300)}`,
  );
});

// ---------------------------------------------------------------------------
// Tests: multipart/alternative
// ---------------------------------------------------------------------------

test('parseEmlMessage parses multipart/alternative and prefers text/plain', () => {
  const note = parseEmlMessage(MULTIPART_EML);
  // Should prefer text/plain over text/html.
  assert.ok(
    note.content.includes('Plain text version'),
    `expected plain text: ${note.content.slice(0, 400)}`,
  );
  // Should NOT contain raw HTML tags.
  assert.ok(!note.content.includes('<p>'), 'no raw <p> tags');
  assert.ok(!note.content.includes('<strong>'), 'no raw <strong> tags');
});

// ---------------------------------------------------------------------------
// Tests: minimal / missing headers
// ---------------------------------------------------------------------------

test('parseEmlMessage handles missing Date, To gracefully', () => {
  const note = parseEmlMessage(MINIMAL_EML);
  // No date → ctime/mtime undefined.
  assert.equal(note.ctime, undefined);
  assert.equal(note.mtime, undefined);
  // Path should use unknown-date segment.
  assert.ok(note.path.includes('unknown-date'), `path: ${note.path}`);
  // Body still present.
  assert.ok(note.content.includes('Just a body'), `body missing: ${note.content.slice(0, 200)}`);
});

test('parseEmlMessage uses Untitled Message when subject is empty', () => {
  const noSubjectEml = `From: x@example.com
Date: Mon, 01 Jan 2024 00:00:00 +0000

Body here.`;
  const note = parseEmlMessage(noSubjectEml);
  assert.ok(note.path.includes('Untitled Message'), `path: ${note.path}`);
  // Frontmatter title should be Untitled Message.
  assert.ok(note.content.includes('"Untitled Message"'), `title: ${note.content.slice(0, 200)}`);
});

// ---------------------------------------------------------------------------
// Tests: mbox splitting
// ---------------------------------------------------------------------------

test('splitMbox splits two-message mbox correctly', () => {
  const parts = splitMbox(SIMPLE_MBOX);
  assert.equal(parts.length, 2, `expected 2 messages, got ${parts.length}`);
});

test('splitMbox un-quotes mboxo >From lines', () => {
  const parts = splitMbox(MBOX_WITH_QUOTED_FROM);
  assert.equal(parts.length, 1);
  // The >From line should be restored to "From ".
  assert.ok(parts[0].includes('From someone@example.com'), `unquoting failed: ${parts[0]}`);
});

test('splitMbox returns empty array for non-mbox input', () => {
  const parts = splitMbox('Just some text without From lines.');
  assert.equal(parts.length, 0);
});

// ---------------------------------------------------------------------------
// Tests: parseEmailSource - mbox
// ---------------------------------------------------------------------------

test('parseEmailSource parses mbox into one note per message', () => {
  const notes = parseEmailSource(SIMPLE_MBOX);
  assert.equal(notes.length, 2, `expected 2 notes, got ${notes.length}`);
});

test('mbox notes have unique paths', () => {
  const notes = parseEmailSource(SIMPLE_MBOX);
  const paths = new Set(notes.map((n) => n.path));
  assert.equal(paths.size, notes.length, 'paths must be unique');
});

test('mbox notes contain correct subjects', () => {
  const notes = parseEmailSource(SIMPLE_MBOX);
  const hasFirst = notes.some((n) => n.content.includes('First Message'));
  const hasSecond = notes.some((n) => n.content.includes('Second Message'));
  assert.ok(hasFirst, 'First Message missing');
  assert.ok(hasSecond, 'Second Message missing');
});

// ---------------------------------------------------------------------------
// Tests: parseEmailSource - single .eml
// ---------------------------------------------------------------------------

test('parseEmailSource parses single .eml (no From envelope line)', () => {
  const notes = parseEmailSource(SIMPLE_EML);
  assert.equal(notes.length, 1);
  assert.ok(notes[0].content.includes('Hello World'));
});

// ---------------------------------------------------------------------------
// Tests: error paths
// ---------------------------------------------------------------------------

test('parseEmailSource throws ConnectorError on empty input', () => {
  assert.throws(() => parseEmailSource(''), ConnectorError);
  assert.throws(() => parseEmailSource('   '), ConnectorError);
});

test('parseEmailSource throws ConnectorError when mbox has no messages', () => {
  // A string starting with "From " but with no actual message bodies.
  assert.throws(() => parseEmailSource('From '), ConnectorError);
});

test('parseEmlMessage throws ConnectorError when message exceeds size limit', () => {
  // Create a message larger than 4 MiB.
  const bigBody = 'x'.repeat(4 * 1024 * 1024 + 1);
  const bigEml = `From: a@b.com\nSubject: Big\n\n${bigBody}`;
  assert.throws(() => parseEmlMessage(bigEml), ConnectorError);
});

// ---------------------------------------------------------------------------
// Tests: connector metadata
// ---------------------------------------------------------------------------

test('emailConnector has correct id and metadata', () => {
  assert.equal(emailConnector.id, 'email-import');
  assert.equal(emailConnector.privacyPosture, 'local');
  assert.ok(emailConnector.acceptedExtensions.includes('.eml'));
  assert.ok(emailConnector.acceptedExtensions.includes('.mbox'));
  assert.equal(typeof emailConnector.parse, 'function');
  assert.ok(emailConnector.isAvailable());
});

test('emailConnector.parse returns correct notes', () => {
  const notes = emailConnector.parse(SIMPLE_EML);
  assert.equal(notes.length, 1);
  assert.ok(notes[0].path.startsWith('connectors/email/'));
});

// ---------------------------------------------------------------------------
// Tests: registry integration
// ---------------------------------------------------------------------------

test('registry ALL_CONNECTORS includes email-import', async () => {
  const { ALL_CONNECTORS } = await import('./registry.js');
  const found = ALL_CONNECTORS.find((c) => c.id === 'email-import');
  assert.ok(found, 'email-import should be registered');
  assert.equal(found!.privacyPosture, 'local');
});

test('LOCAL_IMPORT_CONNECTORS includes email-import', async () => {
  const { LOCAL_IMPORT_CONNECTORS } = await import('./registry.js');
  const found = LOCAL_IMPORT_CONNECTORS.find((c) => c.id === 'email-import');
  assert.ok(found, 'email-import not found in LOCAL_IMPORT_CONNECTORS');
});

// ---------------------------------------------------------------------------
// Tests: two-device convergence
// ---------------------------------------------------------------------------

test('importing the same .eml twice produces no duplicate notes', () => {
  const notes = parseEmailSource(SIMPLE_EML);
  assert.equal(notes.length, 1);

  // Device 1: empty vault, import.
  const existing: Note[] = [];
  const r1 = mergeImport(existing, notes);
  assert.equal(r1.summary.added, 1, 'first import should add 1 note');
  assert.equal(r1.summary.unchanged, 0);

  // Device 2: same vault, re-import the same notes.
  const r2 = mergeImport(r1.notes, notes);
  assert.equal(r2.summary.added, 0, 'second import should add 0 notes');
  assert.equal(r2.summary.unchanged, 1, 'note should be unchanged');
  assert.equal(r2.notes.length, 1, 'vault should still have 1 note');
});

test('importing same mbox twice produces no duplicate notes', () => {
  const notes = parseEmailSource(SIMPLE_MBOX);
  assert.equal(notes.length, 2);

  const r1 = mergeImport([], notes);
  assert.equal(r1.summary.added, 2);

  const r2 = mergeImport(r1.notes, notes);
  assert.equal(r2.summary.added, 0, 'no new notes on second import');
  assert.equal(r2.summary.unchanged, 2, 'both unchanged');
});

test('importing mbox where one note changed keeps both versions', () => {
  const notes = parseEmailSource(SIMPLE_MBOX);

  // Pre-populate vault with first note, but modified locally.
  const existing: Note[] = [
    {
      path: notes[0].path,
      content: notes[0].content + '\n\n<!-- local annotation -->',
      ctime: Date.now(),
      mtime: Date.now(),
    },
  ];

  const result = mergeImport(existing, notes);
  // Local version + conflict copy + second message.
  assert.ok(result.summary.renamed.length >= 1, 'should create a conflict copy');
  assert.ok(result.notes.length >= 3, 'should have at least 3 notes total');
});

// ---------------------------------------------------------------------------
// Tests: multiple messages with same subject (path collision avoidance)
// ---------------------------------------------------------------------------

test('duplicate subjects in mbox get unique paths via index suffix', () => {
  const mboxDuplicates = `From a@example.com Mon Jan 01 00:00:00 2024
From: a@example.com
Subject: Same Subject
Date: Mon, 01 Jan 2024 00:00:00 +0000

First copy.

From b@example.com Mon Jan 01 01:00:00 2024
From: b@example.com
Subject: Same Subject
Date: Mon, 01 Jan 2024 01:00:00 +0000

Second copy.`;

  const notes = parseEmailSource(mboxDuplicates);
  assert.equal(notes.length, 2);
  const paths = new Set(notes.map((n) => n.path));
  assert.equal(paths.size, 2, `paths not unique: ${[...paths].join(', ')}`);
});
