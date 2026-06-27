import { z } from 'zod';

/**
 * Shared zod schemas for the WebDAV proxy feature (M18).
 *
 * The server stores WebDAV credentials server-side (never returned to the
 * client). These schemas describe:
 *   - The payload for configuring a WebDAV backend per user.
 *   - The non-secret info the client may GET back.
 *   - The per-file proxy request the client sends via the server.
 */

/** WebDAV URL: must be http or https, max 2048 bytes. */
export const webdavUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), 'WebDAV URL must use http or https');

/** Store or update the WebDAV configuration for the authenticated user. */
export const webdavConfigRequestSchema = z.object({
  /** Full URL of the WebDAV endpoint, e.g. https://cloud.example.com/remote.php/dav/files/user/ */
  url: webdavUrlSchema,
  /** HTTP Basic auth username. */
  username: z.string().min(1).max(254),
  /** HTTP Basic auth password or app-password. */
  password: z.string().min(1).max(1024),
});
export type WebDavConfigRequest = z.infer<typeof webdavConfigRequestSchema>;

/**
 * Non-secret subset returned by GET /v1/storage/webdav/config.
 * The password is NEVER returned to the client.
 */
export const webdavConfigInfoSchema = z.object({
  url: webdavUrlSchema,
  username: z.string(),
  /** ISO-8601 timestamp when the config was last saved. */
  updatedAt: z.string(),
});
export type WebDavConfigInfo = z.infer<typeof webdavConfigInfoSchema>;

/**
 * Return true when `segment` is a dot-dot traversal component in any encoding.
 *
 * Fastify only URL-decodes path parameters once, so a double-encoded input
 * `%252e%252e` arrives as `%2e%2e` in `request.params['*']`.  The old
 * `includes('..')` check missed this because `%2e%2e` contains no literal dots.
 *
 * The fix: fully decode the path component (repeated decodeURIComponent until
 * stable) before checking for `..` segments, then also reject the raw encoded
 * forms `%2e` / `%252e` as dots.
 */
function containsPathTraversal(p: string): boolean {
  // 1. Fast path: literal dots already in the string.
  if (p.includes('..')) return true;

  // 2. Detect any URL-encoded dot form in the raw string:
  //    %2e or %2E (single percent), %252e / %252E (double percent), etc.
  //    We normalise to lowercase for the check.
  const lower = p.toLowerCase();
  if (lower.includes('%2e') || lower.includes('%252e')) return true;

  // 3. Fully decode and re-check.  decodeURIComponent throws on malformed
  //    sequences; treat those as traversal (reject, not crash).
  let decoded = p;
  try {
    let prev = '';
    // Repeatedly decode until stable, to catch any depth of percent-encoding.
    while (decoded !== prev) {
      prev = decoded;
      decoded = decodeURIComponent(decoded);
    }
  } catch {
    // Malformed percent sequence — reject for safety.
    return true;
  }
  if (decoded.includes('..')) return true;

  return false;
}

/**
 * Vault-relative sub-path for a proxy operation. The server will append this
 * to the stored WebDAV base URL. Must be safe (no path traversal).
 *
 * Security note: the literal `..` check alone is insufficient because Fastify
 * only decodes path parameters once.  A double-encoded input `%252e%252e`
 * arrives as `%2e%2e` in the wildcard param; `includes('..')` would return
 * false.  `containsPathTraversal` above catches all encoding depths.
 */
export const webdavProxyPathSchema = z
  .string()
  .max(1024)
  .refine(
    // Reject path traversal (all encodings), leading slashes, and ASCII
    // control characters.
    // eslint-disable-next-line no-control-regex
    (p) => !containsPathTraversal(p) && !p.startsWith('/') && !/[\x00-\x1f]/.test(p),
    'invalid proxy path',
  );
export type WebDavProxyPath = z.infer<typeof webdavProxyPathSchema>;
