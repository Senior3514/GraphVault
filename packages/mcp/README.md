# @graphvault/mcp

A standalone **stdio [Model Context Protocol](https://modelcontextprotocol.io)
server** that exposes a self-hosted GraphVault vault to external agents (for
example, Claude Desktop) over a set of **read-only** tools.

> **Data safety:** this server exposes _no_ write or delete tools. An agent can
> explore your vault — list, read, search, traverse the link graph — but can
> never modify it. The bearer token is read from the environment only and is
> never written to logs or stdout.

## Tools

| Tool              | Input              | Returns                                                     |
| ----------------- | ------------------ | ----------------------------------------------------------- |
| `list_notes`      | `query?`, `limit?` | `[{ path, title, tags }]` (optional path/title substring)   |
| `read_note`       | `path`             | raw Markdown content                                        |
| `search_notes`    | `query`, `limit?`  | notes matching title/tags/links/body, with `matched` fields |
| `get_backlinks`   | `path`             | notes that link to `path`                                   |
| `graph_neighbors` | `path`, `depth?`   | local subgraph (`nodes`, `edges`) within `depth` hops       |
| `vault_stats`     | —                  | `{ notes, tags, links, unresolved }`                        |

Search and graph are powered by `@graphvault/engine`; markdown parsing is not
reimplemented here. The vault is loaded once and cached with a short TTL
(`GRAPHVAULT_INDEX_TTL_MS`, default 30s), so recent edits become visible to
agents without restarting the server.

## Configuration

All configuration comes from environment variables (see `.env.example`):

| Variable                  | Required | Description                                                     |
| ------------------------- | -------- | --------------------------------------------------------------- |
| `GRAPHVAULT_SERVER_URL`   | yes      | Base URL of your GraphVault server.                             |
| `GRAPHVAULT_TOKEN`        | yes      | Bearer token (kept secret; never logged).                       |
| `GRAPHVAULT_VAULT_ID`     | one of   | The vault id to expose.                                         |
| `GRAPHVAULT_VAULT_NAME`   | one of   | Resolve the id by name via `GET /v1/vaults` (when no id given). |
| `GRAPHVAULT_INDEX_TTL_MS` | no       | Index cache TTL in ms (default `30000`).                        |

You must provide either `GRAPHVAULT_VAULT_ID` or `GRAPHVAULT_VAULT_NAME`. The
server validates the environment with zod at startup and exits with a clear,
secret-free message if anything is missing.

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
(`claude_desktop_config.json` — on macOS at
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

If the package is installed globally (it exposes a `graphvault-mcp` bin), you
can instead use `"command": "graphvault-mcp"` with no `args`.

Restart Claude Desktop; the GraphVault tools will appear in the tool picker.

## Development

```bash
pnpm --filter @graphvault/mcp build      # tsc -b
pnpm --filter @graphvault/mcp typecheck  # tsc -b
pnpm --filter @graphvault/mcp test       # tsx --test
```

Tests cover the HTTP client against a stubbed `fetch` and every tool handler
against an in-memory set of notes — no network or live server required.
