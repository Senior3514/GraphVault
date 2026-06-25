import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  buildVaultZip,
  exportNotesToJson,
  parseJsonExport,
  readVaultZip,
  safeImportPath,
} from './portability';
import { mergeImport } from './vault';
import type { Note } from './types';

function note(path: string, content: string, t = 1000): Note {
  return { path, content, ctime: t, mtime: t };
}

const sample: Note[] = [
  note('Welcome.md', '# Welcome\n\nHello [[notes/ideas]].'),
  note('notes/ideas.md', '# Ideas\n\n#brainstorm a thought.'),
  note('notes/deep/nested.md', 'nested body'),
];

test('JSON export round-trips losslessly', () => {
  const json = exportNotesToJson(sample);
  const entries = parseJsonExport(json);
  assert.equal(entries.length, sample.length);
  for (const n of sample) {
    const found = entries.find((e) => e.path === n.path);
    assert.ok(found, `missing ${n.path}`);
    assert.equal(found!.content, n.content);
  }
});

test('parseJsonExport rejects a non-GraphVault file', () => {
  assert.throws(() => parseJsonExport('{"format":"something-else"}'));
  assert.throws(() => parseJsonExport('not json at all'));
});

test('ZIP (store) round-trips content and paths exactly', async () => {
  const zip = buildVaultZip(sample);
  const entries = await readVaultZip(zip);
  assert.equal(entries.length, sample.length);
  for (const n of sample) {
    const found = entries.find((e) => e.path === n.path);
    assert.ok(found, `missing ${n.path}`);
    assert.equal(found!.content, n.content);
  }
});

test('safeImportPath blocks zip-slip and absolute/traversal paths', () => {
  assert.equal(safeImportPath('../../etc/passwd.md'), null);
  assert.equal(safeImportPath('/etc/passwd.md'), null);
  assert.equal(safeImportPath('C:\\secrets\\x.md'), null);
  assert.equal(safeImportPath('notes/../../escape.md'), null);
  assert.equal(safeImportPath('folder/'), null); // directory entry
  assert.equal(safeImportPath('image.png'), null); // non-text
  assert.equal(safeImportPath('notes/ok.md'), 'notes/ok.md');
  assert.equal(safeImportPath('./a/b.md'), 'a/b.md');
});

test('mergeImport adds new notes', () => {
  const { notes, summary } = mergeImport(sample, [{ path: 'fresh.md', content: 'new' }]);
  assert.equal(summary.added, 1);
  assert.equal(summary.renamed.length, 0);
  assert.ok(notes.some((n) => n.path === 'fresh.md'));
});

test('mergeImport never overwrites — keeps a conflict copy', () => {
  const { notes, summary } = mergeImport(sample, [
    { path: 'Welcome.md', content: 'DIFFERENT content' },
  ]);
  assert.equal(summary.added, 0);
  assert.equal(summary.renamed.length, 1);
  assert.equal(summary.renamed[0].from, 'Welcome.md');
  assert.equal(summary.renamed[0].to, 'Welcome (imported).md');
  // Original survives untouched.
  const original = notes.find((n) => n.path === 'Welcome.md');
  assert.equal(original!.content, '# Welcome\n\nHello [[notes/ideas]].');
  // Imported copy is kept alongside.
  assert.ok(notes.some((n) => n.path === 'Welcome (imported).md'));
});

test('mergeImport skips byte-identical notes', () => {
  const { summary } = mergeImport(sample, [
    { path: 'Welcome.md', content: '# Welcome\n\nHello [[notes/ideas]].' },
  ]);
  assert.equal(summary.unchanged, 1);
  assert.equal(summary.added, 0);
});

test('export then import is an idempotent round-trip into the same vault', async () => {
  const zip = buildVaultZip(sample);
  const entries = await readVaultZip(zip);
  const { summary } = mergeImport(sample, entries);
  // Re-importing the same content changes nothing.
  assert.equal(summary.added, 0);
  assert.equal(summary.renamed.length, 0);
  assert.equal(summary.unchanged, sample.length);
});

// --- Hardening: malformed / hostile ZIP inputs --------------------------------

test('truncated / garbage buffer throws the clean import error (not a RangeError)', async () => {
  const garbage = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  await assert.rejects(
    () => readVaultZip(garbage),
    (err: Error) => {
      assert.ok(!(err instanceof RangeError), 'must not surface a raw RangeError');
      assert.match(err.message, /Not a valid ZIP archive\./);
      return true;
    },
  );

  // A buffer that *ends* with a bare EOCD signature but is not a real record.
  const fakeEocd = new Uint8Array(8);
  new DataView(fakeEocd.buffer).setUint32(0, 0x06054b50, true);
  await assert.rejects(
    () => readVaultZip(fakeEocd),
    (err: Error) => {
      assert.ok(!(err instanceof RangeError));
      assert.match(err.message, /Not a valid ZIP archive\./);
      return true;
    },
  );
});

test('out-of-range local-header offset yields a clean error, not a RangeError', async () => {
  const zip = buildVaultZip([note('a.md', 'hello')]);
  // Find the EOCD, walk to the central directory, and corrupt the first
  // record's local-header offset (bytes 42..45) to point far past the buffer.
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  assert.ok(eocd >= 0, 'precondition: EOCD found');
  const cdOffset = view.getUint32(eocd + 16, true);
  // central record local-offset field is at cdOffset + 42.
  view.setUint32(cdOffset + 42, 0xffffffff, true);
  await assert.rejects(
    () => readVaultZip(zip),
    (err: Error) => {
      assert.ok(!(err instanceof RangeError), 'must not surface a raw RangeError');
      assert.match(err.message, /Not a valid ZIP archive\./);
      return true;
    },
  );
});

test('entry CONTENT containing the EOCD signature bytes still imports correctly (no silent drop)', async () => {
  // A note whose body literally contains the 4 EOCD signature bytes. A naive
  // backward scan could latch onto those bytes and silently return 0 entries.
  const eocdSig = String.fromCharCode(0x50, 0x4b, 0x05, 0x06);
  const poison = note('trap.md', `before ${eocdSig} after — real content here`);
  const zip = buildVaultZip([poison, note('other.md', 'second note')]);
  const entries = await readVaultZip(zip);
  assert.equal(entries.length, 2, 'must not silently drop notes');
  const trap = entries.find((e) => e.path === 'trap.md');
  assert.ok(trap, 'trap.md present');
  assert.equal(trap!.content, poison.content);
  assert.ok(entries.some((e) => e.path === 'other.md'));
});

test('a FALSE EOCD signature near the tail does not shadow the real record', async () => {
  // The strongest form of the silent-drop bug: forge a buffer where a bogus
  // EOCD signature sits closer to EOF (claiming zero entries), while the real,
  // self-consistent EOCD sits earlier behind a trailing comment. A naive
  // "scan back from length-22 for the signature" picks the bogus one and
  // returns zero notes; a validating scan must reject the bogus record (its
  // bounds don't add up) and find the genuine one.
  const real = buildVaultZip([note('keep.md', 'must survive')]);
  // Append a trailing comment to the *genuine* EOCD so it no longer sits at
  // length-22, then bury a fake bare signature inside that comment region.
  const view = new DataView(real.buffer, real.byteOffset, real.byteLength);
  let realEocd = -1;
  for (let i = real.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      realEocd = i;
      break;
    }
  }
  assert.ok(realEocd >= 0);
  const comment = new Uint8Array(40); // 40-byte trailing comment
  // Plant a bogus EOCD signature inside the comment, with zeroed fields, so a
  // naive scan would read entryCount=0 and silently import nothing.
  new DataView(comment.buffer).setUint32(8, 0x06054b50, true);
  const out = new Uint8Array(realEocd + 22 + comment.length);
  out.set(real.subarray(0, realEocd + 22), 0);
  out.set(comment, realEocd + 22);
  // Record the genuine comment length so the real EOCD stays self-consistent.
  new DataView(out.buffer).setUint16(realEocd + 20, comment.length, true);

  const entries = await readVaultZip(out);
  assert.equal(entries.length, 1, 'real entry must not be shadowed by a fake EOCD');
  assert.equal(entries[0].path, 'keep.md');
  assert.equal(entries[0].content, 'must survive');
});

test('archive count cap is enforced', async () => {
  // Forge an EOCD claiming more entries than MAX_IMPORT_FILES.
  const buf = new Uint8Array(22);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x06054b50, true);
  dv.setUint16(8, 0xffff, true); // entries this disk
  dv.setUint16(10, 0xffff, true); // total entries (> MAX_IMPORT_FILES)
  dv.setUint32(12, 0, true); // central dir size
  dv.setUint32(16, 0, true); // central dir offset
  await assert.rejects(() => readVaultZip(buf), /too many files/);
});

test('zip-slip / traversal entries are dropped on real ZIP import', async () => {
  // Build a valid archive then rewrite a stored entry name to a traversal path.
  const zip = buildVaultZip([note('safe.md', 'ok'), note('victim.md', 'pwn')]);
  // Replace the central+local copies of "victim.md" with an equal-length
  // traversal name so offsets stay byte-aligned (".././x.md" is 9 chars too).
  const evil = '.././x.md';
  assert.equal(evil.length, 'victim.md'.length);
  const patched = zip.slice();
  // Patch raw bytes wherever "victim.md" appears (local + central headers).
  const needle = new TextEncoder().encode('victim.md');
  const replacement = new TextEncoder().encode(evil);
  for (let i = 0; i + needle.length <= patched.length; i++) {
    let match = true;
    for (let j = 0; j < needle.length; j++) {
      if (patched[i + j] !== needle[j]) {
        match = false;
        break;
      }
    }
    if (match) patched.set(replacement, i);
  }
  const entries = await readVaultZip(patched);
  // The traversal entry is rejected by safeImportPath; the safe note survives.
  assert.ok(entries.some((e) => e.path === 'safe.md'));
  assert.ok(!entries.some((e) => e.path.includes('..')));
});
