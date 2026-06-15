# GraphVault Web Clipper

A Manifest V3 browser extension that turns any web page or selection into a
clean Markdown note — fully offline-capable, zero telemetry, local-first.

## What it does

1. **Clip selection** — converts whatever text you have highlighted on the
   current page to Markdown.
2. **Clip page** — extracts the main content of the page using a small
   dependency-free readability heuristic (prefers `<article>`, `<main>`,
   `[role=main]`; falls back to scoring block elements by text density and
   link density).
3. Both modes emit clean Markdown: `h1`–`h6`, paragraphs, bold, italic,
   `inline code`, fenced code blocks, blockquotes, links, images-as-links,
   ordered/unordered lists (nested), and GFM tables.
4. You can edit the title and add an optional `#tag` in the popup before saving.

### Save paths

| Action | How it works | Offline? |
|--------|-------------|----------|
| **Download .md** | Saves a `.md` file to your browser Downloads folder via `chrome.downloads`. | Yes |
| **Send to GraphVault** | Opens your GraphVault web app at `/vault?new=<markdown>` in a new tab. The web app receives the Markdown via the URL query parameter and can create a new note from it (see "Web app integration" below). | Requires the web app to be running |

The generated note contains a YAML-style header block with the source URL, date,
and tag, followed by the clipped Markdown content — plain `.md` with no
proprietary metadata.

---

## Loading unpacked (development)

### Chrome / Edge

1. Navigate to `chrome://extensions` (Chrome) or `edge://extensions` (Edge).
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select the `apps/extension/` directory.
4. The GraphVault icon appears in the toolbar (pin it from the Extensions menu
   for quick access).

### Firefox

Firefox requires a slightly different path because MV3 support is still maturing:

1. Navigate to `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…**.
3. Select `apps/extension/manifest.json`.

> Note: Firefox's MV3 implementation does not yet support service workers in
> exactly the same way as Chrome. The extension loads and the clip flow works,
> but the `downloads` API routing through the background service worker may
> require Firefox 127+. If the Download button does nothing, check the browser
> console for errors and try the "Send to GraphVault" path instead.

---

## How to test the clip flow

1. Open any article page (e.g. a Wikipedia article or a blog post).
2. Click the GraphVault icon in the toolbar.
3. **Test "Clip selection"**: first highlight some text on the page, then click
   "Clip selection" in the popup. You should see the highlighted text rendered
   as Markdown in the preview.
4. **Test "Clip page"**: click "Clip page". The extension will extract the main
   content of the page and show it in the preview.
5. Edit the **Title** field and optionally enter a `#tag` (e.g. `#reading`).
6. Click **Download .md** — a file named `<title>.md` should appear in your
   Downloads folder.
7. Click **Send to GraphVault** — a new tab should open at your configured
   GraphVault URL with the Markdown in the `?new=` query parameter.

---

## Settings

Click the small **Settings** link at the bottom of the popup to configure:

- **GraphVault URL**: the base URL of your running GraphVault web app
  (default: `http://localhost:3000`). Used for the "Send to GraphVault" action.

Settings are persisted via `chrome.storage.sync` (synced across your devices if
you are signed in to Chrome).

---

## Web app integration — the `?new=` deep link

When you click **Send to GraphVault**, the extension opens:

```
<VAULT_URL>/vault?new=<encodeURIComponent(markdownContent)>
```

The web app's `/vault` page needs a small handler for this parameter. The
integrating engineer should add something like the following to the vault page's
`useEffect` (or a route handler):

```typescript
// apps/web/app/vault/page.tsx (or wherever the vault route lives)
useEffect(() => {
  const params = new URLSearchParams(window.location.search);
  const newNote = params.get('new');
  if (newNote) {
    const content = decodeURIComponent(newNote);
    // Extract title from first # heading, or fall back to "Clipping <date>"
    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch?.[1]?.trim() || `Clipping ${new Date().toISOString().slice(0, 10)}`;
    createNote({ title, content }); // your vault's createNote action
    // Clean the URL so refreshing doesn't re-create the note
    window.history.replaceState({}, '', '/vault');
  }
}, []);
```

**Security note:** the `?new=` content comes from the extension (trusted) but
travels through the URL, which means it is visible in browser history and server
logs. The web app should treat it as untrusted input, sanitize before rendering,
and never execute it. Because the content is Markdown (not HTML), this is
inherently safe as long as the renderer sanitizes HTML (as GraphVault's renderer
already does via DOMPurify).

The URL parameter is limited to approximately 2 MB by most browsers. For very
long articles, "Download .md" is the more reliable path.

---

## Permissions

The extension requests the minimum set of permissions required:

| Permission | Why it is needed |
|------------|-----------------|
| `activeTab` | Read the title and URL of the current tab when the popup is open. Required to send a message to the tab's content script. |
| `scripting` | Inject the content script programmatically if it is not already loaded (graceful recovery). |
| `downloads` | Save the `.md` file to the user's Downloads folder without a file-picker dialog every time. |
| `storage` | Persist the user's GraphVault URL setting across browser sessions and devices (`chrome.storage.sync`). |

There are **no** host permissions, meaning the extension cannot access page
content on its own — it only runs when the user explicitly opens the popup. The
content script is injected at `document_idle` on all pages but is passive (it
only registers a message listener and does nothing until the popup sends a
message).

No external network requests are made by the extension itself. The only outbound
action is opening the user's own GraphVault tab.

---

## Planned deeper integration (post-MVP)

Once GraphVault's self-hosted sync server supports authenticated API calls from
browser extensions, the clipper will gain a third save path:

```
POST <SYNC_SERVER>/vault/<vaultId>/notes
Authorization: Bearer <token>
Content-Type: application/json

{ "path": "clippings/<title>.md", "content": "<markdown>" }
```

This will allow one-click clip → vault with no open-tab redirect, even when the
web app is not running. The token will be stored in `chrome.storage.local`
(device-scoped, not synced) and obtained via an OAuth-style flow. The extension
will request the `"identity"` permission at that point.

For the sync server API reference, see `docs/sync-protocol.md`.

---

## File structure

```
apps/extension/
  manifest.json           MV3 extension manifest (Chrome/Edge/Firefox)
  popup.html              Popup UI markup
  popup.css               Popup styles (dark, on-brand)
  popup.js                Popup controller (clip / form / save logic)
  content.js              Content script (HTML -> Markdown, runs in page)
  background.js           Service worker (relays downloads + tab opens)
  clipper.js              Standalone clipper library (for unit tests)
  clipper.test.js         node:test unit tests
  icons/
    icon16.png            Toolbar icon (16x16, RGBA PNG)
    icon32.png            Toolbar icon (32x32, RGBA PNG)
    icon48.png            Extension management icon (48x48, RGBA PNG)
    icon128.png           Store listing icon (128x128, RGBA PNG)
    icon16.svg            Source SVG (original, kept for reference)
    icon32.svg            Source SVG (original, kept for reference)
    icon48.svg            Source SVG (original, kept for reference)
    icon128.svg           Source SVG (original, kept for reference)
  scripts/
    generate-icons.mjs    Generates PNG icons (Node built-ins only, zero deps)
    package.mjs           Packages the extension into dist/graphvault-extension.zip
  dist/
    graphvault-extension.zip  Store-ready ZIP (produced by package.mjs)
  README.md               This file
```

## Design decisions

- **No build step.** The extension loads directly as-written vanilla JS. No
  bundler, no transpilation, no npm dependencies. This keeps the code small,
  auditable, and trivial to load unpacked.
- **Duplicate extraction logic.** `content.js` and `clipper.js` both contain
  the HTML-to-Markdown converter. `clipper.js` exists as a standalone version
  for unit testing and documentation; `content.js` is the live version. A
  future build step could deduplicate them via a shared module.
- **No eval / innerHTML in the extension pages.** The popup never renders
  untrusted HTML. The CSP in `manifest.json` enforces `script-src 'self'`.

---

## Icons

PNG icons at 16/32/48/128 px are generated by `scripts/generate-icons.mjs` using
only Node.js built-ins (no external deps, same zlib approach as the desktop/PWA
icon generators in `scripts/`).  The PNG format is required because Firefox does
not accept SVG files as toolbar action icons in Manifest V3.

To regenerate icons (e.g. after a brand colour change):

```bash
node apps/extension/scripts/generate-icons.mjs
```

---

## Packaging for store submission

Run the package script to produce a store-ready ZIP:

```bash
node apps/extension/scripts/package.mjs
```

This:
1. Regenerates PNG icons (`scripts/generate-icons.mjs`).
2. Validates `manifest.json` (valid JSON + all referenced files present).
3. Writes `apps/extension/dist/graphvault-extension.zip` using the STORE
   method (no compression) — fully inspectable, consistent with vault export.

The ZIP contains all extension source files except `scripts/`, `dist/`, and
the `.svg` source icons (replaced by the generated PNGs).

### Chrome Web Store submission

1. Log in to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole).
2. Click **New item** (or **Update** for an existing listing).
3. Upload `apps/extension/dist/graphvault-extension.zip`.
4. Fill in the store listing: description, screenshots, category
   (`Productivity`), privacy policy URL.
5. Set **Visibility** to `Public` (or `Private` for internal testing).
6. Submit for review. Chrome review usually takes 1–3 business days.

> The extension requests only: `activeTab`, `scripting`, `downloads`, `storage`.
> No host permissions, no remote code, no external network requests from the
> extension itself.  This minimal permission set speeds up review.

### Firefox Add-on (AMO) submission

1. Log in to [addons.mozilla.org](https://addons.mozilla.org/developers/).
2. Click **Submit a New Add-on** (or **Upload New Version** for updates).
3. Select **On this site** (listed) or **On your own** (unlisted/self-distribution).
4. Upload `apps/extension/dist/graphvault-extension.zip`.
5. Fill in the listing details. AMO requires source code for unlisted add-ons
   or when the reviewer requests it — the extension has no build step, so the
   ZIP *is* the source.
6. Firefox review may take several days for listed add-ons (faster for unlisted).

> The `browser_specific_settings.gecko.id` in `manifest.json`
> (`graphvault-clipper@graphvault.app`) is required for AMO submission and
> stable Firefox storage keys. Minimum supported Firefox version is 127.

### Edge Add-ons submission

Edge accepts the same Chrome-format ZIP:

1. Log in to the [Microsoft Edge Add-ons Developer Dashboard](https://partner.microsoft.com/dashboard/microsoftedge/overview).
2. Click **Create new extension**.
3. Upload `apps/extension/dist/graphvault-extension.zip`.
4. Complete the listing and submit. Edge review is typically 3–7 business days.
