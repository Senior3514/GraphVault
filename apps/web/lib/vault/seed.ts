/**
 * Sample notes seeded into a fresh browser vault so the UI is immediately
 * usable (and demonstrates wikilinks, tags, frontmatter, and backlinks).
 */

import type { Note } from './types';

function note(path: string, content: string, ageMinutes: number): Note {
  const t = Date.now() - ageMinutes * 60_000;
  return { path, content, ctime: t, mtime: t };
}

export function seedNotes(): Note[] {
  return [
    note(
      'welcome.md',
      `---
title: Welcome to GraphVault
tags: [meta, intro]
---

# Welcome to GraphVault

This is a **local-first** Markdown vault. Your notes are plain \`.md\` files.

Try these:

- Open [[Graph view ideas]] to see a linked note.
- Browse the [[Sync overview]].
- Everything here is editable; changes autosave to your browser.

Inline tags work too: #intro #getting-started
`,
      120,
    ),
    note(
      'notes/graph-view-ideas.md',
      `---
title: Graph view ideas
tags: [graph, design]
---

# Graph view ideas

The graph should be *usable for thinking*, not a hairball. See [[Welcome to GraphVault]]
for the project intro and [[Sync overview]] for how notes travel between devices.

Ideas:

- Local graph around the current note with configurable depth.
- Filters by #tags and folders.
- Radial + force-directed layouts.
`,
      60,
    ),
    note(
      'notes/sync-overview.md',
      `---
title: Sync overview
tags: [sync, architecture]
---

# Sync overview

GraphVault syncs whole files by content hash through a self-hosted server.
Conflicts are preserved as side-by-side copies — never silently lost.

Related: [[Graph view ideas]].

#sync #architecture
`,
      30,
    ),
    note(
      'scratch.md',
      `# Scratchpad

A place for quick thoughts. Link anything with [[double brackets]].

- [ ] Try the split preview (toggle with the preview button).
- [ ] Search across notes from the top bar.
`,
      5,
    ),
  ];
}
