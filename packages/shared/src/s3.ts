import { z } from 'zod';

/**
 * Shared zod schemas for the S3-compatible storage proxy feature (M18).
 *
 * The server stores S3 credentials server-side (never returned to the
 * client). These schemas describe:
 *   - The payload for configuring an S3-compatible backend per user.
 *   - The non-secret info the client may GET back.
 *
 * Works with AWS S3, MinIO, Cloudflare R2, Backblaze B2, and any
 * S3-compatible provider. When `endpoint` is omitted the service defaults
 * to AWS S3 (https://s3.<region>.amazonaws.com).
 */

/** Optional custom endpoint URL for S3-compatible providers (MinIO, R2, B2, …). */
export const s3EndpointSchema = z
  .string()
  .url()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), 'S3 endpoint must use http or https')
  .optional();

/** Store or update the S3 configuration for the authenticated user. */
export const s3ConfigRequestSchema = z.object({
  /**
   * Optional custom endpoint URL. Omit for AWS S3. For MinIO / R2 / B2 you
   * must supply the provider-specific URL, e.g.
   *   https://account-id.r2.cloudflarestorage.com
   *   https://s3.us-east-005.backblazeb2.com
   *   http://minio.local:9000
   */
  endpoint: s3EndpointSchema,
  /** AWS region, e.g. "us-east-1". Required even for non-AWS providers. */
  region: z.string().min(1).max(64),
  /** S3 bucket name. */
  bucket: z.string().min(1).max(63),
  /** Access key ID (20-char for AWS; varies for compatible providers). */
  accessKeyId: z.string().min(1).max(256),
  /** Secret access key (40-char for AWS; varies for compatible providers). */
  secretAccessKey: z.string().min(1).max(1024),
  /**
   * Optional key prefix prepended to all object keys.
   * Useful for sharing a bucket: "graphvault/" → keys become
   * "graphvault/graphvault-vault.json".
   * Must end with "/" when non-empty.
   */
  prefix: z
    .string()
    .max(512)
    .refine((p) => p === '' || p.endsWith('/'), 'prefix must be empty or end with "/"')
    .optional(),
});
export type S3ConfigRequest = z.infer<typeof s3ConfigRequestSchema>;

/**
 * Non-secret subset returned by GET /v1/storage/s3/config.
 * The secretAccessKey is NEVER returned to the client.
 */
export const s3ConfigInfoSchema = z.object({
  endpoint: z.string().optional(),
  region: z.string(),
  bucket: z.string(),
  accessKeyId: z.string(),
  prefix: z.string().optional(),
  /** ISO-8601 timestamp when the config was last saved. */
  updatedAt: z.string(),
});
export type S3ConfigInfo = z.infer<typeof s3ConfigInfoSchema>;
