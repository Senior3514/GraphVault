# GraphVault Roadmap — road to a finished, best-in-class product

> Living document. The agent company updates this after every slice: tick boxes,
> add lessons, re-order by impact. The goal is a **local-first, no-lock-in,
> secure, fast, beautiful** notes app that beats Obsidian / Notepad / CherryTree.

## North star

- **Local-first & private**: works 100% offline, no account required, no telemetry.
- **No lock-in**: plain Markdown on disk; export/import anywhere, anytime.
- **A graph you can think in**: not decoration — a real tool for navigating ideas.
- **Secure & fast**: untrusted input is validated; encryption available; UI stays smooth.

## Status legend

✅ done · 🟡 in progress · ⬜ planned

---

## v0 foundation (shipped)

- ✅ Monorepo, shared wire types, sync protocol draft
- ✅ Sync server (auth + health), security hardening (rate limit, headers, at-rest enc)
- ✅ Web shell: vault editor, markdown render, backlinks, search
- ✅ Graph engine (parse, link/tag index, local/global queries) + Graph UI v1
- ✅ End-to-end sync (scan/diff/pull/push/reconcile + conflict copies)
- ✅ Docker packaging + docs
- ✅ Static export → deployable to any static host (Vercel)

## Milestone 11 — Portability & "your data, any storage" 🟡

- ✅ Export vault as Markdown `.zip` (lossless) and JSON backup
- ✅ Import from `.zip` / `.json` / `.md`, collision-safe (never overwrites)
- ✅ Hardened import (zip-slip / size / count guards) + tests
- ✅ Pluggable storage backend seam: `StorageAdapter` + localStorage + File System Access disk adapter
- ✅ Settings UI to pick storage location (folder on disk) with copy-verify-switch migration
- ✅ Drag-and-drop import + "export to a folder" (File System Access)

> Decision: **open-core** — auditable client + engine, optional paid hosted sync.

## Milestone 12 — Workspace, panes & window controls ✅

- ✅ Resizable panes with drag dividers (sidebar ↔ editor ↔ details)
- ✅ Collapse / expand / maximize-restore controls per pane; layout persisted
- ✅ Editor tabs: open/close/reorder, dirty indicator, "+"; split view (editor+preview / two notes)
- ✅ Per-tab autosave that flushes before switch/close/unmount (no lost edits)
- ⬜ Pop-out windows / focus mode (nice-to-have)

## Milestone 13 — Command palette & power editing ✅

- ✅ Command palette (Cmd/Ctrl+K): quick-open, create note, navigate, toggle preview
- ✅ `[[` wikilink autocomplete and `#` tag autocomplete in the editor
- ✅ Interactive preview: wikilinks navigate, inline `#tags` are clickable filters
- ✅ Collapsible icon-rail shell, tag cloud + tag-filtered note list

## Milestone 14 — Spectacular graph ✅

- ✅ Color by node type (note / attachment / unresolved) + accurate legend
- ✅ Hover glow + neighbor highlight, dim the rest; smooth settled physics
- ✅ Click → select; double-click → open note (`/vault?note=`)
- ✅ Live force controls (link distance, repel, gravity, label threshold)
- ✅ Zoom-to-fit / reset; degree-scaled nodes; reduced-motion aware

## Milestone 15 — Security, encryption & speed 🟡

- ✅ E2E vault encryption library: PBKDF2(310k)+AES-256-GCM, tamper-rejecting, versioned (`lib/crypto`)
- ✅ Security review of render/XSS + import paths (passed)
- ✅ Encryption wired into Settings: `EncryptedVaultStore` decorator + passphrase gate + safe enable/disable
- ✅ Strict CSP (`<meta>` + `vercel.json` headers) + X-Content-Type-Options / Referrer-Policy / X-Frame-Options / Permissions-Policy
- ⬜ Performance budget: virtualize long lists, debounce indexing, lazy graph

## Milestone 14b — Graph v2 extras ✅

- ✅ In-graph search (`/`, highlight/zoom to matches), drag-to-pin nodes, zoom buttons, 200+ label cap perf

## Milestone 16 — True local desktop (Tauri) 🟡

- ✅ Tauri 2 shell scaffold (`apps/desktop`) wrapping the web export + `TauriStorageAdapter` on the storage seam
- ⬜ Build installers on each OS (`pnpm --filter @graphvault/desktop build`; needs Rust + tauri-cli)
- ⬜ Native file watching; open an existing folder as a vault

## Milestone 17 — Polish, onboarding & launch 🟡

- ✅ Stunning landing page + dismissible first-run onboarding hints (Cmd-K / `[[` / `#`)
- ✅ Global UX polish (focus rings, transitions, empty-state utilities, motion-safe animations)
- ✅ Docs: quickstart, self-hosting, security model, data portability; public-launch README (scrubbed)
- ⬜ Full accessibility audit (focus order, contrast, screen-reader)
- ⬜ "Finished product" QA gauntlet + tagged release

---

## Open question to resolve with the owner

- **License / source model**: open-source (recommended: open-core — auditable
  client + engine, optional paid hosted sync) vs closed. For a _local-first_
  app, user data access comes from local files + export (already shipped), **not**
  from the license — so closed source does **not** improve "access," while open
  source materially improves trust for a security-sensitive notes app. Pending decision.

## Working agreement (every agent)

1. Inspect before changing; work in ownership-disjoint slices.
2. Build green + tests green before ship. Never silently lose user data.
3. Validate all external/untrusted input. No secrets, no telemetry by default.
4. Update this roadmap and `docs/agent-company/lessons.md` after each slice.
