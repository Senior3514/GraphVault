/**
 * GraphVault Service Worker
 *
 * Strategy: cache-first for same-origin static assets, with a network
 * fallback to keep content fresh when online. Serves the app-shell
 * (index.html) as the offline fallback for any navigation request.
 *
 * Cache versioning: bump CACHE_VERSION when deploying a new build so stale
 * assets are evicted on activate.
 *
 * CSP: this file is served from the same origin (/sw.js) and registered
 * with a same-origin scope, so it operates fully within the existing
 * `default-src 'self'` policy. No eval, no external fetches.
 */

const CACHE_VERSION = 'gv-v1';
const SHELL_URL = '/';

// Assets to pre-cache on install (app shell + manifest + icons).
// Next.js static export places HTML at the root; JS/CSS land in /_next/static/.
// We don't enumerate those here — they are cached on first fetch.
const PRECACHE_URLS = ['/', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

// ─────────────────────────────────────────────────────────────────────────────
// Install — pre-cache the app shell
// ─────────────────────────────────────────────────────────────────────────────

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_VERSION)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Activate — claim clients and delete old caches
// ─────────────────────────────────────────────────────────────────────────────

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Fetch — cache-first for same-origin GET requests
// ─────────────────────────────────────────────────────────────────────────────

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Only handle GET requests to same origin.
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(handleFetch(request));
});

async function handleFetch(request) {
  const cache = await caches.open(CACHE_VERSION);

  // 1. Try the cache first.
  const cached = await cache.match(request);
  if (cached) return cached;

  // 2. Not cached — try the network.
  try {
    const response = await fetch(request);

    // Cache successful same-origin responses (status 200, basic type).
    if (response && response.status === 200 && response.type === 'basic') {
      // Clone before consuming — one copy for the cache, one for the browser.
      cache.put(request, response.clone());
    }

    return response;
  } catch {
    // 3. Network failed (offline). For navigation requests, serve the shell.
    if (request.mode === 'navigate') {
      const shell = await cache.match(SHELL_URL);
      if (shell) return shell;
    }

    // For other requests, return a minimal offline response.
    return new Response('Offline', {
      status: 503,
      statusText: 'Service Unavailable',
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}
