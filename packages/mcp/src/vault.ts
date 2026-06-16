/**
 * Vault loading + index caching.
 *
 * Responsibilities:
 *   1. Resolve the target vault id (explicit id, or by name via /v1/vaults).
 *   2. Load every non-deleted `.md` file (path + fetched UTF-8 content).
 *   3. Feed them to the engine's {@link buildIndex} to power search/graph.
 *   4. Cache the resulting index with a short TTL; rebuild when stale so
 *      agents see recent edits without a process restart.
 *
 * The raw markdown of each note is kept alongside the engine index so
 * `read_note` and content scans do not need a second round-trip.
 */

import { buildIndex, type GraphIndex, type NoteInput } from '@graphvault/engine';
import type { FilePath, FileState } from '@graphvault/shared';
import { GraphVaultApiError, type GraphVaultClient } from './client.js';
import type { McpConfig } from './config.js';

/** A loaded note: its vault-relative path and raw markdown content. */
export interface LoadedNote {
  path: FilePath;
  content: string;
  mtime: number;
}

/** A built, in-memory snapshot of the vault. */
export interface VaultSnapshot {
  index: GraphIndex;
  /** Raw markdown by path, for `read_note` and body scans. */
  contentByPath: Map<string, string>;
  /** Notes in load order. */
  notes: LoadedNote[];
  /** Epoch ms when this snapshot was built. */
  builtAt: number;
}

/** True for paths the engine should treat as markdown notes. */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/**
 * Reduce a flat list of file states (possibly multiple revisions per path)
 * to the latest state per path, dropping tombstones and non-markdown files.
 * `/changes?since=0` returns states in revision order, so a later entry for a
 * path supersedes an earlier one.
 */
export function latestMarkdownStates(states: readonly FileState[]): FileState[] {
  const byPath = new Map<string, FileState>();
  for (const state of states) {
    if (!isMarkdownPath(state.path)) continue;
    const prev = byPath.get(state.path);
    if (!prev || state.revision >= prev.revision) {
      byPath.set(state.path, state);
    }
  }
  const out: FileState[] = [];
  for (const state of byPath.values()) {
    if (state.deleted || state.hash === null) continue;
    out.push(state);
  }
  return out;
}

/**
 * Manages a single vault: resolves its id once, then loads and caches a
 * {@link VaultSnapshot} with a TTL.
 */
export class VaultManager {
  private resolvedVaultId: string | undefined;
  private snapshot: VaultSnapshot | undefined;
  private inflight: Promise<VaultSnapshot> | undefined;

  constructor(
    private readonly client: GraphVaultClient,
    private readonly config: McpConfig,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Resolve and cache the vault id. Uses the explicit id when provided,
   * otherwise looks it up by name via `GET /v1/vaults`.
   */
  async resolveVaultId(): Promise<string> {
    if (this.resolvedVaultId !== undefined) return this.resolvedVaultId;

    if (this.config.vaultId !== undefined) {
      this.resolvedVaultId = this.config.vaultId;
      return this.resolvedVaultId;
    }

    const wantedName = this.config.vaultName;
    // loadConfig guarantees at least one of id/name is present.
    const vaults = await this.client.listVaults();
    const match = vaults.find((v) => v.name === wantedName);
    if (!match) {
      const available = vaults.map((v) => v.name).join(', ') || '(none)';
      throw new GraphVaultApiError(
        `No vault named ${JSON.stringify(wantedName)} found. Available vaults: ${available}`,
        404,
      );
    }
    this.resolvedVaultId = match.id;
    return this.resolvedVaultId;
  }

  /** Return a fresh-enough snapshot, rebuilding it when the cache is stale. */
  async getSnapshot(): Promise<VaultSnapshot> {
    const current = this.snapshot;
    if (current && this.now() - current.builtAt < this.config.indexTtlMs) {
      return current;
    }
    // Coalesce concurrent rebuilds into a single in-flight request.
    if (this.inflight) return this.inflight;
    this.inflight = this.buildSnapshot()
      .then((snap) => {
        this.snapshot = snap;
        return snap;
      })
      .finally(() => {
        this.inflight = undefined;
      });
    return this.inflight;
  }

  /** Force-load notes and (re)build the engine index. */
  private async buildSnapshot(): Promise<VaultSnapshot> {
    const vaultId = await this.resolveVaultId();
    const states = await this.client.listAllFileStates(vaultId);
    const live = latestMarkdownStates(states);

    const notes: LoadedNote[] = [];
    const contentByPath = new Map<string, string>();
    // Fetch blob contents. hash is guaranteed non-null by latestMarkdownStates.
    for (const state of live) {
      const content = await this.client.getBlobText(state.hash as string);
      notes.push({ path: state.path, content, mtime: state.mtime });
      contentByPath.set(state.path, content);
    }

    const inputs: NoteInput[] = notes.map((n) => ({
      path: n.path,
      content: n.content,
      updatedAt: n.mtime,
    }));
    const index = buildIndex(inputs);

    return { index, contentByPath, notes, builtAt: this.now() };
  }
}
