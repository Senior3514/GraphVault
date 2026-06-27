#!/usr/bin/env node
/**
 * apps/extension/scripts/package.mjs
 *
 * Packages the GraphVault Web Clipper extension into a distributable ZIP file
 * ready for submission to the Chrome Web Store and Firefox Add-on (AMO).
 *
 * Output: apps/extension/dist/graphvault-extension.zip
 *
 * The ZIP uses the STORE method (no compression) so the archive is trivially
 * inspectable and auditable - consistent with GraphVault's data portability
 * philosophy (same approach as the vault export ZIP in apps/web/lib/vault/).
 *
 * Zero external dependencies - only Node.js built-ins: fs, path, zlib, crypto.
 *
 * Usage:
 *   node apps/extension/scripts/package.mjs
 *
 * The script first runs generate-icons.mjs to ensure PNG icons are up-to-date,
 * then zips the extension directory.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'fs';
import { resolve, dirname, relative, join } from 'path';
import { fileURLToPath } from 'url';
import { createHash } from 'crypto';
import { execFileSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const EXTENSION_DIR = resolve(__dirname, '..');
const DIST_DIR = resolve(EXTENSION_DIR, 'dist');
const OUTPUT = resolve(DIST_DIR, 'graphvault-extension.zip');

// ---------------------------------------------------------------------------
// Step 0: ensure PNG icons are generated
// ---------------------------------------------------------------------------

const generateIconsScript = resolve(__dirname, 'generate-icons.mjs');
console.log('Generating PNG icons...');
execFileSync(process.execPath, [generateIconsScript], { stdio: 'inherit' });

// ---------------------------------------------------------------------------
// Files to include in the ZIP
// (everything except scripts/, dist/, *.svg icons, and hidden files)
// ---------------------------------------------------------------------------

/**
 * Recursively collect all files under `dir`, returning their absolute paths.
 * @param {string} dir
 * @param {string[]} [exclude]  - directory names to skip
 * @returns {string[]}
 */
function collectFiles(dir, exclude = []) {
  const entries = readdirSync(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue; // skip hidden files/dirs
    if (exclude.includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(full, exclude));
    } else {
      files.push(full);
    }
  }
  return files;
}

// Collect all extension files except:
//   scripts/  - build tooling, not part of the extension
//   dist/     - output directory
//   *.svg     - replaced by .png icons in the manifest
const allFiles = collectFiles(EXTENSION_DIR, ['scripts', 'dist']);
const extensionFiles = allFiles.filter(f => !f.endsWith('.svg'));

// Verify manifest.json is present and valid before packaging
const manifestPath = resolve(EXTENSION_DIR, 'manifest.json');
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
  console.error('ERROR: manifest.json is invalid JSON:', err.message);
  process.exit(1);
}

// Verify every file referenced in the manifest exists
function checkManifestRef(ref, label) {
  const full = resolve(EXTENSION_DIR, ref);
  try {
    statSync(full);
  } catch {
    console.error('ERROR: manifest references missing file (' + label + '): ' + ref);
    process.exit(1);
  }
}

const iconRefs = Object.values(manifest.icons || {});
const actionIconRefs = Object.values(manifest.action?.default_icon || {});
const allRefs = [...new Set([...iconRefs, ...actionIconRefs])];
for (const ref of allRefs) checkManifestRef(ref, 'icon');
if (manifest.action?.default_popup) checkManifestRef(manifest.action.default_popup, 'popup');
if (manifest.background?.service_worker) checkManifestRef(manifest.background.service_worker, 'background');
for (const cs of manifest.content_scripts || []) {
  for (const js of cs.js || []) checkManifestRef(js, 'content_script');
}
console.log('manifest.json: valid JSON, all referenced files exist.');

// ---------------------------------------------------------------------------
// ZIP builder - STORE method (no compression), per the MV3 extension standard
//
// Format: Local file header + data per entry, then central directory, then
// end-of-central-directory record.  Spec: PKWARE .ZIP Application Note.
// ---------------------------------------------------------------------------

/**
 * Encode a string to a Buffer using UTF-8.
 * @param {string} s
 */
function utf8(s) {
  return Buffer.from(s, 'utf8');
}

/**
 * Write a 16-bit little-endian value into a Buffer.
 */
function u16(buf, offset, val) {
  buf[offset]     = val & 0xff;
  buf[offset + 1] = (val >> 8) & 0xff;
}

/**
 * Write a 32-bit little-endian value into a Buffer.
 */
function u32(buf, offset, val) {
  buf[offset]     = val & 0xff;
  buf[offset + 1] = (val >> 8) & 0xff;
  buf[offset + 2] = (val >> 16) & 0xff;
  buf[offset + 3] = (val >> 24) & 0xff;
}

/**
 * Compute CRC-32 of a buffer (ZIP uses the standard CRC-32 polynomial).
 */
const ZIP_CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = ZIP_CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/**
 * DOS date/time encoding for the current time.
 * @returns {{ date: number, time: number }}
 */
function dosDateTime() {
  const now = new Date();
  const time = ((now.getHours() & 0x1f) << 11) | ((now.getMinutes() & 0x3f) << 5) | ((now.getSeconds() >> 1) & 0x1f);
  const date = (((now.getFullYear() - 1980) & 0x7f) << 9) | (((now.getMonth() + 1) & 0x0f) << 5) | (now.getDate() & 0x1f);
  return { date, time };
}

/**
 * Build a ZIP archive (STORE, no compression) from a list of files.
 * @param {{ name: string, data: Buffer }[]} entries
 * @returns {Buffer}
 */
function buildZip(entries) {
  const localHeaders = [];
  const centralHeaders = [];
  let offset = 0;
  const { date, time } = dosDateTime();

  for (const { name, data } of entries) {
    const nameBuf = utf8(name);
    const crc = crc32(data);
    const size = data.length;

    // Local file header (30 bytes + filename)
    const localHeader = Buffer.alloc(30 + nameBuf.length);
    u32(localHeader, 0,  0x04034b50); // signature
    u16(localHeader, 4,  20);          // version needed: 2.0
    u16(localHeader, 6,  0);           // general purpose bits
    u16(localHeader, 8,  0);           // compression: STORE
    u16(localHeader, 10, time);
    u16(localHeader, 12, date);
    u32(localHeader, 14, crc);
    u32(localHeader, 18, size);        // compressed size = uncompressed (STORE)
    u32(localHeader, 22, size);        // uncompressed size
    u16(localHeader, 26, nameBuf.length);
    u16(localHeader, 28, 0);           // extra field length
    nameBuf.copy(localHeader, 30);

    // Central directory header (46 bytes + filename)
    const centralHeader = Buffer.alloc(46 + nameBuf.length);
    u32(centralHeader, 0,  0x02014b50); // signature
    u16(centralHeader, 4,  20);          // version made by
    u16(centralHeader, 6,  20);          // version needed
    u16(centralHeader, 8,  0);           // general purpose bits
    u16(centralHeader, 10, 0);           // compression: STORE
    u16(centralHeader, 12, time);
    u16(centralHeader, 14, date);
    u32(centralHeader, 16, crc);
    u32(centralHeader, 20, size);        // compressed
    u32(centralHeader, 24, size);        // uncompressed
    u16(centralHeader, 28, nameBuf.length);
    u16(centralHeader, 30, 0);           // extra field length
    u16(centralHeader, 32, 0);           // file comment length
    u16(centralHeader, 34, 0);           // disk start
    u16(centralHeader, 36, 0);           // internal attributes
    u32(centralHeader, 38, 0);           // external attributes
    u32(centralHeader, 42, offset);      // local header offset
    nameBuf.copy(centralHeader, 46);

    localHeaders.push(Buffer.concat([localHeader, data]));
    centralHeaders.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const centralDir = Buffer.concat(centralHeaders);
  const centralDirSize = centralDir.length;
  const centralDirOffset = offset;

  // End-of-central-directory record (22 bytes)
  const eocd = Buffer.alloc(22);
  u32(eocd, 0,  0x06054b50); // signature
  u16(eocd, 4,  0);           // disk number
  u16(eocd, 6,  0);           // disk with central dir
  u16(eocd, 8,  entries.length);
  u16(eocd, 10, entries.length);
  u32(eocd, 12, centralDirSize);
  u32(eocd, 16, centralDirOffset);
  u16(eocd, 20, 0);           // comment length

  return Buffer.concat([...localHeaders, centralDir, eocd]);
}

// ---------------------------------------------------------------------------
// Build the ZIP
// ---------------------------------------------------------------------------

mkdirSync(DIST_DIR, { recursive: true });

console.log('\nPackaging extension files:');
const entries = [];

for (const absPath of extensionFiles.sort()) {
  const relPath = relative(EXTENSION_DIR, absPath).replace(/\\/g, '/');
  const data = readFileSync(absPath);
  const sha = createHash('sha256').update(data).digest('hex').slice(0, 12);
  console.log('  ' + relPath + '  (' + data.length + ' bytes, sha256:' + sha + '...)');
  entries.push({ name: relPath, data });
}

const zip = buildZip(entries);
writeFileSync(OUTPUT, zip);

console.log('\nOutput: ' + OUTPUT);
console.log('Size:   ' + zip.length + ' bytes  (' + entries.length + ' files)');

// Quick sanity: ZIP must start with local file header signature
if (zip.readUInt32LE(0) !== 0x04034b50) {
  console.error('ERROR: Generated ZIP has invalid signature. Aborting.');
  process.exit(1);
}
// End-of-central-directory signature at expected offset
const eocdOffset = zip.length - 22;
if (zip.readUInt32LE(eocdOffset) !== 0x06054b50) {
  console.error('ERROR: Generated ZIP EOCD signature invalid. Aborting.');
  process.exit(1);
}
console.log('ZIP signature check: OK');
console.log('\nReady for store submission. See README.md for submission steps.');
