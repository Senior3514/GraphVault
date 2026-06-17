import { createHash } from 'node:crypto';
import { formatContentHash } from '@graphvault/shared';
import { AppError, badRequest, conflict, notFound } from '../errors.js';
import type { Storage } from '../store/types.js';
import type { BlobService } from './blob.js';
import { generateToken, hashToken, newId } from './crypto.js';
import type { SyncService } from './sync.js';
import type { VaultService } from './vault.js';

/**
 * "Connect anything" inbound webhook (M22, Wave 19).
 *
 * A user mints a per-connector *inbox token* bound to one of their vaults. An
 * external service (Zapier, an email forwarder, an IFTTT recipe, a curl in a
 * cron job, …) then POSTs Markdown to `/v1/inbox/:token`, and the content lands
 * as a brand-new note in that vault. Every inbound attempt — accepted or
 * rejected — is recorded in a per-user audit log so the owner can see exactly
 * what each connector did.
 *
 * Data-safety first (the CLAUDE.md "never silently lose user data" rule):
 *  - the note path is chosen to be GUARANTEED NEW (`Inbox/<source>-<short-id>.md`),
 *    verified absent via the sync/storage layer before writing, so an inbound
 *    post can NEVER clobber an existing note;
 *  - we reuse the existing, tested blob + sync services verbatim (content hash is
 *    the sha256 of the PLAINTEXT bytes, matching the rest of the protocol);
 *  - if the (should-never-happen) push still conflicts, we do NOT retry blindly:
 *    we return 409 and record a `rejected` audit entry.
 *
 * The token is the credential: it is stored ONLY as a SHA-256 hash (like bearer
 * tokens), the raw token is shown exactly once at creation, and an unknown token
 * yields 404 (we never leak which tokens exist). The inbound route is size-capped
 * and carries a stricter per-window rate limit (wired in the route).
 */

/** A minted inbox token. Only the HASH is stored; the raw token is shown once. */
export interface InboxTokenRecord {
  id: string;
  userId: string;
  vaultId: string;
  label: string;
  /** SHA-256 hex of the raw token (never the raw token itself). */
  tokenHash: string;
  createdAt: string; // ISO-8601
  lastUsedAt: string | null;
}

/** Public view of a token (NEVER includes the token or its hash). */
export interface InboxTokenView {
  id: string;
  vaultId: string;
  label: string;
  createdAt: string;
  lastUsedAt: string | null;
}

/** A single audit-log entry for one inbound attempt. */
export interface InboxAuditEntry {
  id: string;
  userId: string;
  tokenId: string;
  source: string;
  /** The note path that was created (or attempted), or null for early rejects. */
  path: string | null;
  bytes: number;
  status: 'accepted' | 'rejected';
  at: string; // ISO-8601
}

/** Validated inbound payload. */
export interface InboxSubmission {
  title?: string;
  markdown: string;
  tags?: string[];
  source?: string;
}

export interface InboxServiceOptions {
  /** Max size in bytes of an inbound note's rendered Markdown (413 over). */
  maxBytes: number;
  /** Cap on retained audit-log entries per user (oldest evicted). */
  maxAuditEntries: number;
}

/** Default per-user audit-log cap. */
export const DEFAULT_INBOX_AUDIT_CAP = 500;

/**
 * How many times to regenerate a fresh path when the random short id collides
 * with an existing note. Collisions are astronomically unlikely (16 random
 * bytes), so this only guards against the impossible.
 */
const MAX_PATH_ATTEMPTS = 5;

export class InboxService {
  private readonly maxBytes: number;
  private readonly maxAuditEntries: number;

  /** tokenHash -> record. The hash is the lookup key for inbound requests. */
  private readonly tokensByHash = new Map<string, InboxTokenRecord>();
  /** userId -> capped, newest-last list of audit entries. */
  private readonly auditByUser = new Map<string, InboxAuditEntry[]>();

  constructor(
    private readonly storage: Storage,
    private readonly vault: VaultService,
    private readonly sync: SyncService,
    private readonly blob: BlobService,
    options: InboxServiceOptions,
  ) {
    this.maxBytes = options.maxBytes;
    this.maxAuditEntries = options.maxAuditEntries;
  }

  // --- token management (authenticated) -----------------------------------

  /**
   * Mint a new inbox token bound to (userId, vaultId, label). Verifies the user
   * owns the vault, stores ONLY the token's hash, and returns the raw token once.
   */
  async createToken(
    userId: string,
    vaultId: string,
    label: string,
  ): Promise<{ id: string; token: string; label: string }> {
    const trimmed = label.trim();
    if (trimmed.length === 0) throw badRequest('A non-empty label is required');
    // Ownership: throws 404 (unknown) / 403 (not owner) — never mints a token
    // for a vault the caller doesn't own.
    await this.vault.requireOwned(userId, vaultId);

    const token = generateToken();
    const record: InboxTokenRecord = {
      id: newId(),
      userId,
      vaultId,
      label: trimmed,
      tokenHash: hashToken(token),
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
    };
    this.tokensByHash.set(record.tokenHash, record);
    return { id: record.id, token, label: record.label };
  }

  /** List a user's tokens. NEVER includes the token or its hash. */
  listTokens(userId: string): InboxTokenView[] {
    return [...this.tokensByHash.values()]
      .filter((t) => t.userId === userId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(toView);
  }

  /** Revoke a token the user owns. 404 if it doesn't exist or isn't theirs. */
  revokeToken(userId: string, tokenId: string): void {
    for (const [hash, record] of this.tokensByHash) {
      if (record.id === tokenId && record.userId === userId) {
        this.tokensByHash.delete(hash);
        return;
      }
    }
    throw notFound('Inbox token not found');
  }

  // --- public inbound -----------------------------------------------------

  /**
   * Accept an inbound submission against a raw token. Resolves the token by its
   * hash; an unknown token yields 404 (we never reveal which tokens exist).
   * Renders the note, writes it under a guaranteed-new path, and records an
   * audit entry. Returns the created vault-relative path.
   */
  async submit(rawToken: string, input: InboxSubmission): Promise<{ path: string }> {
    const record = this.tokensByHash.get(hashToken(rawToken));
    // Unknown token: do NOT leak existence. No audit entry — we have no user to
    // attribute it to, and recording would let an attacker spam someone's log.
    if (!record) throw notFound('Inbox token not found');

    const source = sanitizeSource(input.source);
    const content = renderNote(input, source);
    const bytes = Buffer.from(content, 'utf8');

    // Size cap on the RENDERED note (413). The route also caps the raw body, but
    // frontmatter can add a little; this is the authoritative backstop.
    if (bytes.byteLength > this.maxBytes) {
      this.appendAudit(record, source, null, bytes.byteLength, 'rejected');
      throw new AppError(413, 'PAYLOAD_TOO_LARGE', `Note exceeds the ${this.maxBytes}-byte limit`);
    }

    const path = await this.chooseFreshPath(record.vaultId, source);

    const hash = formatContentHash(createHash('sha256').update(bytes).digest('hex'));
    await this.blob.put(hash, bytes);

    // baseRevision 0 == "I believe this path is brand new"; the sync service
    // fast-forward-accepts a create at base 0 when the path is genuinely absent.
    const result = await this.sync.push(record.vaultId, [
      {
        path,
        hash,
        size: bytes.byteLength,
        mtime: Date.now(),
        deleted: false,
        baseRevision: 0,
      },
    ]);

    if (result.conflicts.length > 0 || !result.applied.includes(path)) {
      // Should be impossible (we verified the path is absent), but never retry
      // blindly onto an existing note — surface it and record the rejection.
      this.appendAudit(record, source, path, bytes.byteLength, 'rejected');
      throw conflict('Inbound note could not be created without overwriting existing content');
    }

    record.lastUsedAt = new Date().toISOString();
    this.appendAudit(record, source, path, bytes.byteLength, 'accepted');
    return { path };
  }

  // --- audit log (authenticated) ------------------------------------------

  /** A user's recent audit entries, newest first. */
  listAudit(userId: string): InboxAuditEntry[] {
    const entries = this.auditByUser.get(userId);
    if (!entries) return [];
    return [...entries].reverse();
  }

  // --- internals ----------------------------------------------------------

  /**
   * Pick a vault-relative path under `Inbox/` that is GUARANTEED ABSENT, so an
   * inbound write can never clobber an existing note. The id is fresh random
   * entropy; we still verify absence (and a live tombstone counts as "present"
   * only if it carries content — a deleted path is free to reuse) and regenerate
   * on the impossible collision.
   */
  private async chooseFreshPath(vaultId: string, source: string): Promise<string> {
    for (let attempt = 0; attempt < MAX_PATH_ATTEMPTS; attempt++) {
      const shortId = newId().replace(/-/g, '').slice(0, 12);
      const path = `Inbox/${source}-${shortId}.md`;
      const existing = await this.storage.getFile(vaultId, path);
      // Absent, or a tombstone (deleted) we may freely reuse: safe to write.
      if (!existing || existing.state.deleted) return path;
    }
    // Exhausting 5 fresh random ids is effectively impossible; fail loudly
    // rather than risk overwriting anything.
    throw new AppError(500, 'INTERNAL', 'Could not allocate a unique inbox note path');
  }

  private appendAudit(
    token: InboxTokenRecord,
    source: string,
    path: string | null,
    bytes: number,
    status: InboxAuditEntry['status'],
  ): void {
    const entry: InboxAuditEntry = {
      id: newId(),
      userId: token.userId,
      tokenId: token.id,
      source,
      path,
      bytes,
      status,
      at: new Date().toISOString(),
    };
    let list = this.auditByUser.get(token.userId);
    if (!list) {
      list = [];
      this.auditByUser.set(token.userId, list);
    }
    list.push(entry);
    // Cap retention per user, evicting oldest-first (bounded memory).
    if (list.length > this.maxAuditEntries) {
      list.splice(0, list.length - this.maxAuditEntries);
    }
  }
}

function toView(record: InboxTokenRecord): InboxTokenView {
  return {
    id: record.id,
    vaultId: record.vaultId,
    label: record.label,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
  };
}

/**
 * Sanitize the caller-supplied `source` into a safe filename fragment:
 * `[A-Za-z0-9_-]` only, collapsed, length-bounded, never empty. This is the only
 * caller-controlled part of the path, so it must not enable traversal or odd
 * filenames. Anything unusable falls back to `webhook`.
 */
export function sanitizeSource(source: string | undefined): string {
  if (typeof source !== 'string') return 'webhook';
  const cleaned = source
    .normalize('NFKD')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 40);
  return cleaned.length > 0 ? cleaned : 'webhook';
}

/**
 * Render the submission to a Markdown note. When any of title/tags/source are
 * present we emit a small YAML frontmatter block (and always a `date`), then the
 * body. Frontmatter strings are quoted/escaped so a hostile title can't break
 * out of YAML.
 */
function renderNote(input: InboxSubmission, source: string): string {
  const lines: string[] = [];
  const fm: string[] = [];
  const title = input.title?.trim();
  if (title) fm.push(`title: ${yamlString(title)}`);
  const tags = (input.tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
  if (tags.length > 0) fm.push(`tags: [${tags.map(yamlString).join(', ')}]`);
  fm.push(`source: ${yamlString(source)}`);
  fm.push(`date: ${new Date().toISOString()}`);

  lines.push('---');
  lines.push(...fm);
  lines.push('---');
  lines.push('');
  if (title) {
    lines.push(`# ${title}`);
    lines.push('');
  }
  lines.push(input.markdown.replace(/\r\n/g, '\n').trimEnd());
  lines.push('');
  return lines.join('\n');
}

/** Quote a string for safe single-line YAML (double-quoted, escaped). */
function yamlString(value: string): string {
  return JSON.stringify(value);
}
