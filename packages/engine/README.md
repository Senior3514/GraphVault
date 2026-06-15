# @graphvault/engine

The GraphVault **graph engine**: a pure, dependency-light TypeScript library
that turns a set of Markdown notes into a navigable graph (nodes, directed
edges, backlinks) and exposes a small, renderer-agnostic query API.

It is intentionally **framework-free and filesystem-free**:

- No React, no DOM, no `node:fs`.
- The host application walks the vault and feeds note **content** in as plain
  data; the engine never touches the disk.
- Outputs are plain `{ nodes, edges, truncated }` objects suitable for any
  renderer (force-directed React graph, Cytoscape, server JSON, …).

This keeps the engine reusable across the web client, desktop client, and
server (see `CLAUDE.md` — "keep the engine decoupled from the UI").

## Install

Within the monorepo it is a workspace package:

```jsonc
// some other package.json
"dependencies": { "@graphvault/engine": "workspace:*" }
```

## Pipeline

```
NoteInput[]  ──parseNote──▶  ParsedNote   (title, frontmatter, tags, links)
             ──buildIndex─▶  GraphIndex   (nodes, edges, outbound, backlinks)
                            ──getGraph / getLocalGraph / filterGraph──▶ GraphPayload
```

## Quick start

```ts
import { buildIndex, getGraph, getLocalGraph, filterGraph } from '@graphvault/engine';

const index = buildIndex([
  { path: 'notes/a.md', content: '# Alpha\nlinks to [[Beta]] #project', updatedAt: 100 },
  { path: 'notes/beta.md', content: '# Beta\nsee [Alpha](a.md)', updatedAt: 200 },
]);

getGraph(index);                      // whole graph (capped, with truncation flag)
getLocalGraph(index, 'notes/a.md', 1); // 1-hop neighbourhood around a note
filterGraph(index, { tags: ['project'] });
```

## Public API

### Parsing

- `parseNote(path, content): ParsedNote` — extract title, frontmatter, tags and
  outbound links from one note.
- `splitFrontmatter(content): { frontmatter, frontmatterRaw, body }`.

### Index

- `buildIndex(notes: NoteInput[]): GraphIndex` — parse all notes, resolve links,
  compute backlinks. Deterministic and pure.
- `getOutbound(index, noteId): GraphEdge[]`
- `getBacklinks(index, noteId): GraphEdge[]` — resolved inbound edges.

### Graph queries (all return `GraphPayload = { nodes, edges, truncated }`)

- `getGraph(index, { nodeCap?, includeUnresolved? })` — the full graph, capped
  at `nodeCap` nodes (default `DEFAULT_NODE_CAP = 2000`). `truncated` is `true`
  when the cap dropped nodes. Unresolved (missing-target) edges are excluded
  unless `includeUnresolved` is set.
- `getLocalGraph(index, noteId, depth, { includeBacklinks?, includeUnresolved? })`
  — BFS subgraph around `noteId` out to `depth` hops. Depth `0` is the note
  alone; depth `1` adds direct neighbours. Traversal follows outbound links and
  (by default) resolved backlinks. Unknown `noteId` returns an empty payload.
- `filterGraph(index, criteria)` — filter nodes by `tags`, `folders`,
  `updatedFrom`/`updatedTo` (epoch ms), and edges by `linkTypes`. All criteria
  are AND-combined. Also honours `nodeCap` and `includeUnresolved`.

In every payload, edges are kept only when **both endpoints are present** in the
returned node set (and, for unresolved edges, only when `includeUnresolved` is
requested).

## Data shapes

See `src/types.ts` for the authoritative definitions. The key ones:

```ts
interface NoteInput {
  path: FilePath;       // vault-relative POSIX path, from @graphvault/shared
  content: string;      // raw markdown
  createdAt?: number;   // epoch ms
  updatedAt?: number;   // epoch ms
}

interface GraphNode {
  id: string;           // == path in v0
  path: FilePath;
  title: string;
  tags: string[];
  folder: string;       // '' for the vault root
  createdAt?: number;
  updatedAt?: number;
}

interface GraphEdge {
  source: string;       // note id
  target: string;       // note id when resolved, else the raw link text
  type: LinkType;       // 'wikilink' | 'markdown' | <relation-name>
  resolved: boolean;
  heading?: string;     // anchor within the target, if specified
  alias?: string;       // display text, if specified
}
```

## Link, tag & relation syntax

### Title resolution

`frontmatter.title` → first `# H1` → filename (without extension).

### Tags

- Inline `#tag` anywhere in the body. Tags must start with a letter and may
  contain letters, digits, `_`, `-`, and `/` (for nested tags like
  `#area/topic`). A `#` in the middle of a word (e.g. `C#`, `issue#42`) is not a
  tag.
- Frontmatter `tags:` as a list (`[a, b]` or block list) or a single string.
- Tags are de-duplicated and stored without the leading `#`.

### Wikilinks

```
[[Target]]
[[Target#Heading]]
[[Target|Display alias]]
[[Target#Heading|Display alias]]
```

The canonical order is **`#heading` before `|alias`** (matching Obsidian). The
`target` resolves by path, basename, or title (see resolution rules below).

### Standard Markdown links

```
[Display](relative/path.md)
[Display](../other.md#heading)
```

- Resolved relative to the linking note's folder, then as a vault-relative path.
- External links (`http:`, `https:`, `mailto:`, protocol-relative `//…`),
  images (`![alt](…)`), and pure in-page anchors (`[x](#heading)`) are ignored.
- A missing `.md` extension is tolerated when resolving.

### Typed relations (frontmatter)

Declare semantic edges in frontmatter under a `relations:` map. Each key becomes
the edge `type`; values may be bare targets or `[[wikilinks]]`:

```yaml
---
relations:
  references:
    - [[Note X]]
    - notes/y.md
  refutes: [[Claim B]]
---
```

This yields edges of type `references` and `refutes` from the current note to
the resolved targets.

### Link resolution rules (most specific first)

1. Exact vault-relative path (with or without `.md`).
2. Path relative to the source note's folder.
3. Basename match (filename without extension), case-insensitive.
4. Title match, case-insensitive.

Ambiguous basename/title matches resolve deterministically (lowest id wins).
Links that resolve to nothing are kept as edges with `resolved: false` and the
raw target text preserved, so the host can surface "missing note" affordances.

## Frontmatter YAML subset

To stay dependency-light the engine ships a small, forgiving YAML parser rather
than a full YAML implementation. It supports what note frontmatter needs:

- `key: scalar` — strings, integers, floats, `true`/`false`, `null`/`~`.
- Quoted scalars (`'…'`, `"…"`).
- Flow lists: `key: [a, b, c]`.
- Block lists:
  ```yaml
  key:
    - a
    - b
  ```
- One level of nested maps (used for `relations:`).
- `# comments` (outside quotes).

Anything beyond this (anchors, multi-line scalars, deep nesting) is out of scope
for v0; such notes still parse — unsupported lines are simply skipped.

## Scripts

```bash
pnpm --filter @graphvault/engine build      # tsc -b
pnpm --filter @graphvault/engine typecheck  # tsc -b --noEmit
pnpm --filter @graphvault/engine test       # node:test via tsx
pnpm --filter @graphvault/engine clean
```
