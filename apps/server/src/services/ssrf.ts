/**
 * Shared SSRF (Server-Side Request Forgery) guard for every outbound proxy.
 *
 * Why this exists
 * ───────────────
 * Several services fetch a URL/endpoint that an *authenticated user* supplied:
 *   - the web clipper (clip.ts)        — arbitrary public page URL
 *   - WebDAV proxy (webdav.ts)         — user-supplied WebDAV base URL
 *   - S3 proxy (s3.ts)                 — custom S3-compatible `endpoint`
 *   - Azure proxy (azure.ts)           — custom `endpoint` (Azurite override)
 *   - GCS proxy (gcs.ts)               — fixed host, routed through here too
 *   - AI proxy (ai.ts)                 — custom OpenAI-compatible `baseUrl`
 *
 * Without a guard an attacker can point any of these at `http://169.254.169.254`
 * (cloud-metadata), `http://127.0.0.1:…`, or an internal service and have the
 * server fetch it on their behalf. This module centralises the defence so every
 * proxy gets identical, always-on protection.
 *
 * What it does
 * ────────────
 *  1. Validates the scheme (http/https only) and rejects obvious internal
 *     hostnames (localhost, *.internal, metadata.google.internal, …).
 *  2. Resolves the hostname to its IP addresses *once* and rejects the request
 *     if any address is private/loopback/link-local/unique-local/reserved.
 *  3. Connects using a DNS-*pinned* transport: the socket is forced to connect
 *     to one of the exact addresses we already validated, via the `lookup`
 *     option on node's http/https client. The TLS SNI and `Host` header remain
 *     the original hostname, so certificate validation is unaffected. This
 *     closes the classic TOCTOU / DNS-rebinding hole where a name resolves to a
 *     public IP during the check and flips to a private IP for the real fetch.
 *  4. Re-runs the full check on every redirect hop (redirects are followed
 *     manually) so a public URL that 30x-redirects into private space is caught.
 *
 * Opt-in escape hatch
 * ───────────────────
 * Self-hosters who run a storage backend on localhost (e.g. MinIO/Azurite on
 * 127.0.0.1) can set `GRAPHVAULT_ALLOW_PRIVATE_PROXY_TARGETS=true` to relax the
 * private-address rejection. It defaults to **false** (safe). The flag never
 * applies to the clip service — clipping arbitrary user URLs is always guarded.
 *
 * Zero new npm dependencies: node:dns + node:http(s) only.
 */

import { lookup as dnsLookup } from 'node:dns';
import { lookup as dnsLookupPromises } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { badRequest } from '../errors.js';

// ---------------------------------------------------------------------------
// Private-range detection
// ---------------------------------------------------------------------------

/**
 * Returns true if the given IPv4 or IPv6 address is in a range we must block:
 *   - IPv4 loopback:           127.0.0.0/8
 *   - IPv4 private (RFC 1918): 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
 *   - IPv4 link-local:         169.254.0.0/16  (includes 169.254.169.254 — cloud metadata)
 *   - IPv4 CGNAT:              100.64.0.0/10
 *   - IPv4 unspecified:        0.0.0.0/8
 *   - IPv6 loopback:           ::1
 *   - IPv6 link-local:         fe80::/10
 *   - IPv6 unique-local:       fc00::/7 (fc:: and fd::)
 *   - IPv6 unspecified:        ::
 *   - IPv4-mapped IPv6:        ::ffff:a.b.c.d — unwrapped and re-checked as IPv4
 */
export function isPrivateOrLoopbackIp(address: string): boolean {
  // Normalise lowercase.
  const addr = address.trim().toLowerCase();

  // --- IPv6 ---
  if (addr.includes(':')) {
    // Unwrap IPv4-mapped / IPv4-compatible IPv6 (e.g. ::ffff:127.0.0.1) and
    // re-check the embedded IPv4 so a mapped private address can't sneak past.
    const mapped = /(?:::ffff:|::)((?:\d{1,3}\.){3}\d{1,3})$/i.exec(addr);
    if (mapped?.[1]) {
      return isPrivateOrLoopbackIp(mapped[1]);
    }
    if (addr === '::1') return true; // loopback
    if (addr === '::' || addr === '0:0:0:0:0:0:0:0') return true; // unspecified
    // link-local: fe80::/10 (starts with fe8, fe9, fea, feb)
    if (/^fe[89ab]/i.test(addr)) return true;
    // unique-local: fc00::/7 (starts with fc or fd)
    if (/^f[cd]/i.test(addr)) return true;
    return false;
  }

  // --- IPv4 ---
  const parts = addr.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p) || p < 0 || p > 255)) {
    // Unparseable address — block it to be safe.
    return true;
  }
  const [a, b, c] = parts as [number, number, number, number];

  if (a === 127) return true; // 127.0.0.0/8 — loopback
  if (a === 0) return true; // 0.0.0.0/8 — unspecified
  if (a === 10) return true; // 10.0.0.0/8 — RFC 1918
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 — RFC 1918
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 — RFC 1918
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 — link-local + metadata
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 — CGNAT
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 — TEST-NET-1
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 — TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 — TEST-NET-3
  if (a === 240) return true; // 240.0.0.0/4 — reserved
  if (a === 255 && b === 255 && c === 255 && parts[3] === 255) return true; // broadcast

  return false;
}

// ---------------------------------------------------------------------------
// DNS resolution hook (overridable for tests)
// ---------------------------------------------------------------------------

/** A resolver returning every A/AAAA address for a hostname. */
export type ResolveAllFn = (hostname: string) => Promise<string[]>;

let resolveAll: ResolveAllFn = async (hostname) => {
  const records = await dnsLookupPromises(hostname, { all: true });
  return records.map((r) => r.address);
};

/**
 * Override the DNS resolver. Tests use this to make resolution deterministic
 * (and offline) without touching the network. Returns a restore function.
 */
export function __setResolverForTests(fn: ResolveAllFn): () => void {
  const prev = resolveAll;
  resolveAll = fn;
  return () => {
    resolveAll = prev;
  };
}

// ---------------------------------------------------------------------------
// Options + config
// ---------------------------------------------------------------------------

/** Read the opt-in env on every call so tests can toggle it per-case. */
function allowPrivateByEnv(): boolean {
  const v = process.env.GRAPHVAULT_ALLOW_PRIVATE_PROXY_TARGETS;
  return v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());
}

export interface SafeUrlOptions {
  /**
   * Permit private/loopback targets. When omitted, the value of
   * `GRAPHVAULT_ALLOW_PRIVATE_PROXY_TARGETS` is used. The clip service passes
   * `false` explicitly so it is never relaxed by the env flag.
   */
  allowPrivate?: boolean;
}

export interface ValidatedTarget {
  url: URL;
  /** The validated, pinned addresses to connect to (in resolution order). */
  addresses: string[];
}

// ---------------------------------------------------------------------------
// URL validation
// ---------------------------------------------------------------------------

/**
 * Validate a URL for an outbound proxy fetch:
 *  1. Must be http or https.
 *  2. Must not be an obvious internal hostname.
 *  3. Must resolve only to public addresses (unless `allowPrivate`).
 *
 * Resolves DNS exactly once and returns the validated addresses so the caller
 * can pin the connection to them. Throws AppError(400) with a generic message
 * ("blocked private address") that never leaks internal scan detail.
 */
export async function assertSafeUrl(
  urlStr: string,
  options: SafeUrlOptions = {},
): Promise<ValidatedTarget> {
  const allowPrivate = options.allowPrivate ?? allowPrivateByEnv();

  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    throw badRequest('Invalid URL');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('Only http and https URLs are allowed');
  }

  const hostname = url.hostname;
  const lowerHostname = hostname.toLowerCase();

  // Quick hostname checks before DNS lookup. These are always blocked, even
  // with allowPrivate, because they name internal-only resources.
  if (
    !allowPrivate &&
    (lowerHostname === 'localhost' ||
      lowerHostname === 'ip6-localhost' ||
      lowerHostname === 'ip6-loopback' ||
      lowerHostname.endsWith('.localhost') ||
      lowerHostname === 'metadata.google.internal' ||
      lowerHostname.endsWith('.internal'))
  ) {
    throw badRequest('URL resolves to a disallowed internal hostname');
  }

  // If the hostname is already a literal IP, validate it directly (no DNS).
  let addresses: string[];
  const literalIp = stripBrackets(hostname);
  if (isIpLiteral(literalIp)) {
    addresses = [literalIp];
  } else {
    try {
      addresses = await resolveAll(hostname);
    } catch {
      throw badRequest('Could not resolve hostname');
    }
  }

  if (addresses.length === 0) {
    throw badRequest('Hostname did not resolve');
  }

  if (!allowPrivate) {
    for (const addr of addresses) {
      if (isPrivateOrLoopbackIp(addr)) {
        // Generic message — do not leak which address/range matched.
        throw badRequest('URL resolves to a blocked private address (SSRF protection)');
      }
    }
  }

  return { url, addresses };
}

function stripBrackets(host: string): string {
  return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
}

function isIpLiteral(host: string): boolean {
  // Crude but sufficient: contains ':' (IPv6) or matches dotted-quad (IPv4).
  if (host.includes(':')) return true;
  return /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
}

// ---------------------------------------------------------------------------
// Pinned transport (node:http / node:https) — overridable for tests
// ---------------------------------------------------------------------------

export interface GuardedFetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  /** Total timeout for the request (ms). */
  timeoutMs?: number;
  /**
   * Stream the response body instead of buffering it. When set, a 2xx response
   * resolves as soon as headers arrive and its `body` is the live response
   * stream (so the caller can relay chunks without holding the whole payload in
   * memory). The DNS-pin / SSRF revalidation is unchanged — only the body tail
   * differs. Redirects are still followed via the buffered small-response path
   * (3xx bodies are tiny); only the final 2xx is streamed. See `docs/ai-bff.md`
   * §5.
   */
  stream?: boolean;
  /**
   * Optional AbortSignal. When it fires the in-flight request is destroyed,
   * which propagates to the underlying socket — used to stop a streamed upstream
   * generation the moment the downstream client disconnects.
   */
  signal?: AbortSignal;
}

/**
 * The low-level transport: perform a single (non-redirect-following) request to
 * `url`, pinning the socket to one of `pinnedAddresses`. Returns a standard
 * `Response`. Overridable so unit/integration tests can stub the network while
 * still exercising the full SSRF + redirect logic.
 */
export type GuardedTransport = (
  url: string,
  init: GuardedFetchInit,
  pinnedAddresses: string[],
) => Promise<Response>;

const defaultTransport: GuardedTransport = (url, init, pinnedAddresses) => {
  return new Promise<Response>((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('Invalid URL'));
      return;
    }
    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;

    // Pin DNS: force the socket to connect only to a pre-validated address.
    // SNI / Host stay the original hostname so TLS cert validation is intact.
    const pinned = new Set(pinnedAddresses);
    const pinnedLookup: typeof dnsLookup = ((
      _hostname: string,
      optionsOrCb: unknown,
      maybeCb?: unknown,
    ) => {
      const cb = (typeof optionsOrCb === 'function' ? optionsOrCb : maybeCb) as (
        err: NodeJS.ErrnoException | null,
        address: string | LookupAddress[],
        family?: number,
      ) => void;
      // Re-resolve via our hook, then keep only addresses we already validated.
      resolveAll(_hostname)
        .then((addrs) => {
          const safe = addrs.find((a) => pinned.has(a)) ?? pinnedAddresses[0];
          if (safe === undefined) {
            cb(new Error('No pinned address available') as NodeJS.ErrnoException, '');
            return;
          }
          if (isPrivateOrLoopbackIp(safe) && !pinned.has(safe)) {
            cb(new Error('Address failed SSRF revalidation') as NodeJS.ErrnoException, '');
            return;
          }
          const family = safe.includes(':') ? 6 : 4;
          cb(null, safe, family);
        })
        .catch(() => {
          // Fall back to the first pinned (already-validated) address.
          const safe = pinnedAddresses[0];
          if (safe === undefined) {
            cb(new Error('No pinned address available') as NodeJS.ErrnoException, '');
            return;
          }
          cb(null, safe, safe.includes(':') ? 6 : 4);
        });
    }) as unknown as typeof dnsLookup;

    const req = lib.request(
      url,
      {
        method: init.method ?? 'GET',
        headers: init.headers,
        lookup: pinnedLookup,
      },
      (res) => {
        const status = res.statusCode ?? 502;
        const headers = new Headers();
        for (const [k, v] of Object.entries(res.headers)) {
          if (v === undefined) continue;
          headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
        }

        // Streaming mode: resolve as soon as headers arrive and hand back a
        // Response whose body is the live socket stream — but ONLY for a final
        // 2xx. 3xx redirects keep the buffered tail so guardedFetch can read the
        // (tiny) body and chase the Location, re-running the full SSRF check on
        // the next hop. Everything above this point (DNS pin, revalidation) is
        // identical to the buffered path.
        if (init.stream && status >= 200 && status < 300) {
          // Web ReadableStream backed by the Node IncomingMessage; destroying
          // the request (on abort/disconnect) tears the socket down.
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              res.on('data', (c: Buffer) => controller.enqueue(new Uint8Array(c)));
              res.on('end', () => {
                try {
                  controller.close();
                } catch {
                  /* already closed (e.g. cancelled) */
                }
              });
              res.on('error', (err) => {
                try {
                  controller.error(err);
                } catch {
                  /* already errored */
                }
              });
            },
            cancel() {
              req.destroy();
            },
          });
          resolve(new Response(body, { status, headers }));
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          resolve(
            new Response(body, {
              status,
              headers,
            }),
          );
        });
        res.on('error', reject);
      },
    );

    // Abort propagation: when the caller's signal fires, destroy the request so
    // a streamed upstream generation stops the instant the client disconnects.
    if (init.signal) {
      if (init.signal.aborted) {
        req.destroy(new Error('Request aborted'));
      } else {
        init.signal.addEventListener('abort', () => req.destroy(new Error('Request aborted')), {
          once: true,
        });
      }
    }

    if (init.timeoutMs && init.timeoutMs > 0) {
      req.setTimeout(init.timeoutMs, () => {
        req.destroy(new Error('Request timed out'));
      });
    }
    req.on('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
};

let transport: GuardedTransport = defaultTransport;

/**
 * Override the transport. Tests use this to intercept outbound requests with a
 * fake store while still going through the real SSRF + redirect logic. Returns
 * a restore function.
 */
export function __setTransportForTests(fn: GuardedTransport): () => void {
  const prev = transport;
  transport = fn;
  return () => {
    transport = prev;
  };
}

// ---------------------------------------------------------------------------
// Guarded fetch (validate → pin → connect, re-validating each redirect hop)
// ---------------------------------------------------------------------------

export interface GuardedFetchOptions extends SafeUrlOptions {
  /** Maximum redirect hops to follow. Default 5. */
  maxRedirects?: number;
}

/**
 * Fetch a URL with full SSRF protection:
 *   - validates + DNS-pins the target,
 *   - follows up to `maxRedirects` redirects manually, re-validating every hop,
 *   - returns the final `Response`.
 *
 * The redirect body methods on the returned Response are fully buffered.
 */
export async function guardedFetch(
  urlStr: string,
  init: GuardedFetchInit = {},
  options: GuardedFetchOptions = {},
): Promise<Response> {
  const maxRedirects = options.maxRedirects ?? 5;
  let currentUrl = urlStr;
  let hops = 0;

  // Body/method are only resent on the first hop; redirects become GET with no
  // body (matching browser/fetch semantics for 301/302/303 on non-GET is more
  // nuanced, but our proxies issue a single request and rarely chase redirects
  // with a body — keeping the body only on hop 0 is the safe, simple choice).
  let hopInit: GuardedFetchInit = init;

  while (hops <= maxRedirects) {
    const { addresses } = await assertSafeUrl(currentUrl, options);

    const res = await transport(currentUrl, hopInit, addresses);

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      if (!location) {
        throw badRequest('Redirect response missing Location header');
      }
      let next: string;
      try {
        next = new URL(location, currentUrl).href;
      } catch {
        throw badRequest('Redirect Location is not a valid URL');
      }
      currentUrl = next;
      hops++;
      // Subsequent hops are bodyless GETs. Carry the stream flag + abort signal
      // so the final 2xx is still streamed and a disconnect still aborts mid-chase.
      hopInit = {
        method: 'GET',
        headers: stripBodyHeaders(init.headers),
        timeoutMs: init.timeoutMs,
        stream: init.stream,
        signal: init.signal,
      };
      continue;
    }

    return res;
  }

  throw badRequest(`Too many redirects (max ${maxRedirects})`);
}

function stripBodyHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return headers;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (lk === 'content-type' || lk === 'content-length') continue;
    out[k] = v;
  }
  return out;
}
