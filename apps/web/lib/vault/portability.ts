/**
 * Vault portability: export the whole vault to a downloadable archive and
 * import it back — losslessly and safely. "Your data, any storage."
 *
 * Two interchange formats, both plain and auditable:
 *  - **Markdown ZIP**: a `.zip` of the raw `.md` files with folder structure
 *    preserved. This is the no-lock-in format — unzip it anywhere, the notes
 *    are just Markdown on disk. Written with the STORE method (no compression)
 *    so it needs zero dependencies and round-trips byte-for-byte.
 *  - **JSON**: a single versioned envelope with content + timestamps, handy for
 *    one-file backups and programmatic transfer.
 *
 * Everything here is framework-free and dependency-free so it can be unit
 * tested and reused by the desktop app. Importing untrusted archives is treated
 * as a security boundary — see {@link safeImportPath} and the size caps.
 */

import { normalizePath } from './vault';
import type { Note } from './types';

/** Bumped only on a breaking change to the JSON envelope shape. */
export const VAULT_EXPORT_VERSION = 1 as const;

/** Per-file cap on imported content (4 MiB). Guards against zip bombs / OOM. */
export const MAX_IMPORT_FILE_BYTES = 4 * 1024 * 1024;
/** Aggregate cap across a single import (64 MiB). */
export const MAX_IMPORT_TOTAL_BYTES = 64 * 1024 * 1024;
/** Hard cap on the number of files accepted from one archive. */
export const MAX_IMPORT_FILES = 10_000;

/** Text file extensions we accept on import (everything else is ignored). */
const IMPORTABLE_EXTENSIONS = ['.md', '.markdown', '.txt'] as const;

/** A note to import: a vault-relative path plus content (+ optional times). */
export interface ImportEntry {
  path: string;
  content: string;
  ctime?: number;
  mtime?: number;
}

/** The JSON export envelope. */
export interface VaultExportJson {
  format: 'graphvault-vault';
  version: number;
  exportedAt: number;
  notes: Array<Pick<Note, 'path' | 'content' | 'ctime' | 'mtime'>>;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { fatal: false });

// ---------------------------------------------------------------------------
// Path safety (import is an untrusted-input boundary)
// ---------------------------------------------------------------------------

/**
 * Normalize and validate an archive entry path. Returns the safe vault-relative
 * path, or `null` if the entry must be rejected.
 *
 * Rejects: absolute paths, drive letters, any `..` traversal ("zip-slip"),
 * empty names, directory entries, and non-text extensions. The returned path is
 * always a clean POSIX, vault-relative path.
 */
export function safeImportPath(raw: string): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  // Reject absolute paths, Windows drive letters, and UNC outright — we only
  // ever write vault-relative paths, never anything anchored outside the vault.
  if (raw.startsWith('/') || raw.startsWith('\\')) return null;
  if (/^[a-zA-Z]:[\\/]/.test(raw) || raw.startsWith('\\\\')) return null;
  const normalized = normalizePath(raw);
  if (normalized === '') return null;
  // Directory entries (trailing slash collapsed away) and traversal segments.
  if (raw.endsWith('/') || raw.endsWith('\\')) return null;
  if (normalized.split('/').some((seg) => seg === '..')) return null;
  const lower = normalized.toLowerCase();
  if (!IMPORTABLE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return null;
  return normalized;
}

// ---------------------------------------------------------------------------
// JSON export / import
// ---------------------------------------------------------------------------

/** Serialize the vault to the versioned JSON envelope (pretty-printed). */
export function exportNotesToJson(notes: readonly Note[]): string {
  const payload: VaultExportJson = {
    format: 'graphvault-vault',
    version: VAULT_EXPORT_VERSION,
    exportedAt: Date.now(),
    notes: notes.map((n) => ({
      path: n.path,
      content: n.content,
      ctime: n.ctime,
      mtime: n.mtime,
    })),
  };
  return JSON.stringify(payload, null, 2);
}

/**
 * Parse a JSON export back into import entries. Throws on a malformed envelope.
 * Unsafe paths are dropped (not fatal) so a partly-bad backup still imports.
 */
export function parseJsonExport(text: string): ImportEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Not valid JSON.');
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Unexpected JSON shape.');
  }
  const env = parsed as Partial<VaultExportJson>;
  if (env.format !== 'graphvault-vault' || !Array.isArray(env.notes)) {
    throw new Error('Not a GraphVault export file.');
  }
  const entries: ImportEntry[] = [];
  for (const raw of env.notes) {
    if (typeof raw !== 'object' || raw === null) continue;
    const n = raw as Record<string, unknown>;
    if (typeof n.path !== 'string' || typeof n.content !== 'string') continue;
    const safe = safeImportPath(n.path);
    if (!safe) continue;
    entries.push({
      path: safe,
      content: n.content,
      ctime: typeof n.ctime === 'number' ? n.ctime : undefined,
      mtime: typeof n.mtime === 'number' ? n.mtime : undefined,
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// ZIP (STORE method) — minimal, dependency-free writer + reader
// ---------------------------------------------------------------------------

/** Precomputed CRC-32 table (IEEE polynomial), built once. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Encode a Date as a DOS time/date pair (used in ZIP headers). */
function dosDateTime(d: Date): { time: number; date: number } {
  const time =
    (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2) & 0x1f);
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | (d.getDate() & 0x1f);
  return { time: time & 0xffff, date: date & 0xffff };
}

/**
 * Build a `.zip` archive (STORE / no compression) from the vault's notes.
 * Folder structure is implied by the `.md` paths. Returns the raw bytes.
 */
export function buildVaultZip(notes: readonly Note[]): Uint8Array<ArrayBuffer> {
  interface Central {
    nameBytes: Uint8Array;
    crc: number;
    size: number;
    offset: number;
    time: number;
    date: number;
  }
  const chunks: Uint8Array[] = [];
  const central: Central[] = [];
  let offset = 0;

  const push = (bytes: Uint8Array) => {
    chunks.push(bytes);
    offset += bytes.length;
  };

  for (const note of notes) {
    const nameBytes = textEncoder.encode(note.path);
    const data = textEncoder.encode(note.content);
    const crc = crc32(data);
    const { time, date } = dosDateTime(new Date(note.mtime || Date.now()));

    const header = new Uint8Array(30 + nameBytes.length);
    const hv = new DataView(header.buffer);
    hv.setUint32(0, 0x04034b50, true); // local file header signature
    hv.setUint16(4, 20, true); // version needed
    hv.setUint16(6, 0x0800, true); // flags: UTF-8 names
    hv.setUint16(8, 0, true); // method: store
    hv.setUint16(10, time, true);
    hv.setUint16(12, date, true);
    hv.setUint32(14, crc, true);
    hv.setUint32(18, data.length, true); // compressed size
    hv.setUint32(22, data.length, true); // uncompressed size
    hv.setUint16(26, nameBytes.length, true);
    hv.setUint16(28, 0, true); // extra length
    header.set(nameBytes, 30);

    central.push({ nameBytes, crc, size: data.length, offset, time, date });
    push(header);
    push(data);
  }

  // Central directory.
  const centralStart = offset;
  for (const c of central) {
    const rec = new Uint8Array(46 + c.nameBytes.length);
    const rv = new DataView(rec.buffer);
    rv.setUint32(0, 0x02014b50, true); // central dir signature
    rv.setUint16(4, 20, true); // version made by
    rv.setUint16(6, 20, true); // version needed
    rv.setUint16(8, 0x0800, true); // flags: UTF-8
    rv.setUint16(10, 0, true); // method: store
    rv.setUint16(12, c.time, true);
    rv.setUint16(14, c.date, true);
    rv.setUint32(16, c.crc, true);
    rv.setUint32(20, c.size, true);
    rv.setUint32(24, c.size, true);
    rv.setUint16(28, c.nameBytes.length, true);
    rv.setUint16(30, 0, true); // extra length
    rv.setUint16(32, 0, true); // comment length
    rv.setUint16(34, 0, true); // disk number
    rv.setUint16(36, 0, true); // internal attrs
    rv.setUint32(38, 0, true); // external attrs
    rv.setUint32(42, c.offset, true); // local header offset
    rec.set(c.nameBytes, 46);
    push(rec);
  }
  const centralSize = offset - centralStart;

  // End of central directory.
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true); // entries on this disk
  ev.setUint16(10, central.length, true); // total entries
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralStart, true);
  push(eocd);

  // Concatenate.
  const out = new Uint8Array(offset);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

/** Inflate a raw DEFLATE stream using the platform's DecompressionStream. */
async function inflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Compressed ZIP entries are not supported in this browser.');
  }
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(ds);
  const buf = await new Response(stream).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * Read a `.zip` archive into import entries. Handles both STORE (our exports)
 * and DEFLATE (archives produced by other tools). Directory entries, unsafe
 * paths, and non-text files are skipped; size caps are enforced throughout.
 *
 * Parses the central directory (authoritative) rather than scanning local
 * headers, which is both faster and more robust.
 */
export async function readVaultZip(bytes: Uint8Array): Promise<ImportEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  // Locate the End Of Central Directory record by scanning backwards.
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a valid ZIP archive.');

  const entryCount = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true); // central directory offset
  if (entryCount > MAX_IMPORT_FILES) throw new Error('Archive has too many files.');

  const entries: ImportEntry[] = [];
  let totalBytes = 0;

  for (let i = 0; i < entryCount; i++) {
    if (ptr + 46 > bytes.length || view.getUint32(ptr, true) !== 0x02014b50) break;
    const method = view.getUint16(ptr + 10, true);
    const compSize = view.getUint32(ptr + 20, true);
    const uncompSize = view.getUint32(ptr + 24, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOffset = view.getUint32(ptr + 42, true);
    const rawName = textDecoder.decode(bytes.subarray(ptr + 46, ptr + 46 + nameLen));
    ptr += 46 + nameLen + extraLen + commentLen;

    if (uncompSize > MAX_IMPORT_FILE_BYTES) continue; // oversized: skip safely
    const safe = safeImportPath(rawName);
    if (!safe) continue;

    // Resolve the data offset via the local header (its extra field length can
    // differ from the central record's).
    if (view.getUint32(localOffset, true) !== 0x04034b50) continue;
    const lNameLen = view.getUint16(localOffset + 26, true);
    const lExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const compressed = bytes.subarray(dataStart, dataStart + compSize);

    let data: Uint8Array;
    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      data = await inflateRaw(compressed);
    } else {
      continue; // unsupported compression method
    }
    if (data.length > MAX_IMPORT_FILE_BYTES) continue;
    totalBytes += data.length;
    if (totalBytes > MAX_IMPORT_TOTAL_BYTES) throw new Error('Archive is too large to import.');

    entries.push({ path: safe, content: textDecoder.decode(data) });
  }

  return entries;
}
