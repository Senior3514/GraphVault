# GraphVault Quickstart

This guide takes you from zero to a working vault in five minutes. No account,
no server, and no folder picker required for the first steps - just open the
app and start writing.

## 1. Open the app

Navigate to the app (local dev at `http://localhost:3000`, or your Vercel URL).
The landing page loads immediately. Click **Open the app** or go directly to
`/vault`.

The vault opens with a set of sample notes pre-loaded. You do not need to
choose a folder or grant any file-system permissions - the vault is stored in
your browser.

> If you are running the app locally for the first time, follow the
> [local development quickstart](../README.md#quickstart) first, then return
> here.

## 2. Write a note

Click **+ New** in the note list (top left) or press **Cmd/Ctrl+K** → "Create
new note". Enter a path such as `my-first-note` (no extension needed) and press
Enter.

The editor opens with an empty note. Start typing in Markdown:

```markdown
# My First Note

This is a plain Markdown note. I can write **bold**, _italic_, and `code`.
```

The note saves automatically 400 ms after you stop typing. No save button
needed.

Toggle between **Edit**, **Split**, and **Preview** with the view buttons in
the toolbar, or press **Cmd/Ctrl+E** to toggle the preview pane.

## 3. Link notes with `[[`

Type `[[` anywhere in the editor to open the wikilink autocomplete. As you
type more characters, the list filters to matching note titles. Select a note
with arrow keys and press Enter (or Tab) to insert the link.

```markdown
This connects to [[My First Note]] and [[another note]].
```

If the target note does not exist, navigating to the link (in the preview pane)
creates it automatically.

In the **Preview** pane, `[[wikilinks]]` are clickable links that open the
target note. Inline `#tags` are also clickable and filter the note list to
notes that share that tag.

## 4. Tag notes

Add tags with inline `#hashtags` in the body or in YAML frontmatter:

```markdown
---
tags: [project, ideas]
---

# My Project Note

Status update #project #in-progress
```

Tags appear in the **Tags** panel in the sidebar (above the note list). Click
a tag to filter the list; click again to clear the filter.

Type `#` in the editor to open the **tag autocomplete**, which shows all tags
that exist in your vault.

## 5. Nest notes with a hierarchy (optional, CherryTree-style)

Wikilinks and the graph are one way to connect notes. GraphVault also
supports a second, independent way to organize them: explicit note-under-note
nesting, regardless of which folder a note lives in. Add a `parent:` field
to a note's frontmatter, pointing at another note's path or title:

```markdown
---
parent: Project
---

# Backend
```

In the sidebar's **Notes** pane, switch the **Folders / Hierarchy** toggle to
**Hierarchy** to see this tree instead of the folder view. A note with a
`parent` that doesn't match any note gets a small ⚠ instead of being hidden,
so a typo never silently loses your place in the tree.

## 6. Use the command palette

Press **Cmd/Ctrl+K** to open the command palette from any page in the app.

- Type to search by note title or body text.
- Arrow keys move the highlight; Enter runs the selected item; Esc closes.
- Built-in commands: Create new note, Go to Graph, Go to Vault, Go to Sync,
  Go to Settings, Toggle preview.

## 7. See the graph

Click **Graph** in the left sidebar (or press Cmd/Ctrl+K → "Go to Graph").

The graph shows every note as a node and every `[[wikilink]]` as an edge.

Things to try:

- **Hover** a node to highlight it and its direct neighbours.
- **Click** a node to open the node panel on the right (title, tags,
  backlinks, "Open note" button).
- **Double-click** a node to go straight to that note in the vault.
- **Local graph**: select a node, then click "Focus local" in the panel (or
  use the mode toggle at the top of the left controls) to zoom into the
  neighbourhood around that note.
- **Filters**: use the left panel to filter by tag, folder, or link type.
- **Physics controls**: adjust link distance, repel, gravity, and the label
  threshold to make the layout work for your vault size.
- **Zoom to fit**: click the "Fit" button to centre and scale the view.

## 8. Export your vault

Go to **Settings** → **Import & export**.

- **Export .zip (Markdown)** downloads a standard `.zip` archive of all your
  `.md` files with folder structure preserved. Unzip it and the notes are
  plain text - readable in any editor, importable into any Markdown app.
- **Export JSON** downloads a single versioned backup file.

Both exports run entirely in the browser; nothing is uploaded anywhere.

## 9. Import notes

In **Settings** → **Import & export**, click **Import…** and choose a file:

- A `.zip` exported from GraphVault (or any standard Markdown ZIP).
- A `.json` GraphVault backup file.
- A single `.md`, `.markdown`, or `.txt` file.

Import never overwrites existing notes. If an incoming note path conflicts with
a note that has different content, the imported version is saved alongside it
as a copy. You will see a summary: how many notes were added, how many were
kept as copies, and how many were identical (skipped).

## 10. Connect to a self-hosted sync server (optional)

This entire step is optional - GraphVault works fully offline with no account.
Only do this if you want to sync your notes across your own devices through a
server you host yourself. See [`deployment.md`](./deployment.md) for how to
run one.

Once the server is running, in **Settings** (under **Advanced → Self-hosted
sync & account**):

1. Enter the server URL under **Sync server** (e.g. `https://notes.example.com`),
   click **Test**, then **Save**.
2. Under **Sync account (self-hosted)**, click **Create account** (first time)
   or **Sign in**. This creates a login on _your_ server - there is no
   GraphVault cloud account.
3. Register your vault so the server can track it.

Go to **Sync Status** to check the server connection, run a manual sync, and
review any conflicts. Conflicts are never silently overwritten - the losing
side is saved alongside the winner as a conflict copy.

## 11. Install as an app (optional)

GraphVault runs as a standalone app on desktop and mobile, installed straight
from the browser - no app store, no download page required for this:

- **Desktop (Chrome/Edge):** an **Install** button appears near the address
  bar (or in the app's UI on the landing page). Click it - GraphVault opens in
  its own window with a Dock/taskbar icon, and works offline.
- **Mobile (iOS Safari):** tap **Share** → **Add to Home Screen**.
- **Mobile (Android Chrome):** tap the **Install** prompt, or menu → **Install
  app**.

This is the same app, not a separate download - your vault and settings carry
over automatically since it's the same origin.

## 12. Try the AI assistant (optional, off by default)

The assistant is fully opt-in. With it off (the default), GraphVault makes
**zero** network requests for AI. To try it, go to **Settings → Advanced → AI
assistant** and choose a privacy level: a local model (e.g. Ollama), your own
API key, or your self-hosted server as a gateway. Every request shows
you exactly what context it will send before it sends anything.

## Keyboard reference

| Shortcut       | Action                                  |
| -------------- | --------------------------------------- |
| Cmd/Ctrl+K     | Open command palette                    |
| Cmd/Ctrl+E     | Toggle editor preview pane              |
| `[[` in editor | Open wikilink autocomplete              |
| `#` in editor  | Open tag autocomplete                   |
| Arrow keys     | Navigate command palette / autocomplete |
| Enter          | Confirm selection                       |
| Esc            | Close palette / autocomplete            |
