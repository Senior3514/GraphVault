# Publishing @graphvault/mcp and @graphvault/cli to npm

This document describes the one remaining manual step to make GraphVault's
MCP server and CLI installable with a single `npx` command - the same
frictionless install path that community MCP servers (including the ones
people use to connect Claude to Obsidian) rely on.

## Why this matters

Claude does not have a built-in, native integration with Obsidian or any other
note app. What people call "connecting Claude to Obsidian" is a community MCP
server, configured manually in `claude_desktop_config.json`, published to npm
so it's installable with `npx <package>` instead of a manual clone-and-build.

GraphVault already has an equivalent (and more capable - it also has
conflict-safe write tools, note resources, and prompt templates) MCP server at
[`packages/mcp`](../packages/mcp). The only gap is that it has never been
published, so today it requires a manual clone + `pnpm build`. Publishing
closes that gap.

## Prerequisites

- An npm account with publish rights to the `@graphvault` scope (the scope is
  currently unclaimed - the first `npm publish` under it claims it).
- CI/local gauntlet green on the commit you're publishing from.
- Node 22+ and pnpm, from a clean checkout.

## What's already prepared

`packages/shared`, `packages/engine`, `packages/mcp`, and `packages/cli` all
have `private` removed and carry proper `description`, `license`,
`repository`, `keywords`, a `files` allowlist (`dist` + `README.md` only - no
source or tests ship), and `publishConfig.access: "public"` (required for a
scoped package to publish publicly on the free tier).

`@graphvault/mcp` and `@graphvault/cli` depend on `@graphvault/shared` and
`@graphvault/engine` via the `workspace:*` protocol. pnpm rewrites these to
the real published version automatically at publish time - no manual version
pinning needed, as long as all four are published together (see below).

## Publishing

From the repo root, logged in to npm (`npm login`) as an account with rights
to the `@graphvault` scope:

```bash
pnpm install
pnpm --filter @graphvault/shared build
pnpm --filter @graphvault/engine build
pnpm --filter @graphvault/mcp build
pnpm --filter @graphvault/cli build

# Publish shared and engine FIRST - mcp and cli depend on them.
pnpm --filter @graphvault/shared publish --access public
pnpm --filter @graphvault/engine publish --access public
pnpm --filter @graphvault/mcp publish --access public
pnpm --filter @graphvault/cli publish --access public
```

`--access public` is required the first time you publish a scoped package
(otherwise npm defaults to a private, paid package). `publishConfig.access` in
each `package.json` also sets this, so the flag is a safety-net, not strictly
required after the first publish.

## Verifying

```bash
npm view @graphvault/mcp
npx -y @graphvault/mcp --help    # should print usage, not "package not found"
npx -y @graphvault/cli --help
```

## After publishing

- Remove the "Package status" notes at the top of
  [`packages/mcp/README.md`](../packages/mcp/README.md) and
  [`packages/cli/README.md`](../packages/cli/README.md) - they exist only to
  avoid documenting a command that doesn't work yet.
- Consider submitting `@graphvault/mcp` to public MCP directories (the
  official [MCP registry](https://github.com/modelcontextprotocol/registry),
  [Smithery](https://smithery.ai), [mcp.so](https://mcp.so)) so it's
  discoverable the way community Obsidian MCP servers are. Each has its own
  submission process (typically a `server.json` manifest plus a GitHub-backed
  identity check) that requires the maintainer's own accounts - not something
  that can be prepared generically in this repo.

## Future releases

After the first publish, bump the `version` field in each of the four
`package.json` files (keep them in lockstep) and re-run the publish steps
above. There is no automated release pipeline for these packages yet - each
publish is manual, deliberate, and owner-run.
