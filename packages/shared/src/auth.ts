import { z } from 'zod';

/**
 * Authentication & identity types shared by client and server.
 *
 * Security requirements (see docs/sync-protocol.md §Security):
 * - Passwords are NEVER sent or stored in raw form beyond the TLS boundary;
 *   the server stores only an Argon2id/bcrypt hash.
 * - Clients authenticate subsequent requests with a bearer access token.
 */

export const emailSchema = z.string().email().max(254);

/** A password as supplied by the user. Min length only; strength is advisory. */
export const passwordSchema = z.string().min(10).max(1024);

export const registerRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  /** Optional human-friendly name for the device performing registration. */
  deviceName: z.string().min(1).max(120).optional(),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: emailSchema,
  password: passwordSchema,
  deviceName: z.string().min(1).max(120).optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const authTokenSchema = z.object({
  /** Opaque bearer token. Sent as `Authorization: Bearer <token>`. */
  accessToken: z.string().min(1),
  /** Unix epoch seconds at which the access token expires. */
  expiresAt: z.number().int().positive(),
  userId: z.string().min(1),
  deviceId: z.string().min(1),
});
export type AuthToken = z.infer<typeof authTokenSchema>;

export interface PublicUser {
  id: string;
  email: string;
  createdAt: string; // ISO-8601
}
