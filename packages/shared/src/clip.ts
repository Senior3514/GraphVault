import { z } from 'zod';

/**
 * Shared zod schemas for the URL web-clipper feature (M22).
 *
 * The server fetches the URL (no browser CORS), strips the HTML to Markdown,
 * and returns a structured note. The client creates the note via vault.importNotes().
 *
 * Privacy posture: `server` - the outbound HTTP request goes through the
 * self-hosted GraphVault server, not the browser. No third-party services
 * are involved beyond the target URL itself.
 */

/** A URL to clip: must be http or https, max 2048 bytes. */
export const clipUrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), 'Clip URL must use http or https');

/** POST /v1/clip request body. */
export const clipRequestSchema = z.object({
  /** The URL to fetch and convert to Markdown. */
  url: clipUrlSchema,
});
export type ClipRequest = z.infer<typeof clipRequestSchema>;

/** POST /v1/clip success response. */
export const clipResponseSchema = z.object({
  /** Page title (from <title> or first <h1>, or the URL as fallback). */
  title: z.string(),
  /** Converted Markdown content. Treat as untrusted - pass through DOMPurify. */
  markdown: z.string(),
  /** The canonical URL that was actually fetched (after redirects). */
  sourceUrl: z.string(),
});
export type ClipResponse = z.infer<typeof clipResponseSchema>;
