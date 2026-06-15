/**
 * Minimal, URL-safe graph snapshot: encode/decode a compact, privacy-safe
 * representation of a graph (titles + links only — NEVER note content) for
 * shareable /embed?s=<snapshot> URLs.
 *
 * Design constraints:
 * - No note body content: titles and edge topology only.
 * - Compact: JSON → UTF-8 → deflate → base64url (avoids +/= in URLs).
 * - Size-bounded: rejects snapshots larger than MAX_SNAPSHOT_BYTES when encoding
 *   (pre-compression) and MAX_ENCODED_CHARS when decoding. Never silently truncates.
 * - Framework-free, browser + Node compatible (uses CompressionStream if available,
 *   else plain JSON as fallback — both paths are tested).
 * - Deterministic: same input produces the same encoded form (within a single JS
 *   engine, since JSON.stringify is deterministic for plain objects with stable
 *   key order).
 *
 * URL shape:
 *   /embed?s=<base64url-encoded-payload>
 *
 * The payload can be either:
 *   - A JSON-stringified `EmbedSnapshot` (the simple, always-available path)
 *   - A base64url-encoded deflated JSON string (the compact path, used when
 *     CompressionStream is available — only in modern browsers and Node 18+)
 *
 * The two are distinguished by the first character:
 *   - '{' → raw JSON (no compression)
 *   - 'z' → base64url-encoded deflated payload (prefix 'z' for "zlib/deflate")
 *
 * CSP + framing note:
 *   The current vercel.json sets `frame-ancestors 'none'` which prevents any
 *   third-party site from embedding `/embed` in an <iframe>. To allow third-party
 *   embedding, a site operator must set `frame-ancestors *` (or specific origins)
 *   in their deployment headers. The snapshot URL itself is shareable as-is —
 *   anyone with the URL can open `/embed?s=…` directly or iframe it from a
 *   same-origin context. See apps/web/vercel.json and app/layout.tsx for CSP
 *   configuration.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single node in the embed snapshot — titles only, no content. */
export interface SnapshotNode {
  /** Unique opaque ID (matches the engine's node.id, which is the vault path). */
  i: string;
  /** Human-readable title for hover labels. */
  t: string;
}

/** A directed edge in the embed snapshot. */
export interface SnapshotEdge {
  /** Source node id. */
  s: string;
  /** Target node id. */
  t: string;
  /** Link type: 'w' = wikilink, 'm' = markdown, 'r' = typed relation. */
  k: 'w' | 'm' | 'r';
}

/**
 * The minimal graph snapshot that travels in a URL.
 *
 * Field names are intentionally terse to keep the URL short:
 *   v  — format version (always 1 for now)
 *   n  — nodes array (id + title)
 *   e  — edges array (source + target + kind)
 */
export interface EmbedSnapshot {
  v: 1;
  n: SnapshotNode[];
  e: SnapshotEdge[];
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/**
 * Maximum uncompressed JSON byte length before encoding is refused.
 * ~200 KB of JSON comfortably represents thousands of nodes.
 */
export const MAX_SNAPSHOT_BYTES = 200_000;

/**
 * Maximum encoded URL parameter character length before decoding is refused.
 * base64url overhead ≈ 4/3 × input; 300 KB encoded is already very generous
 * and protects against allocation-bomb attacks.
 */
export const MAX_ENCODED_CHARS = 300_000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a string to a base64url-encoded string (RFC 4648 §5).
 * Works in both browser (btoa) and Node 18+ (Buffer.from).
 */
function toBase64Url(input: string): string {
  let b64: string;
  if (typeof Buffer !== 'undefined') {
    b64 = Buffer.from(input, 'binary').toString('base64');
  } else {
    b64 = btoa(input);
  }
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/**
 * Decode a base64url-encoded string back to a binary string.
 * Works in both browser (atob) and Node 18+.
 */
function fromBase64Url(input: string): string {
  // Restore standard base64 padding and characters.
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const remainder = padded.length % 4;
  const standard = remainder ? padded + '='.repeat(4 - remainder) : padded;
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(standard, 'base64').toString('binary');
  }
  return atob(standard);
}

/**
 * Encode a binary string as a Uint8Array (each char → its char code, 0–255).
 */
function binaryStringToUint8Array(s: string): Uint8Array {
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) {
    bytes[i] = s.charCodeAt(i) & 0xff;
  }
  return bytes;
}

/**
 * Decode a Uint8Array back to a binary string.
 */
function uint8ArrayToBinaryString(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += String.fromCharCode(bytes[i]);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Compression (optional, progressive enhancement)
// ---------------------------------------------------------------------------

/**
 * Deflate-compress a UTF-8 string using CompressionStream.
 * Returns null if CompressionStream is unavailable.
 */
async function deflateString(input: string): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(input);
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    await writer.write(data);
    await writer.close();
    const reader = cs.readable.getReader();
    const chunks: Uint8Array[] = [];
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      if (result.value) chunks.push(result.value);
    }
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Inflate a deflate-raw compressed Uint8Array back to a UTF-8 string.
 * Returns null if DecompressionStream is unavailable.
 */
async function inflateToString(data: Uint8Array): Promise<string | null> {
  if (typeof DecompressionStream === 'undefined') return null;
  try {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    // Copy into an owned ArrayBuffer (Uint8Array<ArrayBuffer>) so the DOM
    // WebStream types are satisfied. `data` arrives as Uint8Array<ArrayBufferLike>
    // from binaryStringToUint8Array. Cf. lessons.md "Uint8Array<ArrayBufferLike>
    // vs BufferSource in TypeScript strict WebCrypto types".
    const owned = new Uint8Array(new ArrayBuffer(data.length));
    owned.set(data);
    await writer.write(owned);
    await writer.close();
    const reader = ds.readable.getReader();
    const chunks: Uint8Array[] = [];
    let done = false;
    while (!done) {
      const result = await reader.read();
      done = result.done;
      if (result.value) chunks.push(result.value);
    }
    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    const decoder = new TextDecoder();
    return decoder.decode(out);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encode a graph snapshot as a URL-safe string suitable for the `s` query
 * parameter of `/embed?s=<value>`.
 *
 * Tries to compress with deflate-raw first (modern browsers + Node 18+).
 * Falls back to plain base64url-encoded JSON if compression is unavailable.
 *
 * Throws `SnapshotTooLargeError` if the uncompressed JSON exceeds
 * `MAX_SNAPSHOT_BYTES`.
 *
 * NEVER includes note content — only titles and edge topology.
 */
export async function encodeSnapshot(snapshot: EmbedSnapshot): Promise<string> {
  const json = JSON.stringify(snapshot);
  // Measure in bytes by encoding to UTF-8 first.
  const encoder = new TextEncoder();
  const jsonBytes = encoder.encode(json);
  if (jsonBytes.length > MAX_SNAPSHOT_BYTES) {
    throw new SnapshotTooLargeError(
      `Snapshot JSON is ${jsonBytes.length} bytes, exceeding the ${MAX_SNAPSHOT_BYTES}-byte limit. ` +
        `Reduce the number of nodes/edges or apply filters before sharing.`,
    );
  }

  // Try compressed path.
  const compressed = await deflateString(json);
  if (compressed !== null) {
    const binary = uint8ArrayToBinaryString(compressed);
    return 'z' + toBase64Url(binary);
  }

  // Fallback: plain base64url JSON. Start with '{' discriminator (the raw JSON
  // already starts with '{', so we can just base64url-encode the whole thing).
  const binary = uint8ArrayToBinaryString(jsonBytes);
  return toBase64Url(binary);
}

/**
 * Decode a URL parameter (from `/embed?s=<value>`) back into an `EmbedSnapshot`.
 *
 * Throws `SnapshotTooLargeError`  if the encoded string exceeds `MAX_ENCODED_CHARS`.
 * Throws `SnapshotDecodeError`    if the string is malformed or fails validation.
 */
export async function decodeSnapshot(encoded: string): Promise<EmbedSnapshot> {
  if (encoded.length > MAX_ENCODED_CHARS) {
    throw new SnapshotTooLargeError(
      `Encoded snapshot is ${encoded.length} chars, exceeding the ${MAX_ENCODED_CHARS}-char limit.`,
    );
  }

  let json: string;

  if (encoded.startsWith('z')) {
    // Compressed path: strip 'z' prefix, base64url-decode, inflate.
    const binary = fromBase64Url(encoded.slice(1));
    const bytes = binaryStringToUint8Array(binary);
    const inflated = await inflateToString(bytes);
    if (inflated === null) {
      throw new SnapshotDecodeError(
        'DecompressionStream is unavailable; cannot decode this snapshot in this environment.',
      );
    }
    json = inflated;
  } else {
    // Uncompressed path: base64url-decode to binary, then interpret as UTF-8.
    const binary = fromBase64Url(encoded);
    const bytes = binaryStringToUint8Array(binary);
    const decoder = new TextDecoder();
    json = decoder.decode(bytes);
  }

  return parseSnapshotJson(json);
}

/**
 * Parse and validate a raw JSON string as an `EmbedSnapshot`.
 * Throws `SnapshotDecodeError` on any structure violation.
 */
function parseSnapshotJson(json: string): EmbedSnapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new SnapshotDecodeError('Snapshot JSON is not valid JSON.');
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new SnapshotDecodeError('Snapshot must be a JSON object.');
  }

  const obj = raw as Record<string, unknown>;

  if (obj['v'] !== 1) {
    throw new SnapshotDecodeError(`Unknown snapshot version: ${String(obj['v'])}. Expected 1.`);
  }

  if (!Array.isArray(obj['n'])) {
    throw new SnapshotDecodeError('Snapshot.n (nodes) must be an array.');
  }

  if (!Array.isArray(obj['e'])) {
    throw new SnapshotDecodeError('Snapshot.e (edges) must be an array.');
  }

  const nodes: SnapshotNode[] = [];
  for (let i = 0; i < (obj['n'] as unknown[]).length; i++) {
    const raw = (obj['n'] as unknown[])[i];
    if (typeof raw !== 'object' || raw === null) {
      throw new SnapshotDecodeError(`nodes[${i}] is not an object.`);
    }
    const n = raw as Record<string, unknown>;
    if (typeof n['i'] !== 'string') {
      throw new SnapshotDecodeError(`nodes[${i}].i must be a string.`);
    }
    if (typeof n['t'] !== 'string') {
      throw new SnapshotDecodeError(`nodes[${i}].t must be a string.`);
    }
    nodes.push({ i: n['i'] as string, t: n['t'] as string });
  }

  const edges: SnapshotEdge[] = [];
  for (let i = 0; i < (obj['e'] as unknown[]).length; i++) {
    const raw = (obj['e'] as unknown[])[i];
    if (typeof raw !== 'object' || raw === null) {
      throw new SnapshotDecodeError(`edges[${i}] is not an object.`);
    }
    const e = raw as Record<string, unknown>;
    if (typeof e['s'] !== 'string') {
      throw new SnapshotDecodeError(`edges[${i}].s must be a string.`);
    }
    if (typeof e['t'] !== 'string') {
      throw new SnapshotDecodeError(`edges[${i}].t must be a string.`);
    }
    if (e['k'] !== 'w' && e['k'] !== 'm' && e['k'] !== 'r') {
      throw new SnapshotDecodeError(`edges[${i}].k must be 'w', 'm', or 'r'.`);
    }
    edges.push({ s: e['s'] as string, t: e['t'] as string, k: e['k'] as 'w' | 'm' | 'r' });
  }

  return { v: 1, n: nodes, e: edges };
}

// ---------------------------------------------------------------------------
// Conversion helpers (engine types → snapshot types)
// ---------------------------------------------------------------------------

import type { GraphNode, GraphEdge } from '@graphvault/engine';

/**
 * Convert engine `GraphNode[]` + `GraphEdge[]` to a compact `EmbedSnapshot`.
 *
 * PRIVACY CONTRACT: only `id` and `title` are taken from nodes. No `content`,
 * no `path` (which could reveal directory structure), no tags, no timestamps.
 *
 * Only resolved edges are included — unresolved edges would expose internal
 * link-target strings that may contain path/title information the user hasn't
 * curated for sharing.
 */
export function buildSnapshot(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): EmbedSnapshot {
  const nodeIds = new Set(nodes.map((n) => n.id));

  const snapshotNodes: SnapshotNode[] = nodes.map((n) => ({
    i: n.id,
    t: n.title,
  }));

  const snapshotEdges: SnapshotEdge[] = [];
  for (const e of edges) {
    if (!e.resolved) continue;
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    let k: 'w' | 'm' | 'r';
    if (e.type === 'wikilink') {
      k = 'w';
    } else if (e.type === 'markdown') {
      k = 'm';
    } else {
      k = 'r';
    }
    snapshotEdges.push({ s: e.source, t: e.target, k });
  }

  return { v: 1, n: snapshotNodes, e: snapshotEdges };
}

/**
 * Generate a shareable `/embed` URL with the graph snapshot encoded in the `s`
 * parameter. Returns both the direct URL and a ready-to-paste `<iframe>` snippet.
 *
 * @param snapshot  The snapshot to encode.
 * @param baseUrl   The base URL of the app (e.g. `window.location.origin`). Must
 *                  end WITHOUT a trailing slash.
 */
export async function generateEmbedUrl(
  snapshot: EmbedSnapshot,
  baseUrl: string,
): Promise<{ url: string; iframe: string }> {
  const encoded = await encodeSnapshot(snapshot);
  const url = `${baseUrl}/embed/?s=${encoded}`;
  const iframe = `<iframe src="${url}" width="800" height="600" style="border:none;border-radius:8px;" title="Knowledge graph" loading="lazy"></iframe>`;
  return { url, iframe };
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when a snapshot exceeds the configured size limits. */
export class SnapshotTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotTooLargeError';
  }
}

/** Thrown when a snapshot string cannot be decoded or fails structure validation. */
export class SnapshotDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotDecodeError';
  }
}
