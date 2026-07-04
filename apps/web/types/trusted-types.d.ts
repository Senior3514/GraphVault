/**
 * Minimal ambient typings for the browser's Trusted Types API
 * (https://w3c.github.io/trusted-types/dist/spec/).
 *
 * TypeScript's bundled `lib.dom.d.ts` at the version pinned in this repo does
 * not yet ship the real Trusted Types surface - only the empty placeholder
 * `interface TrustedHTML {}` from `@types/react`'s `global.d.ts` (referenced
 * by `dangerouslySetInnerHTML`'s type). This file declares just enough of the
 * real spec for `lib/security/trustedTypes.ts` to create and use a policy
 * with real types, without pulling in a third-party `@types/trusted-types`
 * dependency for two call sites.
 *
 * This is a global ambient declaration file (no imports/exports), so it
 * merges with the existing lib.dom `Window` interface rather than replacing
 * it - it only *adds* the `trustedTypes` member.
 */

interface TrustedTypePolicyOptions {
  createHTML?(input: string): string;
  createScript?(input: string): string;
  createScriptURL?(input: string): string;
}

interface TrustedTypePolicy {
  readonly name: string;
  createHTML(input: string): TrustedHTML;
}

interface TrustedTypePolicyFactory {
  createPolicy(name: string, rules: TrustedTypePolicyOptions): TrustedTypePolicy;
  isHTML(value: unknown): boolean;
  getAttributeType(tagName: string, attribute: string): string | null;
  readonly defaultPolicy: TrustedTypePolicy | null;
}

interface Window {
  readonly trustedTypes?: TrustedTypePolicyFactory;
}
