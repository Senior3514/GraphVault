'use client';

/**
 * Auth state hook for the GraphVault web client.
 *
 * ## Token storage strategy and trade-offs
 *
 * The access token is split across two storage tiers:
 *
 *   sessionStorage  — holds the raw `accessToken` string.
 *     Pro: cleared when the tab closes; not accessible to other tabs; not sent
 *          to the server automatically (unlike cookies).
 *     Con: lost on page reload in some browsers; the user must re-enter
 *          credentials on a new session.
 *     Why: a tab close is a natural session boundary. Storing the raw token
 *          only for the duration of a tab reduces the window for exfiltration
 *          if localStorage is later compromised.
 *
 *   localStorage    — holds only { userId, deviceId, expiresAt } (non-secret).
 *     Pro: survives reloads; lets the UI show "previously signed in" and
 *          prompt for credentials again.
 *     Con: readable by any same-origin JS (acceptable — non-secret metadata).
 *
 * Security notes:
 *   - The raw token is NEVER logged, never embedded in a URL, never placed in
 *     a cookie.
 *   - On logout, the token is cleared from both tiers immediately.
 *   - Token expiry is checked client-side; the server always re-validates.
 *
 * ## CSP / same-origin note
 *
 * The Content-Security-Policy's connect-src directive must allow the configured
 * server origin. In production: run the sync server on the same origin as the
 * web client and keep connect-src 'self'. For development (e.g. 127.0.0.1:4000)
 * the CSP in layout.tsx is relaxed — see the comment there for the trade-off.
 * The user configures the server URL in Settings; it is stored in localStorage
 * and read by useServerSettings.
 */

import { useCallback, useEffect, useState } from 'react';

import { authTokenSchema, type AuthToken } from '@graphvault/shared';
import { GraphVaultClient } from './client';

/** The non-secret subset of AuthToken persisted across sessions. */
interface StoredAuthMeta {
  userId: string;
  deviceId: string;
  expiresAt: number;
}

const META_KEY = 'graphvault:auth-meta:v1';
const TOKEN_KEY = 'graphvault:auth-token:v1';

function loadMeta(): StoredAuthMeta | null {
  try {
    const raw = window.localStorage.getItem(META_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAuthMeta>;
    if (!parsed.userId || !parsed.deviceId || !parsed.expiresAt) return null;
    // Discard expired metadata on the client side.
    if (parsed.expiresAt <= Math.floor(Date.now() / 1000)) {
      window.localStorage.removeItem(META_KEY);
      return null;
    }
    return parsed as StoredAuthMeta;
  } catch {
    return null;
  }
}

function saveMeta(m: StoredAuthMeta): void {
  try {
    window.localStorage.setItem(META_KEY, JSON.stringify(m));
  } catch {
    /* quota/unavailable */
  }
}

function clearMeta(): void {
  try {
    window.localStorage.removeItem(META_KEY);
  } catch {
    /* ignore */
  }
}

/** Read the raw access token from sessionStorage (never logs the value). */
function loadToken(): string | null {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Write the raw access token to sessionStorage only (never logs the value). */
function saveToken(tok: string): void {
  try {
    window.sessionStorage.setItem(TOKEN_KEY, tok);
  } catch {
    /* quota/unavailable */
  }
}

function clearToken(): void {
  try {
    window.sessionStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export interface AuthCredentials {
  email: string;
  password: string;
  deviceName?: string;
  serverUrl: string;
}

export interface AuthState {
  /** True once the initial localStorage check has completed (safe to render auth-dependent UI). */
  loaded: boolean;
  /** True if there is a valid, non-expired stored auth session with a token in this tab. */
  isSignedIn: boolean;
  userId: string | null;
  deviceId: string | null;
  /** The raw access token from sessionStorage; null if the tab is fresh or the user signed out. */
  token: string | null;
  /** Register a new account and sign in. */
  register(creds: AuthCredentials): Promise<AuthToken>;
  /** Sign in to an existing account. */
  login(creds: AuthCredentials): Promise<AuthToken>;
  /** Clear all stored auth state from both storage tiers. */
  logout(): void;
}

export function useAuth(): AuthState {
  const [loaded, setLoaded] = useState(false);
  const [meta, setMeta] = useState<StoredAuthMeta | null>(null);
  const [token, setToken] = useState<string | null>(null);

  // Hydrate from storage on mount — runs client-side only.
  useEffect(() => {
    const m = loadMeta();
    const t = loadToken();
    setMeta(m);
    setToken(t);
    setLoaded(true);
  }, []);

  const applyToken = useCallback((authToken: AuthToken): AuthToken => {
    const m: StoredAuthMeta = {
      userId: authToken.userId,
      deviceId: authToken.deviceId,
      expiresAt: authToken.expiresAt,
    };
    saveMeta(m);
    // Raw token goes to sessionStorage only.
    saveToken(authToken.accessToken);
    setMeta(m);
    setToken(authToken.accessToken);
    return authToken;
  }, []);

  const register = useCallback(
    async (creds: AuthCredentials): Promise<AuthToken> => {
      const client = new GraphVaultClient(creds.serverUrl);
      const raw = await client.register({
        email: creds.email,
        password: creds.password,
        deviceName: creds.deviceName,
      });
      return applyToken(authTokenSchema.parse(raw));
    },
    [applyToken],
  );

  const login = useCallback(
    async (creds: AuthCredentials): Promise<AuthToken> => {
      const client = new GraphVaultClient(creds.serverUrl);
      const raw = await client.login({
        email: creds.email,
        password: creds.password,
        deviceName: creds.deviceName,
      });
      return applyToken(authTokenSchema.parse(raw));
    },
    [applyToken],
  );

  const logout = useCallback(() => {
    clearMeta();
    clearToken();
    setMeta(null);
    setToken(null);
  }, []);

  // A session is considered signed-in only when both the metadata AND the token
  // are present (token lives in sessionStorage and is cleared on tab close).
  const isSignedIn = Boolean(meta && token);

  return {
    loaded,
    isSignedIn,
    userId: meta?.userId ?? null,
    deviceId: meta?.deviceId ?? null,
    token,
    register,
    login,
    logout,
  };
}
