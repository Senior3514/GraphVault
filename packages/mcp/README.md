# @graphvault/mcp

A **stdio MCP (Model Context Protocol) server** that exposes a GraphVault
vault directory to Claude Desktop and any other MCP-compatible AI client.
Zero third-party runtime dependencies — only `@graphvault/engine` (workspace)
and Node.js built-ins.

## Protocol

Uses **Content-Length-framed JSON-RPC 2.0** over stdin/stdout (the same
framing as the Language Server Protocol, which MCP inherited):

```
Content-Length: <byte-length>\r\n
\r\n
<UTF-8 JSON body>
```

Methods implemented: `initialize`, `tools/list`, `tools/call`,
`resources/list`, `resources/read`, `ping`.

## Tools

| Tool                            | Description                                                   |
| ------------------------------- | ------------------------------------------------------------- |
| `list_notes`                    | List all notes (path, title, tags) sorted by path             |
| `search_notes(query)`           | Case-insensitive title + content search with context snippets |
| `get_note(path)`                | Full content + metadata for a note by vault-relative path     |
| `graph_neighbors(path, depth?)` | BFS neighbors (outbound links + backlinks) up to depth 3      |
| `get_stats()`                   | Note count, link counts, tag count, top tags, orphan notes    |

## Resources

Every note is exposed as a resource:

```
graphvault://note/<vault-relative-path>
```

MIME type: `text/markdown`.

## Installation

```bash
# From the monorepo root, after pnpm install:
pnpm --filter @graphvault/mcp build

# The binary is at packages/mcp/dist/index.js
# Or install globally via pnpm:
pnpm add -g @graphvault/mcp   # when published
```

## Usage

```bash
# Point at a vault directory:
graphvault-mcp --vault ~/notes

# Or via environment variable:
GRAPHVAULT_VAULT=~/notes graphvault-mcp
```

The server logs to stderr and listens for MCP messages on stdin/stdout.

## Wiring into Claude Desktop

Add this to your Claude Desktop configuration file
(`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS,
`%APPDATA%\Claude\claude_desktop_config.json` on Windows):

```json
{
  "mcpServers": {
    "graphvault": {
      "command": "node",
      "args": ["/absolute/path/to/packages/mcp/dist/index.js", "--vault", "/path/to/your/vault"],
      "env": {}
    }
  }
}
```

If you have installed the package globally (`npm install -g @graphvault/mcp`
or equivalent), you can use the binary directly:

```json
{
  "mcpServers": {
    "graphvault": {
      "command": "graphvault-mcp",
      "args": ["--vault", "/path/to/your/vault"],
      "env": {
        "GRAPHVAULT_VAULT": "/path/to/your/vault"
      }
    }
  }
}
```

Restart Claude Desktop after editing the config.

## Example MCP client interaction

```jsonc
// Client → Server (initialize)
Content-Length: 87\r\n\r\n
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05"}}

// Server → Client
Content-Length: 165\r\n\r\n
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","serverInfo":{"name":"@graphvault/mcp","version":"0.0.0"},"capabilities":{"tools":{},"resources":{}}}}

// Client → Server (tools/call)
Content-Length: 57\r\n\r\n
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"list_notes"}}

// Server → Client
Content-Length: <N>\r\n\r\n
{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"[{\"path\":\"ideas/graph.md\",\"title\":\"Graph ideas\",\"tags\":[\"graph\"]}]"}]}}
```

## Building and testing

```bash
# From the monorepo root:
pnpm --filter @graphvault/mcp build
pnpm --filter @graphvault/mcp typecheck
pnpm --filter @graphvault/mcp test
```

## Lockfile note

Running `pnpm install` at the monorepo root after adding this package will
register `@graphvault/mcp` and regenerate `pnpm-lock.yaml`. The integrator
must run this step centrally — worktree agents do not commit the lockfile.
