/**
 * Connector framework — privacy-first, opt-in (Milestone 22).
 *
 * Every connector declares a PrivacyPosture so the UI can show a clear badge
 * before anything runs:
 *
 *   local  — all processing is on-device; no network involved at all.
 *   server — credential-bearing; the self-hosted GraphVault server proxies
 *            the external call so keys never touch the browser.
 *   byo    — bring-your-own-credential; the user supplies a token that is
 *            sent directly from the browser (phase 3, explicit consent).
 *
 * Phase 1 ships only `local` connectors (RSS/OPML import from user-provided
 * content). Phase 2 adds `server`-posture connectors (email, webhooks) where
 * all credential storage and outbound requests are handled by the server.
 */

/** How a connector's network / credential model works. */
export type PrivacyPosture = 'local' | 'server' | 'byo';

/**
 * Human-readable description of each posture — shown verbatim in the UI so
 * users understand the implications before enabling a connector.
 */
export const PRIVACY_POSTURE_LABELS: Record<PrivacyPosture, string> = {
  local: 'On-device — no network, no credentials',
  server: 'Via your server — credentials stay on your self-hosted server, never in the browser',
  byo: 'Bring your own credential — your token is sent directly from your browser',
};

/** Colour tokens for the privacy badge (Tailwind classes). */
export const PRIVACY_POSTURE_COLORS: Record<
  PrivacyPosture,
  { bg: string; text: string; border: string }
> = {
  local: {
    bg: 'bg-emerald-950',
    text: 'text-emerald-300',
    border: 'border-emerald-900/60',
  },
  server: {
    bg: 'bg-sky-950',
    text: 'text-sky-300',
    border: 'border-sky-900/60',
  },
  byo: {
    bg: 'bg-amber-950',
    text: 'text-amber-300',
    border: 'border-amber-900/60',
  },
};

/**
 * A single importable note produced by a connector, before it is handed to
 * `vault.importNotes()`. Mirrors the `ImportNote` shape from vault.ts so the
 * vault's collision-safe merge logic handles it unchanged.
 */
export interface ConnectorNote {
  /** Vault-relative POSIX path, e.g. `connectors/rss/My Feed/My Post.md`. */
  path: string;
  /** Markdown content (already converted from HTML/XML source). */
  content: string;
  /** Optional: original creation timestamp (epoch ms). */
  ctime?: number;
  /** Optional: original modification / publication timestamp (epoch ms). */
  mtime?: number;
}

/**
 * The Connector interface. Each connector is a pure, stateless object — it
 * does not call React, does not read the vault, and does not make network
 * requests in the `local` posture. The UI orchestrates everything.
 */
export interface Connector {
  /** Machine-readable stable identifier. */
  readonly id: string;
  /** Short human-readable name. */
  readonly name: string;
  /** One-sentence description of what the connector does. */
  readonly description: string;
  /** The privacy posture — shown as a badge before the connector runs. */
  readonly privacyPosture: PrivacyPosture;
  /**
   * Whether this connector is available in the current build / browser.
   * Return false to hide the connector rather than show it broken.
   */
  isAvailable(): boolean;
}

/**
 * A `local`-posture connector that accepts raw content (XML/Markdown/etc.)
 * provided directly by the user (paste or file upload) and converts it to
 * notes without any network calls.
 */
export interface LocalImportConnector extends Connector {
  readonly privacyPosture: 'local';
  /**
   * Parse the raw source text (feed XML, OPML, etc.) into connector notes.
   * Throws `ConnectorError` on unrecognised / malformed input.
   */
  parse(source: string): ConnectorNote[];
  /** File extensions accepted by this connector (used for the file picker). */
  readonly acceptedExtensions: readonly string[];
  /**
   * MIME types the connector can handle (used for drag-and-drop validation).
   * May be empty if the connector relies on the user pasting content.
   */
  readonly acceptedMimeTypes: readonly string[];
}

/** Thrown by connector parse / validate operations on bad input. */
export class ConnectorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorError';
  }
}
