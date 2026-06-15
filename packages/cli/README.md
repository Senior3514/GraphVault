# @graphvault/cli

Command-line interface for GraphVault vaults. Provides power-user / automation
access to a local vault directory of Markdown files, powered by
`@graphvault/engine`.

## Install

From the monorepo root, build once:

```sh
pnpm --filter @graphvault/cli build
```

Then link globally (optional):

```sh
cd packages/cli
npm link      # makes `graphvault` available on your PATH
```

Or run directly with Node:

```sh
node packages/cli/dist/index.js --help
```

## Usage

```
graphvault <command> [options]

Commands:
  list                  List all notes (path + title)
  search <query>        Search notes by title or content
  stats                 Show vault statistics
  graph [--json]        Print the link graph; --json for machine-readable output

Options:
  --vault <dir>         Vault directory (default: current working directory)
  --version             Print version
  --help                Show help
```

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
| `src/vault.ts`         | Filesystem reader — walks vault dir, returns NoteInput[]             |
| `src/format.ts`        | Human-readable output formatters (return strings, no IO)             |
| `src/index.ts`         | Entry point: parses args, calls vault reader + commands + formatters |
| `src/types.ts`         | Internal result types                                                |
| `src/commands.test.ts` | Unit tests for the pure command layer                                |

No third-party runtime dependencies — only `@graphvault/engine` (workspace) and
Node.js built-ins (`node:fs`, `node:path`, `node:util`).
