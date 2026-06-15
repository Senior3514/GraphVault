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
 * Vault-relative sub-path for a proxy operation. The server will append this
 * to the stored WebDAV base URL. Must be safe (no path traversal).
 */
export const webdavProxyPathSchema = z
  .string()
  .max(1024)
  .refine(
    // Reject path traversal, leading slashes, and ASCII control characters.
    // eslint-disable-next-line no-control-regex
    (p) => !p.includes('..') && !p.startsWith('/') && !/[\x00-\x1f]/.test(p),
    'invalid proxy path',
  );
export type WebDavProxyPath = z.infer<typeof webdavProxyPathSchema>;
