/**
 * Azure Blob Storage proxy service (Wave 16).
 *
 * Security model (a faithful sibling of {@link ./s3.ts S3Service}):
 *   - Azure credentials (account + container + accountKey, plus optional
 *     endpoint override for Azurite) are stored server-side, encrypted at rest
 *     with AES-256-GCM. The key is derived via HKDF from the server's
 *     GRAPHVAULT_ENCRYPTION_KEY and the user's ID, using a credential-type
 *     specific info string `graphvault-azure-cred-v1` so Azure sub-keys are
 *     independent of WebDAV/S3/GCS sub-keys for the same user.
 *   - If no server encryption key is configured, a process-lifetime random key
 *     is used (credentials are lost on restart — same trade-off as S3/WebDAV).
 *   - Credentials are NEVER returned to the client. The client receives only the
 *     non-secret AzureConfigInfo (account + container + endpoint + updatedAt).
 *   - All outbound Azure requests are authenticated with the Shared Key scheme,
 *     a SHA-256 HMAC keyed on the base64-decoded account key, implemented in pure
 *     Node `node:crypto` — zero new dependencies.
 *   - The browser never contacts Azure directly (avoids CORS, keeps creds off
 *     the client).
 *
 * Proxy scope (single-object vault blob):
 *   - GET    /v1/storage/azure/object/graphvault-vault.json — download
 *   - PUT    /v1/storage/azure/object/graphvault-vault.json — upload
 *   - DELETE /v1/storage/azure/object/graphvault-vault.json — delete
 *
 * Shared Key signing:
 *   Authorization: SharedKey <account>:<base64(HMAC-SHA256(StringToSign))>
 *   where StringToSign concatenates the verb, a fixed set of standard headers,
 *   the canonicalized `x-ms-*` headers (lowercased, sorted), and the
 *   canonicalized resource (`/account/container/blob` + sorted query). The HMAC
 *   key is the base64-decoded account key. See the Azure Storage REST spec:
 *   "Authorize with Shared Key".
 */

import { createHmac, hkdfSync, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { badRequest, notFound } from '../errors.js';
import type { AzureConfigRecord, Storage } from '../store/types.js';

// ---------------------------------------------------------------------------
// Public config shapes (defined here — shared package is not modifiable in this
// wave; mirrors the S3ConfigRequest / S3ConfigInfo split exactly).
// ---------------------------------------------------------------------------

export interface AzureConfigRequest {
  /** Storage account name, e.g. "mygraphvault". */
  account: string;
  /** Blob container name. */
  container: string;
  /** Account key (base64). The secret — encrypted at rest, never returned. */
  accountKey: string;
  /**
   * Optional endpoint override (no trailing slash), e.g.
   * `http://127.0.0.1:10000/devstoreaccount1` for Azurite. When omitted the
   * service uses `https://<account>.blob.core.windows.net`.
   */
  endpoint?: string;
}

export interface AzureConfigInfo {
  account: string;
  container: string;
  endpoint?: string;
  /** ISO-8601 timestamp when the config was last saved. */
  updatedAt: string;
}

/** The Azure REST API version targeted by all signed requests. */
export const AZURE_API_VERSION = '2021-08-06';

// ---------------------------------------------------------------------------
// Encryption helpers (identical pattern to s3.ts / webdav.ts; unique HKDF info)
// ---------------------------------------------------------------------------

const AES_ALGORITHM = 'aes-256-gcm' as const;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

const PROCESS_FALLBACK_KEY = randomBytes(32);

function deriveUserKey(userId: string, serverKey?: Buffer): Buffer {
  const ikm = serverKey ?? PROCESS_FALLBACK_KEY;
  const salt = Buffer.from(userId, 'utf8');
  // Unique per credential type (see lessons.md: HKDF info must be unique).
  const info = Buffer.from('graphvault-azure-cred-v1', 'utf8');
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
    throw new Error('Malformed Azure credential ciphertext');
  }
  const nonce = buf.subarray(0, NONCE_BYTES);
  const tag = buf.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const ct = buf.subarray(NONCE_BYTES + TAG_BYTES);
  const decipher = createDecipheriv(AES_ALGORITHM, key, nonce);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('Failed to decrypt Azure credentials (wrong key or corrupted data)');
  }
}

// ---------------------------------------------------------------------------
// Azure Shared Key signing (pure node:crypto — no @azure/* deps)
// ---------------------------------------------------------------------------

/** Format a Date as an RFC-1123 string for x-ms-date, e.g. "Mon, 15 Jun 2026 12:00:00 GMT". */
export function azureDate(d: Date): string {
  return d.toUTCString();
}

export interface AzureSignParams {
  method: string;
  /** Full blob URL (scheme + host + path[ + query]). */
  url: string;
  /** Storage account name (used in the SharedKey credential + canonical resource). */
  account: string;
  /** Account key, base64-encoded. Decoded to raw bytes to key the HMAC. */
  accountKey: string;
  /** Raw payload bytes (empty for GET/DELETE). Determines Content-Length. */
  payload: Buffer;
  /** x-ms-* headers to sign (e.g. x-ms-blob-type on PUT). Keys lowercased. */
  msHeaders?: Record<string, string>;
  /** Content-Type header value for the request (empty string if none). */
  contentType?: string;
}

export interface AzureSignedRequest {
  url: string;
  headers: Record<string, string>;
  /** The exact StringToSign — exposed for deterministic tests. */
  stringToSign: string;
}

/**
 * Build the canonicalized resource string:
 *   `/account/container/blob` followed by each query param as
 *   `\n<lowercased-name>:<comma-joined-sorted-values>`, the params sorted by name.
 */
function canonicalizedResource(account: string, url: URL): string {
  let resource = `/${account}${url.pathname}`;
  const params = [...url.searchParams.keys()]
    .map((k) => k.toLowerCase())
    .filter((k, i, arr) => arr.indexOf(k) === i)
    .sort();
  for (const name of params) {
    const values = url.searchParams.getAll(name).sort();
    resource += `\n${name}:${values.join(',')}`;
  }
  return resource;
}

/**
 * Build the canonicalized headers string: every `x-ms-*` header, lowercased,
 * sorted by name, rendered as `name:value\n` (values whitespace-trimmed).
 */
function canonicalizedHeaders(msHeaders: Record<string, string>): string {
  const entries = Object.entries(msHeaders)
    .map(([k, v]) => [k.toLowerCase(), v.replace(/\r?\n/g, ' ').trim()] as const)
    .filter(([k]) => k.startsWith('x-ms-'))
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return entries.map(([k, v]) => `${k}:${v}\n`).join('');
}

/**
 * Produce a signed Azure Blob request (URL + headers). The `host` header is part
 * of the URL (not the StringToSign for Shared Key) and is NOT placed in the
 * returned headers — `fetch` sets it automatically from the URL.
 */
export function signAzureRequest(
  params: AzureSignParams,
  now: Date = new Date(),
): AzureSignedRequest {
  const { method, url, account, accountKey, payload, msHeaders = {}, contentType = '' } = params;
  const parsedUrl = new URL(url);
  const verb = method.toUpperCase();

  const xMsDate = azureDate(now);
  const msHeadersAll: Record<string, string> = {
    'x-ms-date': xMsDate,
    'x-ms-version': AZURE_API_VERSION,
  };
  for (const [k, v] of Object.entries(msHeaders)) {
    msHeadersAll[k.toLowerCase()] = v;
  }

  const contentLength = payload.length === 0 ? '' : String(payload.length);

  // The StringToSign for Shared Key (blob/queue). Order and emptiness matter:
  // the standard headers must appear with the exact values sent (empty string
  // when not sent), each terminated by a newline, in this fixed order.
  const stringToSign = [
    verb,
    '', // Content-Encoding
    '', // Content-Language
    contentLength, // Content-Length ('' when zero/absent)
    '', // Content-MD5
    contentType, // Content-Type
    '', // Date (we use x-ms-date instead)
    '', // If-Modified-Since
    '', // If-Match
    '', // If-None-Match
    '', // If-Unmodified-Since
    '', // Range
    canonicalizedHeaders(msHeadersAll) + canonicalizedResource(account, parsedUrl),
  ].join('\n');

  const key = Buffer.from(accountKey, 'base64');
  const signature = createHmac('sha256', key).update(stringToSign, 'utf8').digest('base64');
  const authorization = `SharedKey ${account}:${signature}`;

  const headers: Record<string, string> = {
    ...msHeadersAll,
    authorization,
  };
  if (contentType) headers['content-type'] = contentType;
  if (contentLength) headers['content-length'] = contentLength;

  return { url, headers, stringToSign };
}

// ---------------------------------------------------------------------------
// URL helper
// ---------------------------------------------------------------------------

/**
 * Build the blob URL for a given object key.
 *   default: https://<account>.blob.core.windows.net/<container>/<key>
 *   override: <endpoint>/<container>/<key>  (endpoint already includes the
 *             account path segment for Azurite, e.g. .../devstoreaccount1)
 */
export function buildAzureBlobUrl(
  account: string,
  container: string,
  objectKey: string,
  endpoint?: string,
): string {
  const base = endpoint ? endpoint.replace(/\/+$/, '') : `https://${account}.blob.core.windows.net`;
  return `${base}/${container}/${objectKey}`;
}

// ---------------------------------------------------------------------------
// AzureService
// ---------------------------------------------------------------------------

export class AzureService {
  constructor(
    private readonly storage: Storage,
    private readonly serverKey?: Buffer,
  ) {}

  // ---- Config management ----

  /** Store or update the Azure configuration for the given user. */
  async saveConfig(userId: string, input: AzureConfigRequest): Promise<void> {
    const encryptedAccountKey = encryptSecret(input.accountKey, userId, this.serverKey);
    const record: AzureConfigRecord = {
      userId,
      account: input.account,
      container: input.container,
      encryptedAccountKey,
      endpoint: input.endpoint,
      updatedAt: new Date().toISOString(),
    };
    await this.storage.upsertAzureConfig(record);
  }

  /** Return the non-secret config info for the user, or null if not configured. */
  async getConfigInfo(userId: string): Promise<AzureConfigInfo | null> {
    const record = await this.storage.getAzureConfig(userId);
    if (!record) return null;
    return {
      account: record.account,
      container: record.container,
      endpoint: record.endpoint,
      updatedAt: record.updatedAt,
    };
  }

  /** Remove the Azure configuration for the given user. */
  async deleteConfig(userId: string): Promise<void> {
    await this.storage.deleteAzureConfig(userId);
  }

  // ---- Proxy operations ----

  private async requireConfig(userId: string): Promise<{
    account: string;
    container: string;
    accountKey: string;
    endpoint: string | undefined;
  }> {
    const record = await this.storage.getAzureConfig(userId);
    if (!record) {
      throw notFound('Azure Blob Storage is not configured for this account');
    }
    const accountKey = decryptSecret(record.encryptedAccountKey, userId, this.serverKey);
    return {
      account: record.account,
      container: record.container,
      accountKey,
      endpoint: record.endpoint,
    };
  }

  /** GET the vault blob and return its content. */
  async proxyGet(
    userId: string,
    objectKey: string,
  ): Promise<{ content: Buffer; contentType: string }> {
    const creds = await this.requireConfig(userId);
    const url = buildAzureBlobUrl(creds.account, creds.container, objectKey, creds.endpoint);
    const signed = signAzureRequest({
      method: 'GET',
      url,
      account: creds.account,
      accountKey: creds.accountKey,
      payload: Buffer.alloc(0),
    });

    let res: Response;
    try {
      res = await fetch(signed.url, { method: 'GET', headers: signed.headers });
    } catch (err) {
      throw badRequest(`Azure GET failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      if (res.status === 404) throw notFound(`Azure: blob not found: ${objectKey}`);
      throw badRequest(`Azure GET returned ${res.status}`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
    return { content: buf, contentType };
  }

  /** PUT the vault blob. Returns the upstream status code. */
  async proxyPut(
    userId: string,
    objectKey: string,
    body: Buffer,
    contentType: string,
  ): Promise<number> {
    const creds = await this.requireConfig(userId);
    const url = buildAzureBlobUrl(creds.account, creds.container, objectKey, creds.endpoint);
    const signed = signAzureRequest({
      method: 'PUT',
      url,
      account: creds.account,
      accountKey: creds.accountKey,
      payload: body,
      contentType,
      msHeaders: { 'x-ms-blob-type': 'BlockBlob' },
    });

    let res: Response;
    try {
      res = await fetch(signed.url, { method: 'PUT', headers: signed.headers, body });
    } catch (err) {
      throw badRequest(`Azure PUT failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      throw badRequest(`Azure PUT returned ${res.status}`);
    }
    return res.status;
  }

  /** DELETE the vault blob. */
  async proxyDelete(userId: string, objectKey: string): Promise<void> {
    const creds = await this.requireConfig(userId);
    const url = buildAzureBlobUrl(creds.account, creds.container, objectKey, creds.endpoint);
    const signed = signAzureRequest({
      method: 'DELETE',
      url,
      account: creds.account,
      accountKey: creds.accountKey,
      payload: Buffer.alloc(0),
    });

    let res: Response;
    try {
      res = await fetch(signed.url, { method: 'DELETE', headers: signed.headers });
    } catch (err) {
      throw badRequest(`Azure DELETE failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    // 202 = accepted, 404 = already gone — both acceptable.
    if (!res.ok && res.status !== 404) {
      throw badRequest(`Azure DELETE returned ${res.status}`);
    }
  }
}
