/**
 * Sample notes seeded into a fresh browser vault so the UI is immediately
 * usable (and demonstrates wikilinks, tags, frontmatter, and backlinks).
 *
 * Graph topology design:
 *   Hub notes: "Start Here", "Graph View", "Markdown & Wikilinks"
 *   Clusters (by tag):
 *     #getting-started  → Start Here, Keyboard Shortcuts, Command Palette
 *     #graph            → Graph View, Graph Tips, Understanding Clusters
 *     #writing          → Markdown & Wikilinks, Tags & Organisation, Daily Notes
 *     #sync             → Sync & Backups, Version History
 *     #ai               → AI Assistant (privacy-first)
 *   No orphans: every note links to at least one hub.
 */

import type { Note } from './types';

function note(path: string, content: string, ageMinutes: number): Note {
  const t = Date.now() - ageMinutes * 60_000;
  return { path, content, ctime: t, mtime: t };
}

export function seedNotes(): Note[] {
  return [
    // ------------------------------------------------------------------ //
    // Hub 1: Start Here - the entry point, links to everything
    // ------------------------------------------------------------------ //
    note(
      'Start Here.md',
      `---
title: Start Here
tags: [getting-started, meta]
---

# Start Here

Welcome to **GraphVault** - your local-first, plain-Markdown notebook.

Everything lives as \`.md\` files in your browser vault. There is no
proprietary database, no account required, and no lock-in.

## Five things to try right now

1. Press **Cmd K** (or Ctrl K) to open the [[Command Palette]] and jump to any note.
2. Click the graph icon in the sidebar to see how your notes connect in the [[Graph View]].
3. Type \`[[\` in the editor to link to another note - try linking to [[Markdown & Wikilinks]].
4. Add a \`#tag\` to this note and watch it appear in the graph clusters.
5. Open [[Sync & Backups]] to learn how to keep your notes safe.

## What makes GraphVault different

- **Your files.** Notes are plain Markdown - open them in any editor.
- **Self-hosted sync.** Run a small server you control; no third-party clouds.
- **A graph that thinks with you.** See [[Graph View]] for what that means.
- **Privacy-first AI.** Local or bring-your-own-key. See [[AI Assistant]].

#getting-started #meta
`,
      200,
    ),

    // ------------------------------------------------------------------ //
    // Hub 2: Graph View - links to Start Here, Graph Tips, Clusters
    // ------------------------------------------------------------------ //
    note(
      'notes/Graph View.md',
      `---
title: Graph View
tags: [graph, navigation]
---

# Graph View

The graph is a **live map** of your notes and the links between them. Every
wikilink you write (using double brackets) becomes an edge; every note is a node.

## Getting around

- **Click** a node to select it and see its backlinks and outgoing links.
- **Double-click** a node to open that note in the editor.
- Press **/** to search nodes without leaving the graph.
- Use the controls panel (left side) to switch between **global** and **local**
  neighbourhood views.

## Colour modes

| Mode       | What it shows                                      |
|------------|----------------------------------------------------|
| **Type**   | Note vs. tag vs. unresolved (missing) note         |
| **Tag**    | One colour per tag - great for seeing topic areas  |
| **Cluster**| Community detection - automatic groupings          |

Switch mode from the Graph Controls panel.

## Filters

Filter by tag, folder, or date range to focus on a slice of your vault.
Use the Timeline slider to scrub through notes by creation date.

See also: [[Graph Tips]], [[Understanding Clusters]], [[Start Here]].

#graph #navigation
`,
      180,
    ),

    // ------------------------------------------------------------------ //
    // Hub 3: Markdown & Wikilinks - links to Tags, Graph View, Daily Notes
    // ------------------------------------------------------------------ //
    note(
      'notes/Markdown & Wikilinks.md',
      `---
title: Markdown & Wikilinks
tags: [writing, markdown]
---

# Markdown & Wikilinks

GraphVault is **Markdown-first**. Your notes are plain \`.md\` files
readable in any text editor, now and in the future.

## Wikilinks

Link any two notes with double brackets - for example, type \`[[\` followed by
the note title. Autocomplete pops up as you type:

    See Graph View for the visual map of connections.

- Autocomplete pops up as you type \`[[\` - press Enter to insert.
- Links resolve by **title**, **filename**, or **path** (case-insensitive).
- Unresolved links (no matching note yet) appear as dashed nodes in the graph
  - click one to create the note.

## Aliases

Show different text while linking to the same note - add a pipe after the
target title. For example, linking to [[Graph View]] with the alias
"the knowledge graph" shows "the knowledge graph" as the link text.

## Frontmatter

Add structured data at the top of any note:

\`\`\`yaml
---
title: My Custom Title
tags: [idea, project]
date: 2025-01-15
---
\`\`\`

See [[Tags & Organisation]] for more on tags, and [[Daily Notes]] for a
daily-writing workflow.

#writing #markdown
`,
      160,
    ),

    // ------------------------------------------------------------------ //
    // Cluster: getting-started
    // ------------------------------------------------------------------ //
    note(
      'notes/Command Palette.md',
      `---
title: Command Palette
tags: [getting-started, navigation]
---

# Command Palette

Press **Cmd K** (Mac) or **Ctrl K** (Windows/Linux) from anywhere in the app.

## What you can do

- **Open a note** - start typing any part of its title.
- **Create a note** - type a name and press Enter to create.
- **Run a command** - navigate to the graph, open settings, toggle sidebar.
- **View backup history** - restore a previous version of any note.

The palette is always one keystroke away. Get used to it - it is the
fastest way to navigate a large vault.

See also: [[Keyboard Shortcuts]], [[Start Here]].

#getting-started #navigation
`,
      140,
    ),

    note(
      'notes/Keyboard Shortcuts.md',
      `---
title: Keyboard Shortcuts
tags: [getting-started, productivity]
---

# Keyboard Shortcuts

| Shortcut             | Action                              |
|----------------------|-------------------------------------|
| **Cmd K** / Ctrl K   | Open [[Command Palette]]            |
| **Cmd B** / Ctrl B   | Toggle sidebar                      |
| **Cmd E** / Ctrl E   | Toggle edit / preview mode          |
| **Esc**              | Close any open panel or dialog      |
| **/  (in graph)**    | Search nodes without leaving graph  |

## In the editor

| Shortcut        | Result                    |
|-----------------|---------------------------|
| Type \`[[\`     | Wikilink autocomplete     |
| Type \`#\`      | Tag autocomplete          |
| Tab / Shift-Tab | Indent / outdent list     |

All shortcuts work across keyboard layouts. On mobile, use the toolbar
buttons instead.

Return to [[Start Here]] for the getting-started overview.

#getting-started #productivity
`,
      120,
    ),

    // ------------------------------------------------------------------ //
    // Cluster: graph
    // ------------------------------------------------------------------ //
    note(
      'notes/Graph Tips.md',
      `---
title: Graph Tips
tags: [graph, productivity]
---

# Graph Tips

Tips for getting the most out of the [[Graph View]].

## Local vs. global view

Switch to **Local** mode (controls panel) when you want to focus on a
single note and its nearest neighbours. Set the depth (1-4) to control
how many hops out to show.

## Pinning nodes

Drag any node to pin it in place. A pin glyph appears. Click a pinned
node to unpin it. "Unpin all" is in the zoom controls (bottom-right).

## Physics tuning

Adjust repulsion, link distance, and gravity to untangle dense subgraphs.
"Reset physics" returns to defaults.

## Embedding a snapshot

Share a read-only interactive graph with the **Share** button (top-right
of the graph page). Only node titles and links travel in the URL - never
note content.

See also: [[Understanding Clusters]], [[Graph View]].

#graph #productivity
`,
      100,
    ),

    note(
      'notes/Understanding Clusters.md',
      `---
title: Understanding Clusters
tags: [graph, concept]
---

# Understanding Clusters

Switch the colour mode to **Cluster** (in the Graph Controls panel) to
let GraphVault detect communities in your vault automatically.

## How it works

Clusters are computed by finding **connected components** - groups of
notes that link to each other more than to the rest of the graph.
GraphVault uses a pure in-browser algorithm, so your notes never leave
the device.

## AI cluster naming

If you have enabled an AI provider in Settings, you can press
**Name clusters** to have the model suggest a label for each group.
Only note **titles** are sent - never the note body.

## Tips

- A note that appears isolated is an **orphan** (no links). Add a
  wikilink using double brackets to connect it.
- A note linking to many clusters acts as a **bridge** - look for
  these to find your most important notes.

See [[Graph View]], [[Graph Tips]], and [[AI Assistant]].

#graph #concept
`,
      80,
    ),

    // ------------------------------------------------------------------ //
    // Cluster: writing
    // ------------------------------------------------------------------ //
    note(
      'notes/Tags & Organisation.md',
      `---
title: Tags & Organisation
tags: [writing, organisation]
---

# Tags & Organisation

Tags are the lightest way to group notes across folders.

## Two ways to add tags

**Frontmatter** (structured):
\`\`\`yaml
---
tags: [project, idea, 2025]
---
\`\`\`

**Inline** (anywhere in the body):

\`\`\`
This is a quick thought. #idea #fleeting
\`\`\`

Both forms are indexed and appear in the [[Graph View]] tag filter.

## Folders vs. tags

Use **folders** for primary organisation (project, area, resource).
Use **tags** for cross-cutting themes that don't fit neatly into one folder.

Example structure:
\`\`\`
projects/
  website-redesign.md        #project #design
  api-migration.md           #project #engineering
resources/
  css-grid-cheatsheet.md     #reference #css
\`\`\`

See also: [[Markdown & Wikilinks]], [[Daily Notes]].

#writing #organisation
`,
      70,
    ),

    note(
      'notes/Daily Notes.md',
      `---
title: Daily Notes
tags: [writing, workflow]
---

# Daily Notes

A daily note is a quick capture space - one note per day, titled by date.

## A simple template

\`\`\`markdown
---
title: 2025-06-15
tags: [daily]
---

## Today

-

## Links & reading

-

## Tomorrow

-
\`\`\`

## Linking from daily notes

Daily notes shine as a **hub of the present** - link outward to long-lived
project notes, ideas, and reference material.

For example, you might write in a daily note:

    Worked on the website redesign today.
    Read through the CSS grid cheatsheet.
    Had a good conversation about [[Tags & Organisation]].

Over time, the graph reveals which projects and ideas dominate your days.

See [[Markdown & Wikilinks]] and [[Tags & Organisation]] for how to
enrich your notes.

#writing #workflow
`,
      60,
    ),

    // ------------------------------------------------------------------ //
    // Cluster: sync
    // ------------------------------------------------------------------ //
    note(
      'notes/Sync & Backups.md',
      `---
title: Sync & Backups
tags: [sync, backups]
---

# Sync & Backups

GraphVault syncs your notes to a **self-hosted server** you control.
There is no corporate cloud between you and your data.

## Setting up sync

1. Run the GraphVault server on any VPS or home server.
2. Open **Settings → Sync** and enter your server URL.
3. Register a device token - each device gets its own credential.
4. Press **Sync now**. Subsequent syncs are incremental.

## Conflict handling

GraphVault **never silently overwrites** a note. When two devices edit
the same note concurrently, both versions are preserved as conflict
copies and shown side-by-side for you to resolve.

## Automatic backups

The browser vault keeps point-in-time snapshots automatically. See
[[Version History]] to restore an older version of any note.

## Storage adapters

Beyond the self-hosted server, GraphVault also supports:

- **WebDAV** - any WebDAV-compatible server (Nextcloud, etc.)
- **S3-compatible** - Backblaze B2, Cloudflare R2, MinIO, etc.

Start at [[Start Here]] for the full getting-started guide.

#sync #backups
`,
      50,
    ),

    note(
      'notes/Version History.md',
      `---
title: Version History
tags: [sync, backups]
---

# Version History

Every time you edit a note, GraphVault keeps a snapshot of the previous
version in your browser's local storage.

## Restoring a version

1. Press **Cmd K** → type "backup" → select **View backup history**.
2. Choose any past version from the timeline.
3. Click **Restore** to replace the current note with that snapshot.

## How long versions are kept

- Up to **50 snapshots** per note are retained locally.
- Older snapshots are pruned automatically, oldest first.

## Sync and version history

Versions captured locally are separate from server-side sync history.
The [[Sync & Backups]] page explains how the server handles conflicts.

#sync #backups
`,
      40,
    ),

    // ------------------------------------------------------------------ //
    // Cluster: ai
    // ------------------------------------------------------------------ //
    note(
      'notes/AI Assistant.md',
      `---
title: AI Assistant
tags: [ai, privacy]
---

# AI Assistant

GraphVault includes a **privacy-first AI assistant** - off by default,
always opt-in.

## How to enable it

Go to **Settings → AI** and choose a provider:

| Option              | Privacy level                                         |
|---------------------|-------------------------------------------------------|
| **Off** (default)   | No AI requests ever leave the device                  |
| **Local model**     | Runs entirely on your machine - fully private          |
| **Bring your own key** | Your API key, sent directly to the provider, never via GraphVault servers |

## What the assistant can do

- Answer questions about a note you are reading.
- Summarise the current note or suggest tags.
- Name [[Understanding Clusters|graph clusters]] from note titles only
  (note bodies are never sent).

## Privacy guarantee

GraphVault **never relays your note content** through its own servers.
When a cloud provider is used, the request goes directly from your
browser to the provider's API over HTTPS. You can audit this in
DevTools → Network.

See [[Start Here]] for the full overview.

#ai #privacy
`,
      30,
    ),
  ];
}
