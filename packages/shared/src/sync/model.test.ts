import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { filePathSchema } from './model.js';

test('filePathSchema normalizes paths to NFC (spec §2.1)', () => {
  // Build the NFD form explicitly so the source encoding can't be silently
  // normalized away: `e` + U+0301 combining acute accent.
  const nfd = 'notes/caf\u0065\u0301.md'; // e + U+0301 combining acute
  const nfc = 'notes/caf\u00e9.md'; // precomposed e-acute
  assert.notEqual(nfd, nfc); // distinct code-point sequences on the wire

  const parsed = filePathSchema.parse(nfd);
  // The schema output is the canonical NFC form, so two encodings of the same
  // path become a single identity before hashing/comparison.
  assert.equal(parsed, nfc);
  assert.equal(parsed.normalize('NFC'), parsed);
});

test('filePathSchema leaves already-NFC ASCII paths unchanged', () => {
  assert.equal(filePathSchema.parse('notes/a.md'), 'notes/a.md');
});

test('filePathSchema still rejects previously-invalid paths (backward compatible)', () => {
  assert.throws(() => filePathSchema.parse('/leading-slash.md'));
  assert.throws(() => filePathSchema.parse('a\\b.md'));
  assert.throws(() => filePathSchema.parse('a/../b.md'));
  assert.throws(() => filePathSchema.parse(''));
});
