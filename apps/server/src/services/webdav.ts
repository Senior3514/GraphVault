/**
 * WebDAV proxy service (M18).
 *
 * Security model:
 *   - WebDAV credentials (URL + username + password) are stored server-side,
 *     encrypted at rest with AES-256-GCM using a key derived from the server's
 *     GRAPHVAULT_ENCRYPTION_KEY and the user's ID.
 *   - If no server encryption key is configured, credentials are stored with a
 *     deterministic per-user key derived via HKDF from a process-local secret.
 *     This keeps credentials out of plaintext even without explicit key config,
 *     while being transparent about the trade-off (the key is in-process memory,
 *     not a persisted secret).
 *   - Credentials are NEVER returned to the client. The client receives only the
 *     non-secret WebDavConfigInfo (url + username + updatedAt).
 *   - All outbound WebDAV requests are made server-side, so the browser never
 *     contacts the WebDAV server directly (avoids CORS, keeps creds off client).
 *
 * Proxy scope:
 *   - GET  /v1/storage/webdav/proxy/*path  — download a file from WebDAV
 *   - PUT  /v1/storage/webdav/proxy/*path  — upload a file to WebDAV
 *   - DELETE /v1/storage/webdav/proxy/*path — delete a file from WebDAV
 *   - PROPFIND (via special GET ?propfind=1) is NOT proxied; the adapter stores
 *     notes as a flat JSON document at a single well-known path to keep the
 *     proxy minimal and auditable.
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import type { WebDavConfigInfo, WebDavConfigRequest } from '@graphvault/shared';
import { badRequest, notFound } from '../errors.js';
import { guardedFetch } from './ssrf.js';
import type { Storage, WebDavConfigRecord } from '../store/types.js';

// ---------------------------------------------------------------------------
// Encryption helpers for storing the WebDAV password at rest
// ---------------------------------------------------------------------------

const AES_ALGORITHM = 'aes-256-gcm' as const;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Derive a per-user 32-byte encryption key.
 *
 * If the server has a configured GRAPHVAULT_ENCRYPTION_KEY we use it as the
 * IKM; otherwise we use a process-lifetime random secret. Either way the key
 * is different for each user (via the `userId` salt).
 *
 * This means:
 *  - With GRAPHVAULT_ENCRYPTION_KEY: creds survive server restarts and are
 *    only recoverable with the configured key.
 *  - Without: creds are encrypted in-process only; a restart invalidates them
 *    (the user must re-enter the password). This is acceptable for a dev/test
 *    deployment and is explicit in the Settings UI.
 */
const PROCESS_FALLBACK_KEY = randomBytes(32);

function deriveUserKey(userId: string, serverKey?: Buffer): Buffer {
  const ikm = serverKey ?? PROCESS_FALLBACK_KEY;
  const salt = Buffer.from(userId, 'utf8');
  const info = Buffer.from('graphvault-webdav-cred-v1', 'utf8');
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, 32));
}

function encryptPassword(plaintext: string, userId: string, serverKey?: Buffer): string {
  const key = deriveUserKey(userId, serverKey);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(AES_ALGORITHM, key, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: base64(nonce || tag || ciphertext)
  return Buffer.concat([nonce, tag, ct]).toString('base64');
}

function decryptPassword(ciphertext: string, userId: string, serverKey?: Buffer): string {
  const key = deriveUserKey(userId, serverKey);
  const buf = Buffer.from(ciphertext, 'base64');
  if (buf.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error('Malformed WebDAV credential ciphertext');
  }
  const nonce = buf.subarray(0, NONCE_BYTES);
  const tag = buf.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const ct = buf.subarray(NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(AES_ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Failed to decrypt WebDAV credentials (wrong key or corrupted data)');
  }
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/**
 * Return true when `s` contains a dot-dot path traversal in any encoding.
 *
 * `webdavProxyPathSchema` is the first line of defence, but `joinWebDavUrl` is
 * the second (belt-and-suspenders). Fastify decodes path parameters only once,
 * so a double-encoded input `%252e%252e` arrives here as `%2e%2e`.  The old
 * `includes('..')` check missed that because `%2e%2e` contains no literal dots.
 * The fix: also reject percent-encoded dot forms and fully-decoded traversal.
 */
function containsTraversal(s: string): boolean {
  if (s.includes('..')) return true;
  const lower = s.toLowerCase();
  if (lower.includes('%2e') || lower.includes('%252e')) return true;
  // Iteratively decode (handles any depth) and re-check.
  let decoded = s;
  try {
    let prev = '';
    while (decoded !== prev) {
      prev = decoded;
      decoded = decodeURIComponent(decoded);
    }
  } catch {
    return true; // malformed percent sequence — reject for safety
  }
  return decoded.includes('..');
}

/**
 * Join the stored base URL with a vault-relative proxy path, preventing any
 * path traversal. The base URL is the canonical WebDAV root that the user
 * configured; the proxy path is the vault-relative portion from the client.
 *
 * Rules:
 * - The base URL must end with `/` (we normalise it).
 * - The proxy path must not contain `..` in any encoding, or start with `/`.
 * - The result is always a descendant of the base URL.
 */
export function joinWebDavUrl(base: string, proxyPath: string): string {
  // Ensure trailing slash on base.
  const normalised = base.endsWith('/') ? base : `${base}/`;
  // Strip any leading slashes from proxy path.
  const clean = proxyPath.replace(/^\/+/, '');
  // Guard against path traversal in ALL encodings (literal, single-, double-).
  if (containsTraversal(clean)) {
    throw new Error('Path traversal in WebDAV proxy path');
  }
  return `${normalised}${clean}`;
}

// ---------------------------------------------------------------------------
// WebDavService
// ---------------------------------------------------------------------------

export class WebDavService {
  constructor(
    private readonly storage: Storage,
    private readonly serverKey?: Buffer,
  ) {}

  // ---- Config management ----

  /**
   * Store or update the WebDAV configuration for the given user.
   * The password is encrypted before being written to storage.
   */
  async saveConfig(userId: string, input: WebDavConfigRequest): Promise<void> {
    const encryptedPassword = encryptPassword(input.password, userId, this.serverKey);
    const record: WebDavConfigRecord = {
      userId,
      url: input.url,
      username: input.username,
      encryptedPassword,
      updatedAt: new Date().toISOString(),
    };
    await this.storage.upsertWebDavConfig(record);
  }

  /**
   * Return the non-secret config info for the user. Returns null if not
   * configured — callers should convert this to a 404.
   */
  async getConfigInfo(userId: string): Promise<WebDavConfigInfo | null> {
    const record = await this.storage.getWebDavConfig(userId);
    if (!record) return null;
    return { url: record.url, username: record.username, updatedAt: record.updatedAt };
  }

  /** Remove the WebDAV configuration for the given user. */
  async deleteConfig(userId: string): Promise<void> {
    await this.storage.deleteWebDavConfig(userId);
  }

  // ---- Proxy operations ----

  /**
   * Load the full credential record for a user (including decrypted password).
   * Throws 404 if WebDAV is not configured.
   */
  private async requireConfig(userId: string): Promise<{ url: string; credentials: string }> {
    const record = await this.storage.getWebDavConfig(userId);
    if (!record) {
      throw notFound('WebDAV is not configured for this account');
    }
    const password = decryptPassword(record.encryptedPassword, userId, this.serverKey);
    // HTTP Basic auth value
    const credentials = Buffer.from(`${record.username}:${password}`, 'utf8').toString('base64');
    return { url: record.url, credentials };
  }

  /**
   * GET a file from the user's WebDAV server and return its content as a Buffer.
   */
  async proxyGet(
    userId: string,
    proxyPath: string,
  ): Promise<{ content: Buffer; contentType: string }> {
    const { url, credentials } = await this.requireConfig(userId);
    const targetUrl = joinWebDavUrl(url, proxyPath);

    let res: Response;
    try {
      res = await guardedFetch(targetUrl, {
        method: 'GET',
        headers: { Authorization: `Basic ${credentials}` },
      });
    } catch (err) {
      throw badRequest(`WebDAV GET failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      if (res.status === 404) throw notFound(`WebDAV: file not found at ${proxyPath}`);
      throw badRequest(`WebDAV GET returned ${res.status}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    return { content: buf, contentType };
  }

  /**
   * PUT a file to the user's WebDAV server.
   * Returns the response status code (201 or 204 are both success).
   */
  async proxyPut(
    userId: string,
    proxyPath: string,
    body: Buffer,
    contentType: string,
  ): Promise<number> {
    const { url, credentials } = await this.requireConfig(userId);
    const targetUrl = joinWebDavUrl(url, proxyPath);

    let res: Response;
    try {
      res = await guardedFetch(targetUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Basic ${credentials}`,
          'Content-Type': contentType,
          'Content-Length': String(body.length),
        },
        body,
      });
    } catch (err) {
      throw badRequest(`WebDAV PUT failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      throw badRequest(`WebDAV PUT returned ${res.status}`);
    }
    return res.status;
  }

  /**
   * DELETE a file on the user's WebDAV server.
   */
  async proxyDelete(userId: string, proxyPath: string): Promise<void> {
    const { url, credentials } = await this.requireConfig(userId);
    const targetUrl = joinWebDavUrl(url, proxyPath);

    let res: Response;
    try {
      res = await guardedFetch(targetUrl, {
        method: 'DELETE',
        headers: { Authorization: `Basic ${credentials}` },
      });
    } catch (err) {
      throw badRequest(`WebDAV DELETE failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 204 = deleted, 404 = already gone — both acceptable.
    if (!res.ok && res.status !== 404) {
      throw badRequest(`WebDAV DELETE returned ${res.status}`);
    }
  }
}
