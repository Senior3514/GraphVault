/**
 * Pure helper: compose a collision-safe Markdown note from OS share-sheet
 * / PWA share_target parameters (title, text, url).
 *
 * This module has ZERO browser/React dependencies so it is testable in Node.
 * The vault consumer (share page) calls `createNote` with the result.
 *
 * ## Security
 * The composed Markdown is stored verbatim and later rendered through the
 * existing DOMPurify path in `MarkdownPreview`, so no sanitisation is done
 * here. All three inputs are treated as untrusted strings.
 *
 * ## Protocol handler (web+graphvault://)
 * The `web+graphvault:` custom protocol is registered by
 * `ProtocolHandlerRegistrar` (a client component). When the OS launches
 * `web+graphvault:<encoded-url>` the browser opens
 * `/share/?url=<encoded-url>` and this helper processes it exactly like a
 * normal share-target invocation.
 *
 * ## Path derivation
 * The note filename is derived from the title (or today's date + domain as
 * fallback). Collision handling is the caller's responsibility - the helper
 * returns a `basePath` that the caller should make unique (e.g. append ` (2)`).
 */

/** Shared parameters as received from the OS share sheet or query string. */
export interface ShareParams {
  title?: string | null;
  text?: string | null;
  url?: string | null;
}

/** Result produced by {@link composeSharedNote}. */
export interface ComposedNote {
  /** Suggested vault path without collision suffix (e.g. "Web Clip - Example.md"). */
  basePath: string;
  /** Full Markdown content ready to store. */
  content: string;
}

/**
 * Strip characters that are illegal in vault paths on most OSes.
 * Vault paths must not contain `\ / : * ? " < > |`.
 */
function sanitisePath(raw: string): string {
  return raw
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * Extract the hostname from a URL string for use in a fallback title.
 * Returns an empty string when `raw` is not a parseable URL.
 */
function hostOf(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return '';
  }
}

/**
 * Compose a Markdown note from OS share-target / protocol-handler parameters.
 *
 * Behaviour:
 * - `title` wins as the H1 heading if non-empty; otherwise `url`'s hostname
 *   is used; final fallback is `"Shared note"`.
 * - `text` becomes the body paragraph (may be empty).
 * - `url` is appended as a Markdown link in a `Source:` line when present.
 * - The resulting `basePath` is `"Web Clip - <title>.md"` (collision-safe
 *   suffix added by the caller).
 */
export function composeSharedNote(params: ShareParams): ComposedNote {
  const title = params.title?.trim() || '';
  const text = params.text?.trim() || '';
  const url = params.url?.trim() || '';

  // Derive a human-readable heading: title > hostname > fallback.
  const heading = title || (url ? hostOf(url) || 'Shared note' : 'Shared note');

  // Derive the vault path base.
  const pathBase = sanitisePath(`Web Clip - ${heading}`);
  const basePath = `${pathBase}.md`;

  // Build the Markdown body.
  const lines: string[] = [`# ${heading}`, ''];

  if (text) {
    lines.push(text, '');
  }

  if (url) {
    lines.push(`**Source:** [${url}](${url})`, '');
  }

  const content = lines.join('\n');

  return { basePath, content };
}
