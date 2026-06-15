import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

/**
 * Password hashing and token helpers.
 *
 * Passwords are hashed with Argon2id when the native `argon2` addon loads;
 * otherwise we fall back to scrypt from `node:crypto` so the server still runs
 * in environments where the native build is unavailable. The stored hash string
 * is self-describing (Argon2's PHC string, or our `scrypt$...` format), so the
 * verifier can always pick the right algorithm.
 */

const scrypt = promisify(scryptCb);

type Argon2Module = {
  hash(password: string, options?: { type?: number }): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
  argon2id: number;
};

let argon2Promise: Promise<Argon2Module | null> | undefined;

async function loadArgon2(): Promise<Argon2Module | null> {
  if (!argon2Promise) {
    argon2Promise = import('argon2')
      .then((mod) => {
        const m = (mod as { default?: Argon2Module } & Argon2Module).default ?? mod;
        return m as unknown as Argon2Module;
      })
      .catch(() => null);
  }
  return argon2Promise;
}

const SCRYPT_KEYLEN = 64;
const SCRYPT_PREFIX = 'scrypt$';

async function scryptHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  const derived = (await scrypt(password, salt, SCRYPT_KEYLEN)) as Buffer;
  return `${SCRYPT_PREFIX}${salt.toString('hex')}$${derived.toString('hex')}`;
}

async function scryptVerify(stored: string, password: string): Promise<boolean> {
  const [, saltHex, hashHex] = stored.split('$');
  if (!saltHex || !hashHex) return false;
  const salt = Buffer.from(saltHex, 'hex');
  const expected = Buffer.from(hashHex, 'hex');
  const derived = (await scrypt(password, salt, expected.length)) as Buffer;
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

/** Hash a plaintext password for storage. Prefers Argon2id. */
export async function hashPassword(password: string): Promise<string> {
  const argon2 = await loadArgon2();
  if (argon2) {
    return argon2.hash(password, { type: argon2.argon2id });
  }
  return scryptHash(password);
}

/** Verify a plaintext password against a stored hash (any supported scheme). */
export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  if (stored.startsWith(SCRYPT_PREFIX)) {
    return scryptVerify(stored, password);
  }
  const argon2 = await loadArgon2();
  if (argon2 && stored.startsWith('$argon2')) {
    try {
      return await argon2.verify(stored, password);
    } catch {
      return false;
    }
  }
  return false;
}

/** Generate a new opaque bearer token (URL-safe, high entropy). */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Hash a bearer token for storage. We only persist the hash so a database leak
 * does not expose usable tokens. SHA-256 is sufficient here because the token
 * itself is already 256 bits of uniform randomness (no need for a slow KDF).
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function newId(): string {
  return randomUUID();
}
