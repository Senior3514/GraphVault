/**
 * Guards the one invariant that's easy to silently break: the `<meta>` CSP
 * (`lib/security/csp.ts`, rendered by `app/layout.tsx`) and the
 * `Content-Security-Policy` response header in the repo-root `vercel.json`
 * must stay in sync - with exactly one deliberate difference: `frame-ancestors`
 * is present in the header (the header is the real enforcement point on
 * Vercel) but absent from the `<meta>` variant, since browsers ignore
 * `frame-ancestors` in `<meta>` per spec and log a console error for it if
 * it's there anyway (per the comment in both files).
 *
 * Trusted Types (`require-trusted-types-for` / `trusted-types`) is
 * deliberately NOT part of this policy yet - see the long comment at the top
 * of `csp.ts` for the empirically-found blocker (a third-party `force-graph`
 * dependency assigns a bare string to `.innerHTML` in its own `init()`, which
 * would throw on `/graph` and `/embed` under enforcement) before re-adding it.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { CSP, CSP_DIRECTIVES, CSP_META, CSP_META_DIRECTIVES } from './csp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// apps/web/lib/security -> repo root is four levels up.
const REPO_ROOT = path.resolve(__dirname, '../../../..');

function readVercelCspHeader(): string {
  const vercelJson = JSON.parse(readFileSync(path.join(REPO_ROOT, 'vercel.json'), 'utf8')) as {
    headers: Array<{ source: string; headers: Array<{ key: string; value: string }> }>;
  };
  const catchAll = vercelJson.headers.find((h) => h.source === '/(.*)');
  assert.ok(catchAll, 'vercel.json must have a catch-all header rule for "/(.*)"');
  const cspHeader = catchAll.headers.find((h) => h.key === 'Content-Security-Policy');
  assert.ok(cspHeader, 'vercel.json catch-all rule must set a Content-Security-Policy header');
  return cspHeader.value;
}

describe('CSP: <meta> (lib/security/csp.ts) vs vercel.json header', () => {
  it('the header has every meta directive plus exactly frame-ancestors', () => {
    const headerDirectives = readVercelCspHeader()
      .split(';')
      .map((d) => d.trim())
      .filter(Boolean);

    // Order-independent set comparison: a directive present in the header but
    // missing from CSP_DIRECTIVES (or vice versa, other than frame-ancestors)
    // means someone edited only one of the two files.
    const headerSet = new Set(headerDirectives);
    const fullSet = new Set(CSP_DIRECTIVES);
    assert.deepEqual(
      [...headerSet].sort(),
      [...fullSet].sort(),
      'vercel.json Content-Security-Policy header and lib/security/csp.ts CSP_DIRECTIVES must declare the same directives - update both together',
    );

    // The <meta> variant must be the header minus frame-ancestors - nothing more, nothing less.
    const metaSet: Set<string> = new Set(CSP_META_DIRECTIVES);
    assert.ok(!metaSet.has("frame-ancestors 'none'"), 'CSP_META must not include frame-ancestors');
    for (const d of headerSet) {
      if (d.startsWith('frame-ancestors')) continue;
      assert.ok(metaSet.has(d), `CSP_META is missing a directive the header has: ${d}`);
    }
    assert.equal(metaSet.size, headerSet.size - 1);
  });

  it('CSP_DIRECTIVES.join("; ") matches the exported CSP string', () => {
    assert.equal(CSP, CSP_DIRECTIVES.join('; '));
    assert.equal(CSP_META, CSP_META_DIRECTIVES.join('; '));
  });

  it('never weakens an existing directive to something more permissive', () => {
    // A minimal, deliberately-conservative allowlist check: every directive
    // this app has ever shipped must still forbid remote origins it always
    // forbade. Guards against an accidental "oh it works if I just allow *"
    // fix landing during a future edit.
    assert.ok(CSP.includes("object-src 'none'"));
    assert.ok(CSP.includes("frame-src 'none'"));
    assert.ok(CSP.includes("frame-ancestors 'none'"));
    assert.ok(CSP.includes("base-uri 'self'"));
    assert.ok(CSP.includes("form-action 'self'"));
    assert.ok(!CSP.includes('unsafe-eval'));
  });

  it('does not (yet) declare Trusted Types enforcement - see the blocker note in csp.ts', () => {
    // A future change that re-enables this must also update this test (and
    // re-verify with a real headless-Chromium run against the actual force-
    // graph-loading routes, not just a green `pnpm build`).
    assert.ok(!CSP.includes('require-trusted-types-for'));
    assert.ok(!CSP.includes('trusted-types '));
  });
});
