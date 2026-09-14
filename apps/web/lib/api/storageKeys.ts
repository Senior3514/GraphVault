/**
 * Canonical browser-storage keys for auth + server settings.
 *
 * These are the SINGLE source of truth shared by the React hooks that WRITE the
 * values (`useAuth`, `useServerSettings`) and the non-React modules that READ
 * them (storage adapters, share-link helpers, the graph short-link path).
 *
 * Historically the proxy adapters read mismatched keys (`gv:auth:token` /
 * `gv:serverUrl`) that nothing ever wrote, so every cloud adapter's
 * `isAvailable()` was always false. Centralising the keys here prevents that
 * class of drift.
 *
 * Tiers (must match the writers):
 *  - Bearer token  → sessionStorage (cleared on tab close).
 *  - Server URL    → localStorage   (survives reloads).
 */

/** sessionStorage key where the bearer token is stored by `useAuth`. */
export const AUTH_TOKEN_STORAGE_KEY = 'graphvault:auth-token:v1';

/** localStorage key where the server URL is stored by `useServerSettings`. */
export const SERVER_URL_STORAGE_KEY = 'graphvault:server-url';
