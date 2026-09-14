/**
 * Google Cloud Storage proxy service (Wave 16).
 *
 * Security model (a faithful sibling of {@link ./s3.ts S3Service}):
 *   - GCS HMAC interop credentials (bucket + accessId + secret, optional prefix)
 *     are stored server-side, encrypted at rest with AES-256-GCM. The key is
 *     derived via HKDF from GRAPHVAULT_ENCRYPTION_KEY and the user's ID with a
 *     credential-type specific info string `graphvault-gcs-cred-v1`, so GCS
 *     sub-keys are independent of WebDAV/S3/Azure sub-keys for the same user.
 *   - If no server encryption key is configured, a process-lifetime random key
 *     is used (credentials are lost on restart - same trade-off as S3/WebDAV).
 *   - Credentials are NEVER returned to the client. The client receives only the
 *     non-secret GcsConfigInfo (bucket + accessId + prefix + updatedAt).
 *   - GCS exposes an S3-compatible XML API at https://storage.googleapis.com that
 *     accepts AWS Signature V4. We reuse the exact SigV4 signer from s3.ts with
 *     service "s3", region "auto", host storage.googleapis.com - zero new deps.
 *     This honors the lesson "host header not sent to fetch manually": signS3Request
 *     signs `host` then strips it from the returned headers.
 *   - The browser never contacts GCS directly (avoids CORS, keeps creds off the
 *     client).
 *
 * Proxy scope (single-object vault blob):
 *   - GET    /v1/storage/gcs/object/graphvault-vault.json - download
 *   - PUT    /v1/storage/gcs/object/graphvault-vault.json - upload
 *   - DELETE /v1/storage/gcs/object/graphvault-vault.json - delete
 */

import { hkdfSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { badRequest, notFound } from '../errors.js';
import { signS3Request } from './s3.js';
import { guardedFetch } from './ssrf.js';
import type { GcsConfigRecord, Storage } from '../store/types.js';

// ---------------------------------------------------------------------------
// Public config shapes (defined here - shared package is not modifiable in this
// wave; mirrors the S3ConfigRequest / S3ConfigInfo split exactly).
// ---------------------------------------------------------------------------

export interface GcsConfigRequest {
  /** GCS bucket name. */
  bucket: string;
  /** HMAC interop access ID (the "Access ID" from a GCS HMAC key). */
  accessId: string;
  /** HMAC interop secret. The secret - encrypted at rest, never returned. */
  secret: string;
  /**
   * Optional object-key prefix prepended to all keys. Must end with "/" when
   * non-empty (e.g. "graphvault/").
   */
  prefix?: string;
}

export interface GcsConfigInfo {
  bucket: string;
  accessId: string;
  prefix?: string;
  /** ISO-8601 timestamp when the config was last saved. */
  updatedAt: string;
}

/** GCS XML API host and the SigV4 region GCS expects for interop signing. */
export const GCS_HOST = 'storage.googleapis.com';
export const GCS_REGION = 'auto';

// ---------------------------------------------------------------------------
// Encryption helpers (identical pattern to s3.ts; unique HKDF info string)
// ---------------------------------------------------------------------------

const AES_ALGORITHM = 'aes-256-gcm' as const;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

const PROCESS_FALLBACK_KEY = randomBytes(32);

function deriveUserKey(userId: string, serverKey?: Buffer): Buffer {
  const ikm = serverKey ?? PROCESS_FALLBACK_KEY;
  const salt = Buffer.from(userId, 'utf8');
  // Unique per credential type (see lessons.md: HKDF info must be unique).
  const info = Buffer.from('graphvault-gcs-cred-v1', 'utf8');
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, 32));
}

function encryptSecret(plaintext: string, userId: string, serverKey?: Buffer): string {
  const key = deriveUserKey(userId, serverKey);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(AES_ALGORITHM, key, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, tag, ct]).toString('base64');
}

function decryptSecret(ciphertext: string, userId: string, serverKey?: Buffer): string {
  const key = deriveUserKey(userId, serverKey);
  const buf = Buffer.from(ciphertext, 'base64');
  if (buf.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error('Malformed GCS credential ciphertext');
  }
  const nonce = buf.subarray(0, NONCE_BYTES);
  const tag = buf.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const ct = buf.subarray(NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(AES_ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Failed to decrypt GCS credentials (wrong key or corrupted data)');
  }
}

// ---------------------------------------------------------------------------
// URL helper
// ---------------------------------------------------------------------------

/** Build the GCS XML-API object URL: https://storage.googleapis.com/<bucket>/<prefix><key>. */
export function buildGcsObjectUrl(bucket: string, objectKey: string, prefix?: string): string {
  const fullKey = `${prefix ?? ''}${objectKey}`;
  return `https://${GCS_HOST}/${bucket}/${fullKey}`;
}

// ---------------------------------------------------------------------------
// GcsService
// ---------------------------------------------------------------------------

export class GcsService {
  constructor(
    private readonly storage: Storage,
    private readonly serverKey?: Buffer,
  ) {}

  // ---- Config management ----

  /** Store or update the GCS configuration for the given user. */
  async saveConfig(userId: string, input: GcsConfigRequest): Promise<void> {
    const encryptedSecret = encryptSecret(input.secret, userId, this.serverKey);
    const record: GcsConfigRecord = {
      userId,
      bucket: input.bucket,
      accessId: input.accessId,
      encryptedSecret,
      prefix: input.prefix,
      updatedAt: new Date().toISOString(),
    };
    await this.storage.upsertGcsConfig(record);
  }

  /** Return the non-secret config info for the user, or null if not configured. */
  async getConfigInfo(userId: string): Promise<GcsConfigInfo | null> {
    const record = await this.storage.getGcsConfig(userId);
    if (!record) return null;
    return {
      bucket: record.bucket,
      accessId: record.accessId,
      prefix: record.prefix,
      updatedAt: record.updatedAt,
    };
  }

  /** Remove the GCS configuration for the given user. */
  async deleteConfig(userId: string): Promise<void> {
    await this.storage.deleteGcsConfig(userId);
  }

  // ---- Proxy operations ----

  private async requireConfig(userId: string): Promise<{
    bucket: string;
    accessId: string;
    secret: string;
    prefix: string | undefined;
  }> {
    const record = await this.storage.getGcsConfig(userId);
    if (!record) {
      throw notFound('Google Cloud Storage is not configured for this account');
    }
    const secret = decryptSecret(record.encryptedSecret, userId, this.serverKey);
    return {
      bucket: record.bucket,
      accessId: record.accessId,
      secret,
      prefix: record.prefix,
    };
  }

  /** GET the vault object and return its content. */
  async proxyGet(
    userId: string,
    objectKey: string,
  ): Promise<{ content: Buffer; contentType: string }> {
    const creds = await this.requireConfig(userId);
    const url = buildGcsObjectUrl(creds.bucket, objectKey, creds.prefix);
    const signed = signS3Request({
      method: 'GET',
      url,
      region: GCS_REGION,
      accessKeyId: creds.accessId,
      secretAccessKey: creds.secret,
      payload: Buffer.alloc(0),
    });

    let res: Response;
    try {
      res = await guardedFetch(signed.url, { method: 'GET', headers: signed.headers });
    } catch (err) {
      throw badRequest(`GCS GET failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      if (res.status === 404) throw notFound(`GCS: object not found: ${objectKey}`);
      throw badRequest(`GCS GET returned ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    return { content: buf, contentType };
  }

  /** PUT the vault object. Returns the upstream status code. */
  async proxyPut(
    userId: string,
    objectKey: string,
    body: Buffer,
    contentType: string,
  ): Promise<number> {
    const creds = await this.requireConfig(userId);
    const url = buildGcsObjectUrl(creds.bucket, objectKey, creds.prefix);
    const signed = signS3Request({
      method: 'PUT',
      url,
      region: GCS_REGION,
      accessKeyId: creds.accessId,
      secretAccessKey: creds.secret,
      payload: body,
      extraHeaders: { 'content-type': contentType },
    });

    let res: Response;
    try {
      res = await guardedFetch(signed.url, {
        method: 'PUT',
        headers: { ...signed.headers, 'content-length': String(body.length) },
        body,
      });
    } catch (err) {
      throw badRequest(`GCS PUT failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      throw badRequest(`GCS PUT returned ${res.status}`);
    }
    return res.status;
  }

  /** DELETE the vault object. */
  async proxyDelete(userId: string, objectKey: string): Promise<void> {
    const creds = await this.requireConfig(userId);
    const url = buildGcsObjectUrl(creds.bucket, objectKey, creds.prefix);
    const signed = signS3Request({
      method: 'DELETE',
      url,
      region: GCS_REGION,
      accessKeyId: creds.accessId,
      secretAccessKey: creds.secret,
      payload: Buffer.alloc(0),
    });

    let res: Response;
    try {
      res = await guardedFetch(signed.url, { method: 'DELETE', headers: signed.headers });
    } catch (err) {
      throw badRequest(`GCS DELETE failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 204 = deleted, 404 = already gone - both acceptable.
    if (!res.ok && res.status !== 404) {
      throw badRequest(`GCS DELETE returned ${res.status}`);
    }
  }
}
