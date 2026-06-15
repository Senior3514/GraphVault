import type { AuthToken, LoginRequest, RegisterRequest } from '@graphvault/shared';
import { badRequest, unauthorized } from '../errors.js';
import type { DeviceRecord, Storage, UserRecord } from '../store/types.js';
import { generateToken, hashPassword, hashToken, newId, verifyPassword } from './crypto.js';

/** How long an issued access token is valid, in seconds (30 days). */
export const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

const DEFAULT_DEVICE_NAME = 'Unnamed device';

export interface AuthContext {
  user: UserRecord;
  device: DeviceRecord;
}

export class AuthService {
  constructor(
    private readonly storage: Storage,
    private readonly ttlSeconds: number = TOKEN_TTL_SECONDS,
  ) {}

  async register(input: RegisterRequest): Promise<AuthToken> {
    const email = input.email.trim();
    const existing = await this.storage.getUserByEmail(email);
    if (existing) {
      // Don't reveal which emails exist beyond what registration inherently
      // leaks; a generic 400 is enough for a single-user/small-team server.
      throw badRequest('An account with this email already exists');
    }

    const passwordHash = await hashPassword(input.password);
    const user = await this.storage.createUser({ id: newId(), email, passwordHash });
    return this.issueTokenForNewDevice(user, input.deviceName);
  }

  async login(input: LoginRequest): Promise<AuthToken> {
    const user = await this.storage.getUserByEmail(input.email.trim());
    // Always run a verification step to keep timing roughly constant whether or
    // not the account exists.
    const storedHash = user?.passwordHash ?? DUMMY_HASH;
    const ok = await verifyPassword(storedHash, input.password);
    if (!user || !ok) {
      throw unauthorized('Invalid email or password');
    }
    return this.issueTokenForNewDevice(user, input.deviceName);
  }

  /**
   * Resolve a bearer token to its user+device, or throw 401. Also rejects
   * expired tokens and updates the device's `lastSeen`.
   */
  async authenticate(bearer: string | undefined): Promise<AuthContext> {
    const token = parseBearer(bearer);
    if (!token) throw unauthorized();

    const record = await this.storage.getToken(hashToken(token));
    if (!record) throw unauthorized('Invalid or expired token');
    if (record.expiresAt <= nowSeconds()) throw unauthorized('Token expired');

    const user = await this.storage.getUserById(record.userId);
    const device = await this.storage.getDevice(record.deviceId);
    if (!user || !device) throw unauthorized('Invalid or expired token');

    await this.storage.touchDevice(device.id);
    return { user, device };
  }

  private async issueTokenForNewDevice(
    user: UserRecord,
    deviceName: string | undefined,
  ): Promise<AuthToken> {
    const device = await this.storage.createDevice({
      id: newId(),
      userId: user.id,
      name: deviceName?.trim() || DEFAULT_DEVICE_NAME,
    });

    const accessToken = generateToken();
    const expiresAt = nowSeconds() + this.ttlSeconds;
    await this.storage.createToken({
      tokenHash: hashToken(accessToken),
      userId: user.id,
      deviceId: device.id,
      expiresAt,
      createdAt: new Date().toISOString(),
    });

    return { accessToken, expiresAt, userId: user.id, deviceId: device.id };
  }
}

function parseBearer(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * A constant Argon2id-shaped hash used for timing-equalisation on logins for
 * non-existent accounts. It is never expected to match any real password.
 */
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
