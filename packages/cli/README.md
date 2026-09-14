# @graphvault/cli

Command-line interface for GraphVault vaults. Provides power-user / automation
access to a local vault directory of Markdown files, powered by
`@graphvault/engine`. Also includes `codegraph`, a general-purpose source-code
import-graph scanner - not Markdown-specific, useful on any JS/TS repo
(including this one).

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
  codegraph [--json]    Scan a source tree (not Markdown) and print its
    [--dependencies p]  import graph (file -> file). --dependencies/--dependents
    [--dependents p]    print just one file's imports / importers.
  serve [--host h]      Start a local, READ-ONLY HTTP API over the vault
        [--port n]      (default: http://127.0.0.1:4111, loopback only)

Options:
  --vault <dir>         Vault / source directory (default: current working directory)
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

# Scan a source-code directory and print its import graph - useful for an AI
# coding agent (or you) to see what a file depends on / what depends on it
# without reading every file in the tree first. Not Markdown-specific.
graphvault codegraph --vault ~/code/my-project

# Machine-readable, e.g. to feed into another tool
graphvault codegraph --json --vault . > codegraph.json

# "What imports this file?" / "What does this file import?"
graphvault codegraph --dependents src/index.ts --vault .
graphvault codegraph --dependencies src/index.ts --vault .
```

`codegraph` is static-analysis only (regex-extracted `import`/`require`
specifiers, not a real parser) - it resolves relative imports (including the
TypeScript-ESM `./foo.js` → `foo.ts` convention) but does not follow bare
package specifiers (`react`, `lodash`, ...) past the package name itself. It
scans `.ts`/`.tsx`/`.js`/`.jsx`/`.mjs`/`.cjs` files, skipping `node_modules`,
`dist`, `build`, `out`, `.next`, `target`, `coverage`, `.turbo`, `.cache`, and
`.git`.

## Development

```sh
pnpm --filter @graphvault/cli build      # compile TypeScript
pnpm --filter @graphvault/cli typecheck  # type-check only
pnpm --filter @graphvault/cli test       # run unit tests
pnpm --filter @graphvault/cli clean      # remove dist/
```

## Architecture

| File                   | Role                                                                             |
| ---------------------- | -------------------------------------------------------------------------------- |
| `src/commands.ts`      | Pure, IO-free command logic (testable with node:test)                            |
| `src/vault.ts`         | Filesystem reader - walks vault dir, returns NoteInput[]                         |
| `src/codeGraph.ts`     | Filesystem reader for `codegraph` - walks a source tree, returns CodeFileInput[] |
| `src/server.ts`        | `serve`: read-only (GET-only) HTTP API, loopback-bound by default                |
| `src/format.ts`        | Human-readable output formatters (return strings, no IO)                         |
| `src/index.ts`         | Entry point: parses args, calls vault reader + commands + formatters             |
| `src/types.ts`         | Internal result types                                                            |
| `src/commands.test.ts` | Unit tests for the pure command layer                                            |

No third-party runtime dependencies - only `@graphvault/engine` (workspace) and
Node.js built-ins (`node:fs`, `node:path`, `node:util`).
