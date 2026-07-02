<div align="center">

# GraphVault

**Local-first Markdown notes, with a graph you can actually think in.**

Your notes are plain `.md` files that live on your device. No account, no
lock-in, no telemetry. Optional self-hosted sync when you want it.

[![License: MIT](https://img.shields.io/badge/License-MIT-22b8cf.svg)](LICENSE)
&nbsp;
![Local-first](https://img.shields.io/badge/local--first-yes-22b8cf.svg)
&nbsp;
![Zero telemetry](https://img.shields.io/badge/telemetry-none-22b8cf.svg)

[**Open the app**](https://graph-vault.vercel.app) &nbsp;·&nbsp; [Quickstart](#quickstart) &nbsp;·&nbsp; [Self-host](#self-host) &nbsp;·&nbsp; [Docs](docs/)

</div>

---

## Why GraphVault

Most note apps trap your data in a proprietary format, or make you sign up and
grant permissions before you can write a word. GraphVault does neither.

- **Open and write.** Your vault is already there. No account, works offline.
- **Plain Markdown.** Real `.md` files. Open them anywhere, export them anytime.
- **A graph that earns its place.** Navigate ideas through their links, not a
  decorative hairball.
- **Yours, everywhere.** Keep the vault on disk, or sync through a server you
  host yourself. Nothing is hosted by us by default.

## Features

| Area                    | What you get                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| **Markdown editor**     | Live preview, `[[wikilinks]]` and `#tags` with autocomplete, backlinks, full-text search, autosave                                 |
| **Graph view**          | Force-directed global and local graphs, color by type or tag, hover to highlight connections, click to open                        |
| **Command palette**     | `Cmd/Ctrl+K` for quick-open, create, navigate, and every action, fully keyboard-driven                                             |
| **Workspace**           | Resizable panes, tabs, split view, focus mode, light and dark themes                                                               |
| **Your data, anywhere** | Local storage, a folder on disk, or WebDAV / S3 / Azure / GCS through your own server                                              |
| **Portability**         | Import and export `.zip` / `.json` / `.md`; one-click import from Obsidian, Notion, Roam, Logseq                                   |
| **Optional sync**       | Self-host a small server on any VPS to sync across your devices                                                                    |
| **Privacy-first AI**    | Off by default. Local model, your own key, or your self-hosted gateway. Note content never leaves the device unless you turn it on |
| **Connect things**      | Web clipper, RSS, email import, an inbound webhook, an MCP server, and a CLI                                                       |
| **Secure by default**   | End-to-end vault encryption, strict CSP, sanitized rendering, no telemetry                                                         |

## Get the app

- **Web / mobile:** open [graph-vault.vercel.app](https://graph-vault.vercel.app).
  Works offline, no account.
- **Install as a desktop / mobile app:** open it in your browser and choose
  **Install** (or "Add to Home Screen"). It runs as a standalone app.
- **Native desktop build:** build a real installer locally with
  `pnpm --filter @graphvault/desktop build` (requires Rust and the Tauri
  prerequisites).

## Quickstart

Requires Node 22+ and [pnpm](https://pnpm.io).

```bash
pnpm install
pnpm run dev          # web client + sync server
```

Open the printed local URL and start writing. The sync server is optional; the
web client is fully usable on its own.

## Self-host

Run the optional sync server on any machine you control, with Docker:

```bash
docker compose up -d
```

See [`docs/deployment.md`](docs/deployment.md) and
[`docs/hardening.md`](docs/hardening.md) for a production setup (TLS, firewall,
backups). Configuration is via environment variables only; there are no
hardcoded secrets.

## Privacy

- Works 100% offline. No account required.
- Zero telemetry. The app only talks to the sync server and AI provider you
  explicitly configure.
- AI and credential-bearing connectors are opt-in and off by default. Keys for
  cloud storage and AI live encrypted on your own server, never in the browser.
- Plain Markdown on disk means you can leave at any time with all your data.

## Documentation

| Doc                                              | What it covers                |
| ------------------------------------------------ | ----------------------------- |
| [`docs/deployment.md`](docs/deployment.md)       | Self-hosting the sync server  |
| [`docs/hardening.md`](docs/hardening.md)         | Production security checklist |
| [`docs/sync-protocol.md`](docs/sync-protocol.md) | The sync wire protocol        |
| [`docs/ROADMAP.md`](docs/ROADMAP.md)             | Where the project is headed   |
| [`docs/PRICING.md`](docs/PRICING.md)             | Free vs. GraphVault Cloud     |

## Tech

A pnpm monorepo: a Next.js web client, a Fastify sync server, shared TypeScript
types and engines, and a Tauri desktop shell. TypeScript end to end.

## Contributing

Issues and pull requests are welcome. See [`CONTRIBUTING.md`](CONTRIBUTING.md)
and [`CODE_OF_CONDUCT.md`](CODE_OF_CONDUCT.md). Every change runs a full
typecheck / lint / format / test / build gate before it ships.

## License

[MIT](LICENSE). Your notes are yours, forever.
