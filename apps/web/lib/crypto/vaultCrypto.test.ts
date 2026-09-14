/**
 * Tests for vaultCrypto.ts - pure WebCrypto vault encryption.
 *
 * Run:  node --test --import tsx apps/web/lib/crypto/vaultCrypto.test.ts
 *
 * Test matrix:
 *  - Round-trip: encrypt → decrypt recovers the exact plaintext.
 *  - Wrong passphrase: decryption throws; no partial data returned.
 *  - Tampered ciphertext: any single-byte mutation causes auth failure.
 *  - Distinct salts + IVs: two encryptions of the same plaintext differ.
 *  - Version field present and correct.
 *  - isEncrypted detects encrypted blobs and rejects plain text.
 *  - Base64 serialization round-trip.
 *  - Empty-passphrase guard throws before touching crypto.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decryptVault,
  encryptVault,
  envelopeFromBase64,
  envelopeToBase64,
  ENVELOPE_VERSION,
  isEncrypted,
} from './vaultCrypto';

// ---------------------------------------------------------------------------
// Round-trip
// ---------------------------------------------------------------------------

test('round-trip: string plaintext', async () => {
  const plaintext = 'Hello, GraphVault! - Unicode: 🔐 héllo wörld 日本語';
  const passphrase = 'correct-horse-battery-staple';
  const envelope = await encryptVault(plaintext, passphrase);
  const recovered = await decryptVault(envelope, passphrase);
  assert.equal(recovered, plaintext);
});

test('round-trip: empty string', async () => {
  const envelope = await encryptVault('', 'pass');
  const recovered = await decryptVault(envelope, 'pass');
  assert.equal(recovered, '');
});

test('round-trip: Uint8Array plaintext', async () => {
  const plaintext = new TextEncoder().encode('binary input test');
  const envelope = await encryptVault(plaintext, 'pw123');
  const recovered = await decryptVault(envelope, 'pw123');
  assert.equal(recovered, 'binary input test');
});

test('round-trip: large plaintext (>64 KiB)', async () => {
  const plaintext = 'A'.repeat(100_000);
  const envelope = await encryptVault(plaintext, 'bigpass');
  const recovered = await decryptVault(envelope, 'bigpass');
  assert.equal(recovered, plaintext);
});

test('round-trip: Uint8Array raw bytes accepted by decryptVault', async () => {
  const envelope = await encryptVault('raw bytes path', 'pw');
  const recovered = await decryptVault(envelope.data, 'pw');
  assert.equal(recovered, 'raw bytes path');
});

// ---------------------------------------------------------------------------
// Wrong-passphrase rejection
// ---------------------------------------------------------------------------

test('wrong passphrase: rejects and throws', async () => {
  const envelope = await encryptVault('secret note content', 'correct-pass');
  await assert.rejects(
    () => decryptVault(envelope, 'wrong-pass'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      // Must not reveal whether it was a passphrase vs tamper failure.
      assert.ok(err.message.includes('Decryption failed'));
      return true;
    },
  );
});

test('wrong passphrase: single char difference rejects', async () => {
  const envelope = await encryptVault('s3cr3t', 'passphrase');
  await assert.rejects(() => decryptVault(envelope, 'Passphrase'));
});

test('wrong passphrase: empty passphrase guard throws synchronously', async () => {
  const envelope = await encryptVault('data', 'real-pass');
  await assert.rejects(() => decryptVault(envelope, ''), TypeError);
});

// ---------------------------------------------------------------------------
// Tamper rejection
// ---------------------------------------------------------------------------

test('tampered ciphertext (flip one byte): decryption fails', async () => {
  const envelope = await encryptVault('do not tamper', 'pass');
  // Flip a byte in the ciphertext region (after the 49-byte header).
  const tampered = new Uint8Array(envelope.data);
  tampered[49] ^= 0xff;
  await assert.rejects(
    () => decryptVault(tampered, 'pass'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('Decryption failed'));
      return true;
    },
  );
});

test('tampered ciphertext (flip last byte / GCM tag): decryption fails', async () => {
  const envelope = await encryptVault('tag tamper test', 'pass');
  const tampered = new Uint8Array(envelope.data);
  tampered[tampered.length - 1] ^= 0x01;
  await assert.rejects(() => decryptVault(tampered, 'pass'));
});

test('tampered IV (flip one byte): decryption fails', async () => {
  const envelope = await encryptVault('iv tamper test', 'pass');
  // IV lives at bytes 37..48 (5 + 32 = 37 start, 12 bytes).
  const tampered = new Uint8Array(envelope.data);
  tampered[37] ^= 0x01;
  await assert.rejects(() => decryptVault(tampered, 'pass'));
});

test('truncated envelope: decryption fails with clear error', async () => {
  const envelope = await encryptVault('truncated', 'pass');
  const truncated = envelope.data.subarray(0, 20);
  await assert.rejects(
    () => decryptVault(truncated, 'pass'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      return true;
    },
  );
});

test('wrong magic bytes: decryption fails', async () => {
  const envelope = await encryptVault('magic test', 'pass');
  const bad = new Uint8Array(envelope.data);
  bad[0] = 0x00; // corrupt magic
  await assert.rejects(
    () => decryptVault(bad, 'pass'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('not a GraphVault encrypted envelope'));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Distinct salts and IVs on repeated encryptions
// ---------------------------------------------------------------------------

test('distinct salts and IVs: same plaintext/passphrase produces different ciphertexts', async () => {
  const plaintext = 'repeat me';
  const passphrase = 'same-pass';

  const e1 = await encryptVault(plaintext, passphrase);
  const e2 = await encryptVault(plaintext, passphrase);

  // Envelopes must differ (different salt + IV).
  assert.notDeepEqual(e1.data, e2.data);

  // But both must decrypt successfully.
  assert.equal(await decryptVault(e1, passphrase), plaintext);
  assert.equal(await decryptVault(e2, passphrase), plaintext);
});

test('distinct salts: salt bytes (offset 5..36) differ between two encryptions', async () => {
  const e1 = await encryptVault('x', 'p');
  const e2 = await encryptVault('x', 'p');
  const salt1 = e1.data.slice(5, 37);
  const salt2 = e2.data.slice(5, 37);
  assert.notDeepEqual(salt1, salt2);
});

test('distinct IVs: IV bytes (offset 37..48) differ between two encryptions', async () => {
  const e1 = await encryptVault('x', 'p');
  const e2 = await encryptVault('x', 'p');
  const iv1 = e1.data.slice(37, 49);
  const iv2 = e2.data.slice(37, 49);
  assert.notDeepEqual(iv1, iv2);
});

// ---------------------------------------------------------------------------
// Version field
// ---------------------------------------------------------------------------

test('version field: envelope.version is ENVELOPE_VERSION (1)', async () => {
  const envelope = await encryptVault('version check', 'pass');
  assert.equal(envelope.version, ENVELOPE_VERSION);
  assert.equal(envelope.version, 1);
});

test('version field: version byte in binary data matches constant', async () => {
  const envelope = await encryptVault('version byte', 'pass');
  // Version byte is at offset 4 in the binary envelope.
  assert.equal(envelope.data[4], ENVELOPE_VERSION);
});

test('version field: algorithm string contains PBKDF2 and AES-GCM', async () => {
  const envelope = await encryptVault('algo check', 'pass');
  assert.ok(envelope.algorithm.includes('PBKDF2'));
  assert.ok(envelope.algorithm.includes('AES-256-GCM'));
});

test('unsupported envelope version: decryption throws with version info', async () => {
  const envelope = await encryptVault('version gate', 'pass');
  const badVersion = new Uint8Array(envelope.data);
  badVersion[4] = 0x99; // unsupported version
  await assert.rejects(
    () => decryptVault(badVersion, 'pass'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes('unsupported envelope version'));
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// isEncrypted
// ---------------------------------------------------------------------------

test('isEncrypted: returns true for a real encrypted blob', async () => {
  const envelope = await encryptVault('test', 'pass');
  assert.equal(isEncrypted(envelope.data), true);
});

test('isEncrypted: returns false for a plain string starting with wrong bytes', () => {
  assert.equal(isEncrypted(new Uint8Array([0x00, 0x01, 0x02, 0x03])), false);
});

test('isEncrypted: returns false for plain JSON', () => {
  const plainJson = '{"notes":[{"path":"a.md","content":"hello"}]}';
  // Encode to bytes to test Uint8Array path.
  const bytes = new TextEncoder().encode(plainJson);
  assert.equal(isEncrypted(bytes), false);
});

test('isEncrypted: string overload - correct magic returns true', () => {
  // Build a string with the correct magic bytes "GVE1".
  const magic = String.fromCharCode(0x47, 0x56, 0x45, 0x31) + 'extra';
  assert.equal(isEncrypted(magic), true);
});

test('isEncrypted: returns false for empty buffer', () => {
  assert.equal(isEncrypted(new Uint8Array(0)), false);
});

test('isEncrypted: returns false for short buffer (< header size)', () => {
  assert.equal(isEncrypted(new Uint8Array(10)), false);
});

// ---------------------------------------------------------------------------
// Base64 serialization round-trip
// ---------------------------------------------------------------------------

test('base64 round-trip: serialize and deserialize envelope', async () => {
  const plaintext = 'Base64 round-trip test - 日本語';
  const passphrase = 'b64-pass';
  const envelope = await encryptVault(plaintext, passphrase);
  const b64 = envelopeToBase64(envelope);

  // Must be a URL-safe base64 string (no +, /, or = chars).
  assert.match(b64, /^[A-Za-z0-9_-]+$/);

  const restored = envelopeFromBase64(b64);
  assert.equal(restored.version, envelope.version);
  assert.deepEqual(restored.data, envelope.data);

  // Must decrypt correctly after round-trip through base64.
  const recovered = await decryptVault(restored, passphrase);
  assert.equal(recovered, plaintext);
});

test('envelopeFromBase64: rejects non-envelope base64', () => {
  const arbitrary = btoa('hello world').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  assert.throws(
    () => envelopeFromBase64(arbitrary),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// Input validation guards
// ---------------------------------------------------------------------------

test('encryptVault: empty passphrase throws TypeError', async () => {
  await assert.rejects(() => encryptVault('data', ''), TypeError);
});

test('decryptVault: empty passphrase throws TypeError before any crypto', async () => {
  const envelope = await encryptVault('data', 'real');
  await assert.rejects(() => decryptVault(envelope, ''), TypeError);
});
