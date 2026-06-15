'use client';

/**
 * ProtocolHandlerRegistrar
 *
 * Registers the `web+graphvault:` custom URL protocol on mount so that
 * `web+graphvault:<url>` links open a new note in GraphVault.
 *
 * ## How the web+graphvault:// scheme works
 *
 * When the OS or another app opens a `web+graphvault:` URI, the browser maps
 * it to `/share/?url=%s` (where `%s` is the encoded original URI) and
 * GraphVault's share page creates a new note from it.
 *
 * Example:
 *   web+graphvault:https://example.com/article
 *   → browser opens /share/?url=web%2Bgraphvault%3Ahttps%3A%2F%2Fexample.com%2Farticle
 *   → share page strips the scheme prefix, composes the note, redirects to /vault
 *
 * ## Platform availability
 *
 * `navigator.registerProtocolHandler` is part of the HTML5 spec and available
 * in Chrome 4+, Firefox 3+, Edge 79+, and Safari 15.4+ over HTTPS.
 * Registration is silently skipped when:
 *   - The browser does not implement the API (old browsers, non-HTTPS).
 *   - The component mounts in an SSR context (navigator is undefined).
 *   - The browser throws a SecurityError (e.g. the page is not HTTPS in
 *     Firefox, or the scheme is already registered with the same URL).
 *
 * Renders no DOM — purely a side-effect component.
 */

import { useEffect } from 'react';

export function ProtocolHandlerRegistrar() {
  useEffect(() => {
    if (typeof navigator === 'undefined' || !('registerProtocolHandler' in navigator)) return;

    try {
      // `%s` is the placeholder for the full URI passed by the browser.
      // We route it through the share page so the same compose + create
      // logic is reused identically.
      navigator.registerProtocolHandler(
        'web+graphvault',
        `${window.location.origin}/share/?url=%s`,
      );
    } catch {
      // Non-fatal — SecurityError or NotSupportedError from the browser.
      // The protocol handler is an enhancement; the app works without it.
    }
  }, []);

  return null;
}
