# @graphvault/desktop

Desktop wrapper around the GraphVault web client.

**Status:** placeholder. The native shell is scaffolded in **Milestone 3
(Web + Desktop scaffold)**.

## Planned direction

- **Tauri** (Rust shell, small binaries, good security defaults) wrapping the
  `@graphvault/web` UI.
- Native folder picker to select a local vault directory.
- Secure storage of the vault path and the server access token (OS keychain).
- Direct filesystem access for reading/writing `.md` files and the
  `.graphvault/` metadata folder.

Electron remains a fallback if a required capability is missing from Tauri.
