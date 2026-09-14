/**
 * S3-compatible storage proxy service (M18).
 *
 * Security model:
 *   - S3 credentials (endpoint + region + bucket + accessKeyId + secretAccessKey)
 *     are stored server-side, encrypted at rest with AES-256-GCM using a key
 *     derived from the server's GRAPHVAULT_ENCRYPTION_KEY and the user's ID.
 *   - If no server encryption key is configured, credentials are stored with a
 *     deterministic per-user key derived via HKDF from a process-local secret.
 *   - Credentials are NEVER returned to the client. The client receives only the
 *     non-secret S3ConfigInfo (endpoint + region + bucket + accessKeyId + updatedAt).
 *   - All outbound S3 requests are signed using AWS Signature Version 4 (SigV4)
 *     implemented in pure Node `node:crypto` - zero new dependencies.
 *   - The browser never contacts S3 directly (avoids CORS, keeps creds off client).
 *
 * Proxy scope (single-object vault blob):
 *   - GET  /v1/storage/s3/object/graphvault-vault.json - download vault blob
 *   - PUT  /v1/storage/s3/object/graphvault-vault.json - upload vault blob
 *   - DELETE /v1/storage/s3/object/graphvault-vault.json - delete vault blob
 *
 * SigV4 implementation:
 *   AWS SigV4 signs each request with HMAC-SHA256 keyed on a date-derived signing
 *   key. The canonical request includes: method, URI, query string, selected
 *   headers (host + content-type + x-amz-content-sha256 + x-amz-date), and the
 *   SHA-256 hash of the payload. The Authorization header is then
 *   "AWS4-HMAC-SHA256 Credential=<key>/<date>/<region>/s3/aws4_request,
 *   SignedHeaders=..., Signature=<hex>".
 */

import {
  createHmac,
  createHash,
  hkdfSync,
  randomBytes,
  createCipheriv,
  createDecipheriv,
} from 'node:crypto';
import type { S3ConfigInfo, S3ConfigRequest } from '@graphvault/shared';
import { badRequest, notFound } from '../errors.js';
import { guardedFetch } from './ssrf.js';
import type { S3ConfigRecord, Storage } from '../store/types.js';

// ---------------------------------------------------------------------------
// Encryption helpers (identical pattern to webdav.ts)
// ---------------------------------------------------------------------------

const AES_ALGORITHM = 'aes-256-gcm' as const;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

const PROCESS_FALLBACK_KEY = randomBytes(32);

function deriveUserKey(userId: string, serverKey?: Buffer): Buffer {
  const ikm = serverKey ?? PROCESS_FALLBACK_KEY;
  const salt = Buffer.from(userId, 'utf8');
  const info = Buffer.from('graphvault-s3-cred-v1', 'utf8');
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
    throw new Error('Malformed S3 credential ciphertext');
  }
  const nonce = buf.subarray(0, NONCE_BYTES);
  const tag = buf.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const ct = buf.subarray(NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(AES_ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Failed to decrypt S3 credentials (wrong key or corrupted data)');
  }
}

// ---------------------------------------------------------------------------
// AWS Signature Version 4 (pure node:crypto - no aws-sdk)
// ---------------------------------------------------------------------------

/** SHA-256 hex digest. */
function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** HMAC-SHA256 keyed on `key`. Returns a Buffer. */
function hmacSha256(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * Derive the SigV4 signing key.
 *   kSecret  = "AWS4" + secretAccessKey
 *   kDate    = HMAC-SHA256(kSecret, date)   [YYYYMMDD]
 *   kRegion  = HMAC-SHA256(kDate, region)
 *   kService = HMAC-SHA256(kRegion, "s3")
 *   kSigning = HMAC-SHA256(kService, "aws4_request")
 */
function deriveSigningKey(secretAccessKey: string, dateStamp: string, region: string): Buffer {
  const kSecret = Buffer.from(`AWS4${secretAccessKey}`, 'utf8');
  const kDate = hmacSha256(kSecret, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, 's3');
  return hmacSha256(kService, 'aws4_request');
}

/** Format a Date as "YYYYMMDD" for SigV4. */
function datestamp(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

/** Format a Date as "YYYYMMDDTHHmmssZ" for SigV4 x-amz-date. */
function amzDatetime(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
}

export interface SigV4Params {
  method: string;
  /** Full URL (with scheme and host). Must not contain query string for PutObject/GetObject. */
  url: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Raw payload bytes (or empty Buffer for GET/DELETE). */
  payload: Buffer;
  /** Additional headers to include in the request (merged with required SigV4 headers). */
  extraHeaders?: Record<string, string>;
}

export interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

/**
 * Produce a signed request (URL + headers) for an S3 operation.
 *
 * Signed headers: host, x-amz-content-sha256, x-amz-date.
 * If `extraHeaders` contains `content-type`, it is also signed.
 *
 * Returns the merged headers object ready to pass to `fetch`.
 */
export function signS3Request(params: SigV4Params, now: Date = new Date()): SignedRequest {
  const { method, url, region, accessKeyId, secretAccessKey, payload, extraHeaders = {} } = params;

  const parsedUrl = new URL(url);
  const host = parsedUrl.host;
  const canonicalUri = parsedUrl.pathname || '/';
  const canonicalQueryString = parsedUrl.search ? parsedUrl.search.slice(1) : '';

  const dateStamp = datestamp(now);
  const amzDate = amzDatetime(now);
  const payloadHash = sha256Hex(payload);

  // Build the headers we will sign.
  const headersToSign: Record<string, string> = {
    host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': amzDate,
  };

  // Merge extra headers (content-type etc.) - lowercase keys for canonical form.
  for (const [k, v] of Object.entries(extraHeaders)) {
    headersToSign[k.toLowerCase()] = v;
  }

  // Canonical headers: sorted by key, each "key:value\n".
  const sortedKeys = Object.keys(headersToSign).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headersToSign[k]}\n`).join('');
  const signedHeaders = sortedKeys.join(';');

  // Canonical request.
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalUri,
    canonicalQueryString,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  // String to sign.
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  // Signature.
  const signingKey = deriveSigningKey(secretAccessKey, dateStamp, region);
  const signature = createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');

  // Authorization header.
  const authorization = [
    `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(', ');

  const allHeaders: Record<string, string> = {
    ...headersToSign,
    authorization,
  };
  // Remove `host` from the final headers map - fetch sets it automatically.
  delete allHeaders['host'];

  return { url, headers: allHeaders };
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/**
 * Build the S3 object URL for a given key.
 *
 * For AWS S3: https://s3.<region>.amazonaws.com/<bucket>/<key>
 * For S3-compatible providers: <endpoint>/<bucket>/<key>
 *
 * The optional `prefix` is prepended to the object key.
 */
export function buildS3ObjectUrl(
  endpoint: string | undefined,
  region: string,
  bucket: string,
  objectKey: string,
  prefix?: string,
): string {
  const base = endpoint ? endpoint.replace(/\/+$/, '') : `https://s3.${region}.amazonaws.com`;
  const fullKey = `${prefix ?? ''}${objectKey}`;
  return `${base}/${bucket}/${fullKey}`;
}

// ---------------------------------------------------------------------------
// S3Service
// ---------------------------------------------------------------------------

export class S3Service {
  constructor(
    private readonly storage: Storage,
    private readonly serverKey?: Buffer,
  ) {}

  // ---- Config management ----

  /**
   * Store or update the S3 configuration for the given user.
   * The secretAccessKey is encrypted before being written to storage.
   */
  async saveConfig(userId: string, input: S3ConfigRequest): Promise<void> {
    const encryptedSecretAccessKey = encryptSecret(input.secretAccessKey, userId, this.serverKey);
    const record: S3ConfigRecord = {
      userId,
      endpoint: input.endpoint,
      region: input.region,
      bucket: input.bucket,
      accessKeyId: input.accessKeyId,
      encryptedSecretAccessKey,
      prefix: input.prefix,
      updatedAt: new Date().toISOString(),
    };
    await this.storage.upsertS3Config(record);
  }

  /**
   * Return the non-secret config info for the user. Returns null if not
   * configured - callers should convert this to a 404.
   */
  async getConfigInfo(userId: string): Promise<S3ConfigInfo | null> {
    const record = await this.storage.getS3Config(userId);
    if (!record) return null;
    return {
      endpoint: record.endpoint,
      region: record.region,
      bucket: record.bucket,
      accessKeyId: record.accessKeyId,
      prefix: record.prefix,
      updatedAt: record.updatedAt,
    };
  }

  /** Remove the S3 configuration for the given user. */
  async deleteConfig(userId: string): Promise<void> {
    await this.storage.deleteS3Config(userId);
  }

  // ---- Proxy operations ----

  /**
   * Resolve the full credentials for a user (including decrypted secret key).
   * Throws 404 if S3 is not configured.
   */
  private async requireConfig(userId: string): Promise<{
    endpoint: string | undefined;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    prefix: string | undefined;
  }> {
    const record = await this.storage.getS3Config(userId);
    if (!record) {
      throw notFound('S3 is not configured for this account');
    }
    const secretAccessKey = decryptSecret(record.encryptedSecretAccessKey, userId, this.serverKey);
    return {
      endpoint: record.endpoint,
      region: record.region,
      bucket: record.bucket,
      accessKeyId: record.accessKeyId,
      secretAccessKey,
      prefix: record.prefix,
    };
  }

  /**
   * GET an object from S3 and return its content as a Buffer.
   */
  async proxyGet(
    userId: string,
    objectKey: string,
  ): Promise<{ content: Buffer; contentType: string }> {
    const creds = await this.requireConfig(userId);
    const url = buildS3ObjectUrl(
      creds.endpoint,
      creds.region,
      creds.bucket,
      objectKey,
      creds.prefix,
    );

    const signed = signS3Request({
      method: 'GET',
      url,
      region: creds.region,
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      payload: Buffer.alloc(0),
    });

    let res: Response;
    try {
      res = await guardedFetch(signed.url, { method: 'GET', headers: signed.headers });
    } catch (err) {
      throw badRequest(`S3 GET failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      if (res.status === 404) throw notFound(`S3: object not found: ${objectKey}`);
      throw badRequest(`S3 GET returned ${res.status}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    return { content: buf, contentType };
  }

  /**
   * PUT an object to S3.
   * Returns the response status code.
   */
  async proxyPut(
    userId: string,
    objectKey: string,
    body: Buffer,
    contentType: string,
  ): Promise<number> {
    const creds = await this.requireConfig(userId);
    const url = buildS3ObjectUrl(
      creds.endpoint,
      creds.region,
      creds.bucket,
      objectKey,
      creds.prefix,
    );

    const signed = signS3Request({
      method: 'PUT',
      url,
      region: creds.region,
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
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
      throw badRequest(`S3 PUT failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!res.ok) {
      throw badRequest(`S3 PUT returned ${res.status}`);
    }
    return res.status;
  }

  /**
   * DELETE an object from S3.
   */
  async proxyDelete(userId: string, objectKey: string): Promise<void> {
    const creds = await this.requireConfig(userId);
    const url = buildS3ObjectUrl(
      creds.endpoint,
      creds.region,
      creds.bucket,
      objectKey,
      creds.prefix,
    );

    const signed = signS3Request({
      method: 'DELETE',
      url,
      region: creds.region,
      accessKeyId: creds.accessKeyId,
      secretAccessKey: creds.secretAccessKey,
      payload: Buffer.alloc(0),
    });

    let res: Response;
    try {
      res = await guardedFetch(signed.url, { method: 'DELETE', headers: signed.headers });
    } catch (err) {
      throw badRequest(`S3 DELETE failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 204 = deleted, 404 = already gone - both acceptable.
    if (!res.ok && res.status !== 404) {
      throw badRequest(`S3 DELETE returned ${res.status}`);
    }
  }
}
