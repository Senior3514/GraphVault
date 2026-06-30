/**
 * GraphVault Service Worker
 *
 * Strategy:
 *   - Navigations / HTML  -> NETWORK-FIRST (fall back to cache only when offline).
 *     This guarantees a returning user always gets the current `index.html`,
 *     which references the current hashed JS/CSS chunks. A cache-first shell is
 *     dangerous: after a new deploy the old cached HTML points at hashed chunks
 *     that no longer exist on the server, so they 404 and the app throws a
 *     client-side exception. Network-first avoids that entirely.
 *   - Content-hashed static assets (`/_next/static/...`) -> CACHE-FIRST. These
 *     URLs change whenever their content changes, so a cached copy is never
 *     stale and is safe (and fast) to serve offline.
 *   - Everything else same-origin -> network-first with a cache fallback.
 *
 * Cache versioning: bump CACHE_VERSION on any SW behavior change. The activate
 * handler deletes every cache that is not the current version, so bumping also
 * evicts a previously poisoned cache and recovers stuck clients.
 *
 * CSP: same-origin (/sw.js), same-origin scope, no eval, no external fetches -
 * fully within `default-src 'self'`.
 */

const CACHE_VERSION = 'gv-v2';
const SHELL_URL = '/';

// Pre-cache the app shell + manifest + icons so a fresh install works offline.
// Hashed JS/CSS are cached on first fetch (cache-first below).
const PRECACHE_URLS = [
  '/',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
];

// ─────────────────────────────────────────────────────────────────────────────
// Install - pre-cache the app shell, then take over immediately.
// ─────────────────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      // Tolerate a missing precache entry (e.g. an icon path drift) so a single
      // 404 never aborts the whole install and leaves the SW broken.
      .then((cache) => Promise.allSettled(PRECACHE_URLS.map((u) => cache.add(u))))
      .then(() => self.skipWaiting()),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Activate - delete old caches (recovers poisoned clients) and claim pages.
// ─────────────────────────────────────────────────────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      // If a previous cache version exists, this is an UPGRADE (the user may be
      // holding a poisoned cache-first shell). Delete the old caches, then force
      // a one-time reload of open tabs so they pick up the fresh, network-first
      // shell and recover automatically - no manual reload required.
      const hadOldCache = keys.some((k) => k !== CACHE_VERSION);
      await Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
      if (hadOldCache) {
        const wins = await self.clients.matchAll({ type: 'window' });
        for (const c of wins) {
          try {
            c.navigate(c.url);
          } catch {
            // best-effort self-heal; ignore clients that can't be navigated
          }
        }
      }
    })(),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Fetch
// ─────────────────────────────────────────────────────────────────────────────

function isHashedStatic(url) {
  // Next.js content-hashed, immutable assets.
  return url.pathname.startsWith('/_next/static/');
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }
  if (isHashedStatic(url)) {
    event.respondWith(cacheFirst(request));
    return;
  }
  event.respondWith(networkFirst(request));
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response && response.status === 200 && response.type === 'basic') {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const response = await fetch(request);
    if (response && response.status === 200 && response.type === 'basic') {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const response = await fetch(request);
    // Cache a fresh copy of the navigated page and refresh the shell fallback.
    if (response && response.status === 200 && response.type === 'basic') {
      cache.put(request, response.clone());
      cache.put(SHELL_URL, response.clone());
    }
    return response;
  } catch {
    // Offline: prefer the exact page, then the app shell.
    const cached = (await cache.match(request)) || (await cache.match(SHELL_URL));
    if (cached) return cached;
    return new Response('Offline', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}
