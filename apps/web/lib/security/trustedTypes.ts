/**
 * A single, narrowly-scoped Trusted Types policy for HTML we have already
 * sanitized ourselves (DOMPurify output in `lib/markdown/render.ts`).
 *
 * Trusted Types (`require-trusted-types-for 'script'; trusted-types
 * <name>;` in CSP) is a Chromium-only enforcement mechanism: once the CSP
 * directive is present, `Element.innerHTML` (and friends) throw a
 * `TypeError` unless assigned a `TrustedHTML` object minted by a *registered*
 * policy, instead of a plain string. Firefox/Safari ignore the directive and
 * keep accepting plain strings, so this module is a no-op there.
 *
 * Design choices, deliberately:
 *  - **No `'default'` policy.** A `default` policy silently upgrades *every*
 *    plain-string assignment app-wide (including ones we haven't audited),
 *    which defeats the point of Trusted Types as a defence-in-depth backstop.
 *    Registering a *named* policy means only call sites that explicitly
 *    import and call `toTrustedHTML()` are exempted - everything else still
 *    throws if some future code path tries to assign raw HTML.
 *  - **`createHTML` does NOT sanitize.** It is an attestation, not a filter:
 *    "this string has already been through DOMPurify.sanitize()". Never call
 *    `toTrustedHTML()` on a string that hasn't already been sanitized - that
 *    would defeat Trusted Types entirely (the policy would rubber-stamp
 *    attacker-controlled HTML).
 *  - **Created once, lazily, guarded by `typeof window !== 'undefined' &&
 *    window.trustedTypes`.** Trusted Types isn't universally supported, and
 *    SSR/static-export builds run in Node (no `window` at all) - `getPolicy()`
 *    must be a safe no-op there, returning the plain string unchanged so the
 *    exported static HTML never embeds a stringified object.
 *
 * See `apps/web/types/trusted-types.d.ts` for the minimal ambient typing
 * (TypeScript's bundled `lib.dom.d.ts` at this version does not yet ship the
 * real Trusted Types API surface).
 *
 * Current status: this policy exists and all 3 `dangerouslySetInnerHTML`
 * sites already call `toTrustedHTML()`, but the CSP does NOT yet declare
 * `require-trusted-types-for` / `trusted-types` (so none of this is actually
 * enforced by the browser today - `createPolicy` still succeeds and
 * `toTrustedHTML` still returns a real `TrustedHTML`, it's just that nothing
 * requires it yet). See the long comment at the top of `lib/security/csp.ts`
 * for the empirically-found third-party blocker and what unblocks it.
 */

export const TRUSTED_TYPES_POLICY_NAME = 'graphvault-sanitized-html';

let policy: TrustedTypePolicy | undefined;
let policyCreationAttempted = false;

function getTrustedTypesApi(): TrustedTypePolicyFactory | undefined {
  if (typeof window === 'undefined') return undefined;
  return window.trustedTypes;
}

function getPolicy(): TrustedTypePolicy | undefined {
  const tt = getTrustedTypesApi();
  if (!tt) return undefined;
  if (!policy && !policyCreationAttempted) {
    policyCreationAttempted = true;
    try {
      policy = tt.createPolicy(TRUSTED_TYPES_POLICY_NAME, {
        // Pass-through: the caller has already run DOMPurify.sanitize() on
        // `html` before it ever reaches this function. See the module-level
        // doc comment - this is an attestation, not a sanitizer.
        createHTML: (html: string) => html,
      });
    } catch {
      // `createPolicy` throws if a policy with this name already exists (e.g.
      // React Fast Refresh re-evaluating this module in dev) or if the page's
      // CSP `trusted-types` allow-list doesn't include our name. Either way,
      // fail open to the plain string below rather than crash rendering.
      policy = undefined;
    }
  }
  return policy;
}

/**
 * Wrap an already-DOMPurify-sanitized HTML string for use in
 * `dangerouslySetInnerHTML={{ __html: toTrustedHTML(sanitized) }}`.
 *
 * Returns a `TrustedHTML` object when the browser supports Trusted Types (so
 * the assignment satisfies `require-trusted-types-for 'script'` /
 * `trusted-types` CSP enforcement); otherwise returns the string unchanged
 * (Firefox/Safari today, and any SSR/build-time call with no `window`).
 * React's `dangerouslySetInnerHTML` assigns `__html` straight to
 * `domElement.innerHTML` with no coercion, so a `TrustedHTML` value passes
 * through untouched and satisfies the native setter's type check.
 */
export function toTrustedHTML(html: string): string | TrustedHTML {
  const p = getPolicy();
  return p ? p.createHTML(html) : html;
}

/**
 * Test-only: clears the memoized policy so `trustedTypes.test.ts` can swap in
 * a fresh `window.trustedTypes` stub between cases without cross-test leakage.
 * Never call this from application code.
 */
export function __resetPolicyForTests(): void {
  policy = undefined;
  policyCreationAttempted = false;
}
