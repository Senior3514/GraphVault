'use client';

/**
 * /share - PWA share_target receiver + web+graphvault:// protocol handler.
 *
 * ## Entry points
 *
 * 1. **PWA share_target (mobile / desktop):**
 *    The manifest's `share_target` sends a GET request to `/share/` with
 *    query params `title`, `text`, and `url` when the user taps "Share →
 *    GraphVault" from any app (browser, PDF reader, email client, etc.).
 *
 * 2. **web+graphvault:// protocol handler:**
 *    `ProtocolHandlerRegistrar` registers `web+graphvault:` to open
 *    `/share/?url=<encoded-uri>`. When another app / hyperlink triggers
 *    `web+graphvault:https://example.com`, the browser routes it here.
 *    The share page strips the `web+graphvault:` prefix from the `url`
 *    param to recover the real URL.
 *
 * ## Flow
 *
 * On mount the page:
 *   1. Reads `title`, `text`, `url` from the URL search params.
 *   2. Calls `composeSharedNote` to build the Markdown body + a base filename.
 *   3. Resolves path collisions (appends ` (2)`, ` (3)` …) via the vault.
 *   4. Creates the note with `vault.createNote`.
 *   5. Redirects to `/vault/?note=<path>` so the editor opens it immediately.
 *
 * ## Security
 *
 * All inputs are untrusted strings from external apps. They are stored
 * verbatim as Markdown and later rendered through the DOMPurify-sanitised
 * `MarkdownPreview` path - the same pipeline used for every user note.
 * No further sanitisation is applied here.
 *
 * ## Static export
 *
 * This page is a client component with no server-side data fetching.
 * It exports as a static HTML shell under `/share/index.html`, compatible
 * with `output: 'export'` in `next.config.mjs`.
 */

import { useEffect, useState } from 'react';
import { useVaultContext } from '../../lib/vault/VaultProvider';
import { composeSharedNote } from '../../lib/vault/shareNote';
import { ProtocolHandlerRegistrar } from '../../components/ProtocolHandlerRegistrar';
import type { NotePath } from '../../lib/vault/types';

type PageState = 'pending' | 'creating' | 'error';

export default function SharePage() {
  const vault = useVaultContext();
  const [state, setState] = useState<PageState>('pending');
  const [errorMsg, setErrorMsg] = useState<string>('');

  useEffect(() => {
    // Wait for vault to be ready before attempting to create a note.
    if (!vault.ready) return;
    if (state !== 'pending') return;
    setState('creating');

    try {
      const params = new URLSearchParams(window.location.search);
      const rawTitle = params.get('title') ?? '';
      const rawText = params.get('text') ?? '';
      let rawUrl = params.get('url') ?? '';

      // Strip the web+graphvault: prefix if the protocol handler passed it
      // through intact (some browsers do, some strip it before the %s expansion).
      const SCHEME = 'web+graphvault:';
      if (rawUrl.startsWith(SCHEME)) {
        rawUrl = rawUrl.slice(SCHEME.length);
      }

      // Validate: if absolutely nothing was shared, redirect to vault without
      // creating a note so the user isn't left staring at an empty note.
      if (!rawTitle && !rawText && !rawUrl) {
        window.location.replace('/vault/');
        return;
      }

      const { basePath, content } = composeSharedNote({
        title: rawTitle,
        text: rawText,
        url: rawUrl,
      });

      // Collision-safe path: append (2), (3), … until the path is free.
      let path: string = basePath;
      const base = basePath.replace(/\.md$/i, '');
      for (let i = 2; vault.getNote(path as NotePath); i++) {
        path = `${base} (${i}).md`;
      }

      const created = vault.createNote(path, content);

      // Replace the current history entry so the user can't "back" to /share/.
      window.history.replaceState({}, '', '/vault/');
      // Navigate to the vault with the new note open.
      window.location.replace(`/vault/?note=${encodeURIComponent(created.path)}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Could not create note.';
      setErrorMsg(msg);
      setState('error');
    }
  }, [vault.ready, state, vault]);

  // ---- Render -----------------------------------------------------------------

  if (state === 'error') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-neutral-950 p-8 text-neutral-100">
        <ProtocolHandlerRegistrar />
        <p className="text-sm text-red-400">Could not save shared note: {errorMsg}</p>
        <a
          href="/vault/"
          className="rounded bg-neutral-800 px-4 py-2 text-sm text-neutral-200 hover:bg-neutral-700"
        >
          Open vault
        </a>
      </div>
    );
  }

  // Loading / creating state - show a minimal indicator.
  return (
    <div className="flex min-h-screen items-center justify-center bg-neutral-950">
      <ProtocolHandlerRegistrar />
      <p className="text-sm text-neutral-500">Saving to GraphVault…</p>
    </div>
  );
}
