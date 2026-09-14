/**
 * Content hashing for the sync engine.
 *
 * Produces the canonical `sha256:<hex>` form used everywhere in the protocol
 * (see `@graphvault/shared`'s `formatContentHash`). Prefers the Web Crypto
 * `crypto.subtle` API (available in browsers and modern Node) so the same code
 * runs in every host; falls back to `node:crypto` when SubtleCrypto is absent.
 */

import { formatContentHash, type ContentHash } from '@graphvault/shared';

function toBytes(content: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(content);
  // Copy into a guaranteed ArrayBuffer-backed view so the type satisfies both
  // SubtleCrypto's BufferSource (DOM lib) and byteLength uses.
  const bytes = new Uint8Array(new ArrayBuffer(encoded.byteLength));
  bytes.set(encoded);
  return bytes;
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * Hash a string of content to `sha256:<hex>`. Async because Web Crypto's
 * digest is promise-based.
 */
export async function hashContent(content: string): Promise<ContentHash> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', toBytes(content));
    return formatContentHash(toHex(digest));
  }
  // Web Crypto is available in every browser and in modern Node (18+), so this
  // fallback only runs on older Node runtimes. The specifier is built at runtime
  // and marked `webpackIgnore` so browser bundlers never try to resolve a
  // Node-only built-in.
  const nodeCrypto = 'node:' + 'crypto';
  const { createHash } = (await import(
    /* webpackIgnore: true */ /* @vite-ignore */ nodeCrypto
  )) as typeof import('node:crypto');
  const hex = createHash('sha256').update(content, 'utf8').digest('hex');
  return formatContentHash(hex);
}

/** Byte length of a UTF-8 string - the `size` the protocol records. */
export function byteLength(content: string): number {
  return toBytes(content).length;
}
