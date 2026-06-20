/**
 * Shared SSRF guard tests (services/ssrf.ts).
 *
 * These exercise the guard logic directly, stubbing the DNS resolver and the
 * low-level transport so no real network/DNS is touched:
 *   - a target that resolves to a private IP is rejected,
 *   - a public target is allowed through,
 *   - a redirect from a public URL to a private IP is rejected at the hop,
 *   - the GRAPHVAULT_ALLOW_PRIVATE_PROXY_TARGETS opt-in relaxes the rejection,
 *   - the SSRF error message never leaks the matched internal address/range.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertSafeUrl,
  guardedFetch,
  isPrivateOrLoopbackIp,
  __setResolverForTests,
  __setTransportForTests,
  type GuardedTransport,
  type ResolveAllFn,
} from '../src/services/ssrf.js';

/** Build a resolver that maps specific hostnames to fixed addresses. */
function resolverFor(map: Record<string, string[]>): ResolveAllFn {
  return async (hostname: string) => {
    const addrs = map[hostname];
    if (!addrs) throw new Error(`no stub for ${hostname}`);
    return addrs;
  };
}

// ---------------------------------------------------------------------------
// assertSafeUrl
// ---------------------------------------------------------------------------

test('assertSafeUrl: rejects a host that resolves to a private IP', async () => {
  const restore = __setResolverForTests(resolverFor({ 'evil.example.com': ['10.0.0.5'] }));
  try {
    await assert.rejects(
      () => assertSafeUrl('https://evil.example.com/', { allowPrivate: false }),
      (err: unknown) => {
        const e = err as { statusCode?: number; message: string };
        assert.equal(e.statusCode, 400);
        // Must NOT leak the internal address or range.
        assert.ok(!e.message.includes('10.0.0.5'), `leaked address: ${e.message}`);
        assert.match(e.message.toLowerCase(), /blocked private address/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test('assertSafeUrl: rejects the cloud-metadata link-local address', async () => {
  const restore = __setResolverForTests(
    resolverFor({ 'metadata.example.com': ['169.254.169.254'] }),
  );
  try {
    await assert.rejects(() =>
      assertSafeUrl('http://metadata.example.com/latest/meta-data/', { allowPrivate: false }),
    );
  } finally {
    restore();
  }
});

test('assertSafeUrl: allows a host that resolves to a public IP', async () => {
  const restore = __setResolverForTests(resolverFor({ 'good.example.com': ['93.184.216.34'] }));
  try {
    const { url, addresses } = await assertSafeUrl('https://good.example.com/page', {
      allowPrivate: false,
    });
    assert.equal(url.hostname, 'good.example.com');
    assert.deepEqual(addresses, ['93.184.216.34']);
  } finally {
    restore();
  }
});

test('assertSafeUrl: rejects non-http(s) schemes', async () => {
  await assert.rejects(() => assertSafeUrl('ftp://example.com/x'));
  await assert.rejects(() => assertSafeUrl('file:///etc/passwd'));
});

test('assertSafeUrl: blocks localhost by hostname before DNS', async () => {
  // No resolver stub installed for "localhost" — the hostname pre-check must
  // fire first, so this rejects without ever calling the resolver.
  await assert.rejects(() => assertSafeUrl('http://localhost/admin', { allowPrivate: false }));
});

test('assertSafeUrl: rejects an IP literal in the private range', async () => {
  await assert.rejects(() => assertSafeUrl('http://127.0.0.1:9000/', { allowPrivate: false }));
  await assert.rejects(() => assertSafeUrl('http://[::1]/', { allowPrivate: false }));
});

// ---------------------------------------------------------------------------
// opt-in env relaxation
// ---------------------------------------------------------------------------

test('assertSafeUrl: GRAPHVAULT_ALLOW_PRIVATE_PROXY_TARGETS relaxes private rejection', async () => {
  const restore = __setResolverForTests(resolverFor({ 'minio.local': ['127.0.0.1'] }));
  const prev = process.env.GRAPHVAULT_ALLOW_PRIVATE_PROXY_TARGETS;
  process.env.GRAPHVAULT_ALLOW_PRIVATE_PROXY_TARGETS = 'true';
  try {
    // With the opt-in on (and no explicit allowPrivate override), a loopback
    // target is permitted — for self-hosted MinIO/Azurite on localhost.
    const { addresses } = await assertSafeUrl('http://minio.local:9000/bucket');
    assert.deepEqual(addresses, ['127.0.0.1']);
  } finally {
    if (prev === undefined) delete process.env.GRAPHVAULT_ALLOW_PRIVATE_PROXY_TARGETS;
    else process.env.GRAPHVAULT_ALLOW_PRIVATE_PROXY_TARGETS = prev;
    restore();
  }
});

test('assertSafeUrl: explicit allowPrivate:false is NOT relaxed by the env opt-in', async () => {
  const restore = __setResolverForTests(resolverFor({ 'minio.local': ['127.0.0.1'] }));
  const prev = process.env.GRAPHVAULT_ALLOW_PRIVATE_PROXY_TARGETS;
  process.env.GRAPHVAULT_ALLOW_PRIVATE_PROXY_TARGETS = 'true';
  try {
    // Clip passes allowPrivate:false explicitly; the env must not override it.
    await assert.rejects(() =>
      assertSafeUrl('http://minio.local:9000/bucket', { allowPrivate: false }),
    );
  } finally {
    if (prev === undefined) delete process.env.GRAPHVAULT_ALLOW_PRIVATE_PROXY_TARGETS;
    else process.env.GRAPHVAULT_ALLOW_PRIVATE_PROXY_TARGETS = prev;
    restore();
  }
});

// ---------------------------------------------------------------------------
// guardedFetch — redirect re-validation
// ---------------------------------------------------------------------------

test('guardedFetch: allows a public target and returns the response', async () => {
  const restoreResolver = __setResolverForTests(
    resolverFor({ 'good.example.com': ['93.184.216.34'] }),
  );
  const restoreTransport = __setTransportForTests(
    (async () => new Response('hello', { status: 200 })) as GuardedTransport,
  );
  try {
    const res = await guardedFetch('https://good.example.com/', {}, { allowPrivate: false });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'hello');
  } finally {
    restoreTransport();
    restoreResolver();
  }
});

test('guardedFetch: rejects a redirect that points at a private IP', async () => {
  // hop 0: public host returns a 302 to an internal host.
  // hop 1: internal host resolves to a private IP -> must be rejected.
  const restoreResolver = __setResolverForTests(
    resolverFor({
      'public.example.com': ['93.184.216.34'],
      'internal.example.com': ['169.254.169.254'],
    }),
  );
  const transport: GuardedTransport = async (url) => {
    if (url === 'https://public.example.com/') {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://internal.example.com/secret' },
      });
    }
    // Should never be reached for the internal host.
    return new Response('SHOULD NOT HAPPEN', { status: 200 });
  };
  const restoreTransport = __setTransportForTests(transport);
  try {
    await assert.rejects(
      () => guardedFetch('https://public.example.com/', {}, { allowPrivate: false }),
      (err: unknown) => {
        const e = err as { statusCode?: number; message: string };
        assert.equal(e.statusCode, 400);
        assert.ok(!e.message.includes('169.254.169.254'), `leaked address: ${e.message}`);
        return true;
      },
    );
  } finally {
    restoreTransport();
    restoreResolver();
  }
});

test('guardedFetch: caps redirect chains', async () => {
  const restoreResolver = __setResolverForTests(
    resolverFor({ 'loop.example.com': ['93.184.216.34'] }),
  );
  // Always redirect back to a public host -> exhausts the hop budget.
  const restoreTransport = __setTransportForTests(
    (async () =>
      new Response(null, {
        status: 302,
        headers: { location: 'https://loop.example.com/next' },
      })) as GuardedTransport,
  );
  try {
    await assert.rejects(
      () => guardedFetch('https://loop.example.com/', {}, { allowPrivate: false, maxRedirects: 2 }),
      /Too many redirects/,
    );
  } finally {
    restoreTransport();
    restoreResolver();
  }
});

// ---------------------------------------------------------------------------
// isPrivateOrLoopbackIp — IPv4-mapped IPv6 unwrap (new edge case)
// ---------------------------------------------------------------------------

test('isPrivateOrLoopbackIp: unwraps IPv4-mapped IPv6 and blocks embedded private', () => {
  assert.equal(isPrivateOrLoopbackIp('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateOrLoopbackIp('::ffff:10.0.0.1'), true);
  assert.equal(isPrivateOrLoopbackIp('::ffff:169.254.169.254'), true);
  // A mapped public address is still allowed.
  assert.equal(isPrivateOrLoopbackIp('::ffff:8.8.8.8'), false);
});
