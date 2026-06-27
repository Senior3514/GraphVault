# @graphvault/mcp

A standalone **stdio [Model Context Protocol](https://modelcontextprotocol.io)
server** that exposes a self-hosted GraphVault vault to external agents (for
example, Claude Desktop). The **read** tools are always available; **conflict-safe
write** tools are enabled only when a device id is configured.

> **Data safety:** the read tools can only explore your vault - list, read,
> search, traverse the link graph. The write tools are **off by default** and
> are registered only when `GRAPHVAULT_DEVICE_ID` is set. Every write is
> **conflict-safe**: it uploads content by hash and pushes with the file's
> current server revision as its base, so a concurrent edit is reported as a
> conflict and **never silently overwritten**. The bearer token and device id
> are read from the environment only and are never written to logs or stdout.

## Tools

### Read-only (always available)

| Tool              | Input              | Returns                                                     |
| ----------------- | ------------------ | ----------------------------------------------------------- |
| `list_notes`      | `query?`, `limit?` | `[{ path, title, tags }]` (optional path/title substring)   |
| `read_note`       | `path`             | raw Markdown content                                        |
| `search_notes`    | `query`, `limit?`  | notes matching title/tags/links/body, with `matched` fields |
| `get_backlinks`   | `path`             | notes that link to `path`                                   |
| `graph_neighbors` | `path`, `depth?`   | local subgraph (`nodes`, `edges`) within `depth` hops       |
| `vault_stats`     | -                  | `{ notes, tags, links, unresolved, writesEnabled }`         |

### Write (only when `GRAPHVAULT_DEVICE_ID` is set)

| Tool             | Input                              | Behavior                                                                                                  |
| ---------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `create_note`    | `path`, `content`                  | Create a note; **fails if one already exists** at `path` (no clobber).                                    |
| `update_note`    | `path`, `content`, `expectedHash?` | Replace an existing note; with `expectedHash`, fails if the server hash differs (optimistic concurrency). |
| `append_to_note` | `path`, `content`                  | Read-modify-write: append `content` (newline-separated) to an existing note.                              |
| `delete_note`    | `path`                             | Tombstone an existing note.                                                                               |

All write paths must be vault-relative (no `/`, `.`, or `..` segments) and end
in `.md`/`.markdown`. On a conflict the tool returns a clear error naming the
conflict kind (`STALE_BASE` / `CONTENT_CONFLICT` / `DELETE_EDIT_CONFLICT` /
`MISSING_BLOB`) and instructs the agent to re-read and retry - it never retries
blindly. After a successful write the index cache is invalidated so later reads
reflect the change.

Search and graph are powered by `@graphvault/engine`; markdown parsing is not
reimplemented here. The vault is loaded once and cached with a short TTL
(`GRAPHVAULT_INDEX_TTL_MS`, default 30s), so recent edits become visible to
agents without restarting the server.

## Resources

Every note is also exposed as an MCP **resource** so hosts like Claude Desktop
can browse and attach notes natively (instead of only via the `read_note` tool).
Resources are **read-only** and always available.

- **URI scheme:** `graphvault://note/<vault-relative-path>`, where each path
  segment is percent-encoded so slashes separate path levels and characters like
  spaces or `#` round-trip safely - e.g. `notes/graph theory.md` becomes
  `graphvault://note/notes/graph%20theory.md`.
- **List:** enumerates every note in the cached vault index, each with its `uri`,
  `name` (the vault-relative path), `title`, and `mimeType: text/markdown`.
- **Read:** returns the note's raw Markdown as the resource contents
  (`mimeType: text/markdown`). The path is validated from the URI - traversal
  (`..`), absolute, and non-note URIs are rejected, and an unknown note returns a
  clear not-found error.

Resources share the same TTL-cached snapshot as the tools, so they reflect recent
edits.

## Prompts

A few ready-made, parameterized **prompt templates** pull real vault context so a
host can one-click a useful workflow. All are read-only and always available.

| Prompt                  | Args    | Builds a prompt that…                                                                                        |
| ----------------------- | ------- | ------------------------------------------------------------------------------------------------------------ |
| `summarize_note`        | `path`  | embeds the note's Markdown and asks for a concise summary with key takeaways.                                |
| `find_connections`      | `path`  | embeds the note plus its backlinks and 1-hop neighbors, and asks for related notes and likely missing links. |
| `search_and_synthesize` | `query` | searches the vault, embeds the top matching notes, and asks for a synthesis with citations to note paths.    |

Each prompt reuses the existing read/graph helpers to fetch context (no duplicate
fetching) and errors cleanly when given an unknown note path.

In Claude Desktop, resources appear in the attachment/resource picker and prompts
appear as one-click slash commands once the server is connected.

## Configuration

All configuration comes from environment variables (see `.env.example`):

| Variable                  | Required | Description                                                       |
| ------------------------- | -------- | ----------------------------------------------------------------- |
| `GRAPHVAULT_SERVER_URL`   | yes      | Base URL of your GraphVault server.                               |
| `GRAPHVAULT_TOKEN`        | yes      | Bearer token (kept secret; never logged).                         |
| `GRAPHVAULT_VAULT_ID`     | one of   | The vault id to expose.                                           |
| `GRAPHVAULT_VAULT_NAME`   | one of   | Resolve the id by name via `GET /v1/vaults` (when no id given).   |
| `GRAPHVAULT_DEVICE_ID`    | writes   | Device id bound to the token; **required to enable write tools**. |
| `GRAPHVAULT_INDEX_TTL_MS` | no       | Index cache TTL in ms (default `30000`).                          |

You must provide either `GRAPHVAULT_VAULT_ID` or `GRAPHVAULT_VAULT_NAME`. The
server validates the environment with zod at startup and exits with a clear,
secret-free message if anything is missing.

`GRAPHVAULT_DEVICE_ID` is optional: without it the server is strictly read-only
(the write tools are not registered). With it, the conflict-safe write tools are
enabled. The push endpoint requires the device id that the token is bound to, so
this must match a device registered for `GRAPHVAULT_TOKEN`.

## Running

```bash
# From a built checkout:
pnpm --filter @graphvault/mcp build

GRAPHVAULT_SERVER_URL=https://vault.example.com \
GRAPHVAULT_TOKEN=your-token \
GRAPHVAULT_VAULT_ID=your-vault-id \
  node packages/mcp/dist/index.js
```

The process speaks MCP over stdio; all diagnostics go to **stderr** so they
never corrupt the protocol stream on stdout.

## Claude Desktop configuration

Add an entry to your Claude Desktop MCP config
(`claude_desktop_config.json` - on macOS at
`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "graphvault": {
      "command": "node",
      "args": ["/absolute/path/to/GraphVault/packages/mcp/dist/index.js"],
      "env": {
        "GRAPHVAULT_SERVER_URL": "https://vault.example.com",
        "GRAPHVAULT_TOKEN": "your-token",
        "GRAPHVAULT_VAULT_ID": "your-vault-id"
      }
    }
  }
}
```

To also enable the conflict-safe write tools, add `GRAPHVAULT_DEVICE_ID` (the
device id bound to your token) to the `env` block above. Without it, only the
read tools are registered.

If the package is installed globally (it exposes a `graphvault-mcp` bin), you
can instead use `"command": "graphvault-mcp"` with no `args`.

Restart Claude Desktop; the GraphVault tools appear in the tool picker, your
notes appear as attachable **resources**, and the **prompts** above appear as
one-click commands.

## Development

```bash
pnpm --filter @graphvault/mcp build      # tsc -b
pnpm --filter @graphvault/mcp typecheck  # tsc -b
pnpm --filter @graphvault/mcp test       # tsx --test
```

Tests cover the HTTP client against a stubbed `fetch`, every read handler
against an in-memory set of notes, the write handlers against an in-memory
fake server (hash computation, no-clobber create, missing-note rejection,
`expectedHash` mismatch, append read-modify-write, delete tombstone, conflict
surfaced as an error, and writes-disabled), the resource handlers (URI
round-trip, list enumeration, read content + mimeType, traversal/unknown URI
rejection), and the prompt builders (each embeds the expected note context;
unknown path errors cleanly) - no network or live server required.
