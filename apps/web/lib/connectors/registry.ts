/**
 * Connector registry — the single list of all available connectors.
 *
 * Import from here to get the full connector catalogue. The registry is
 * framework-free (no React, no vault access) — it is consumed by the UI
 * settings section and by tests.
 *
 * Adding a new connector: create the module, implement the interface, and add
 * a single line here. The Settings UI auto-renders from this list.
 */

import { rssOpmlConnector } from './rssOpml';
import type { Connector, LocalImportConnector } from './types';

/**
 * All registered connectors, in display order.
 *
 * Phase 1: local-only (no network, no credentials).
 * Phase 2 will add server-posture connectors for email/IMAP/webhooks.
 */
export const ALL_CONNECTORS: readonly Connector[] = [rssOpmlConnector] as const;

/**
 * Local-import connectors only — the subset that accept user-provided content
 * and run entirely on-device. These are safe to show without any server
 * configuration check.
 */
export const LOCAL_IMPORT_CONNECTORS: readonly LocalImportConnector[] = ALL_CONNECTORS.filter(
  (c): c is LocalImportConnector => c.privacyPosture === 'local',
);

/**
 * Find a connector by its stable id, or return undefined.
 */
export function getConnector(id: string): Connector | undefined {
  return ALL_CONNECTORS.find((c) => c.id === id);
}
