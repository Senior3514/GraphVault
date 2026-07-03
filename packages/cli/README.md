# @graphvault/cli

Command-line interface for GraphVault vaults. Provides power-user / automation
access to a local vault directory of Markdown files, powered by
`@graphvault/engine`.

> **Package status:** this package is publish-ready but not yet published to
> the npm registry, so the `npx @graphvault/cli` command below will work once
> it is. Until then, use the "From a local checkout" instructions.

## Install

```sh
npx @graphvault/cli --help
```

No install step - `npx` fetches and runs it. To use the `graphvault` command
without the `npx` prefix, install it globally:

```sh
npm install -g @graphvault/cli
graphvault --help
```

### From a local checkout (contributors)

```sh
pnpm --filter @graphvault/cli build
node packages/cli/dist/index.js --help
# or: cd packages/cli && npm link
```

## Usage

```
graphvault <command> [options]

Commands:
  list                  List all notes (path + title)
  search <query>        Search notes by title or content
  stats                 Show vault statistics
  graph [--json]        Print the link graph; --json for machine-readable output
  serve [--host h]      Start a local, READ-ONLY HTTP API over the vault
        [--port n]      (default: http://127.0.0.1:4111, loopback only)

Options:
  --vault <dir>         Vault directory (default: current working directory)
  --host <host>         serve: bind host (default: 127.0.0.1; loopback only)
  --port <port>         serve: bind port (default: 4111)
  --version             Print version
  --help                Show help
```

> `serve` exposes a **read-only (GET-only)** HTTP API over the vault and binds
> to `127.0.0.1` (localhost) by default. It is intended for local tooling and
> integrations; there is no authentication, so binding to a non-loopback
> `--host` exposes your notes to anyone who can reach that address - only do so
> on a trusted network. It runs until interrupted (Ctrl-C).

### Examples

```sh
# List all notes in ~/notes
graphvault list --vault ~/notes

# Search for "graph engine" across titles and content
graphvault search "graph engine" --vault ~/notes

# Show vault statistics
graphvault stats --vault ~/notes

# Print the graph as human-readable text
graphvault graph --vault ~/notes

# Machine-readable JSON graph (pipe to jq, etc.)
graphvault graph --json --vault ~/notes | jq '.nodes | length'

# Serve a local read-only HTTP API over the vault (loopback only)
graphvault serve --vault ~/notes --port 4111
```

## Development

```sh
pnpm --filter @graphvault/cli build      # compile TypeScript
pnpm --filter @graphvault/cli typecheck  # type-check only
pnpm --filter @graphvault/cli test       # run unit tests
pnpm --filter @graphvault/cli clean      # remove dist/
```

## Architecture

| File                   | Role                                                                 |
| ---------------------- | -------------------------------------------------------------------- |
| `src/commands.ts`      | Pure, IO-free command logic (testable with node:test)                |
| `src/vault.ts`         | Filesystem reader - walks vault dir, returns NoteInput[]             |
| `src/server.ts`        | `serve`: read-only (GET-only) HTTP API, loopback-bound by default    |
| `src/format.ts`        | Human-readable output formatters (return strings, no IO)             |
| `src/index.ts`         | Entry point: parses args, calls vault reader + commands + formatters |
| `src/types.ts`         | Internal result types                                                |
| `src/commands.test.ts` | Unit tests for the pure command layer                                |

No third-party runtime dependencies - only `@graphvault/engine` (workspace) and
Node.js built-ins (`node:fs`, `node:path`, `node:util`).
