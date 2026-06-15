/**
 * Content-hashing helpers.
 *
 * GraphVault identifies file content by a SHA-256 hash of the raw bytes,
 * lowercase hex-encoded, prefixed with the algorithm: `sha256:<hex>`.
 * The prefix lets us migrate algorithms later without ambiguity.
 */

export const CONTENT_HASH_ALGORITHM = 'sha256' as const;

export type ContentHash = `sha256:${string}`;

const HASH_RE = /^sha256:[0-9a-f]{64}$/;

export function isContentHash(value: string): value is ContentHash {
  return HASH_RE.test(value);
}

export function formatContentHash(hexDigest: string): ContentHash {
  const lower = hexDigest.toLowerCase();
  return `${CONTENT_HASH_ALGORITHM}:${lower}` as ContentHash;
}
