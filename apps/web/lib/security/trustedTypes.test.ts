/**
 * Tests for `toTrustedHTML()`. Runs in Node (no real DOM), so we stub
 * `globalThis.window.trustedTypes` per the wave-3 "shim browser APIs via
 * globalThis" lesson (see `lib/theme.test.ts` for the same pattern), then
 * restore it afterwards. `__resetPolicyForTests()` clears the module's
 * memoized policy between cases (see its doc comment - test-only).
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { __resetPolicyForTests, toTrustedHTML, TRUSTED_TYPES_POLICY_NAME } from './trustedTypes';

function setWindow(value: unknown): void {
  (globalThis as unknown as Record<string, unknown>).window = value;
}
function clearWindow(): void {
  Reflect.deleteProperty(globalThis as unknown as Record<string, unknown>, 'window');
}

afterEach(() => {
  clearWindow();
  __resetPolicyForTests();
});

describe('toTrustedHTML', () => {
  it('is a no-op passthrough when window is undefined (SSR / build time)', () => {
    clearWindow();
    assert.equal(toTrustedHTML('<b>hi</b>'), '<b>hi</b>');
  });

  it('is a no-op passthrough when window.trustedTypes is undefined (Firefox/Safari)', () => {
    setWindow({});
    assert.equal(toTrustedHTML('<b>hi</b>'), '<b>hi</b>');
  });

  it('wraps the string via the registered policy when trustedTypes is present', () => {
    const calls: string[] = [];
    let createdPolicyName: string | undefined;
    setWindow({
      trustedTypes: {
        createPolicy(name: string, rules: { createHTML(input: string): string }) {
          createdPolicyName = name;
          return {
            name,
            createHTML(input: string) {
              calls.push(input);
              // Return a distinguishable marker object so the test can
              // confirm the *policy's* return value is what flows through,
              // not the raw string.
              return { __trustedHtmlMarker: rules.createHTML(input) };
            },
          };
        },
      },
    });
    const result = toTrustedHTML('<em>sanitized</em>') as unknown as {
      __trustedHtmlMarker: string;
    };
    assert.equal(createdPolicyName, TRUSTED_TYPES_POLICY_NAME);
    assert.deepEqual(calls, ['<em>sanitized</em>']);
    assert.equal(result.__trustedHtmlMarker, '<em>sanitized</em>');
  });

  it('creates the policy only once across repeated calls (memoized)', () => {
    let createCount = 0;
    setWindow({
      trustedTypes: {
        createPolicy(_name: string, rules: { createHTML(input: string): string }) {
          createCount++;
          return { createHTML: (input: string) => rules.createHTML(input) };
        },
      },
    });
    toTrustedHTML('a');
    toTrustedHTML('b');
    toTrustedHTML('c');
    assert.equal(createCount, 1);
  });

  it('fails open to the plain string if createPolicy throws (e.g. CSP rejects the name)', () => {
    setWindow({
      trustedTypes: {
        createPolicy() {
          throw new Error('policy name not allowed by CSP trusted-types directive');
        },
      },
    });
    assert.doesNotThrow(() => {
      const out = toTrustedHTML('<i>x</i>');
      assert.equal(out, '<i>x</i>');
    });
  });
});
