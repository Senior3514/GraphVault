---
name: gv-slice
description: >-
  Decompose a GraphVault feature into ownership-disjoint slices and build them in
  parallel with specialist agents, then integrate cleanly. Use this for any
  feature that touches more than one area (e.g. shared types + server + web), when
  asked to "build this feature / parallelize / split the work / use the agent
  company", or when a single change is too big for one safe slice. Prevents
  parallel agents from clobbering each other and keeps integration conflict-free.
---

# Slice a feature across the agent company

GraphVault is built by ownership-disjoint specialists working in parallel, then
integrated. This skill encodes how to split and recombine safely.

## 1. Define the shared contract first

If the feature crosses a boundary, the **shared types come first**
(`packages/shared`, zod schemas as the single source of truth). Land or stage
slice A (types) before the consumers build against it. Make additions
**optional/non-breaking** so consumers can adopt incrementally.

## 2. Cut ownership-disjoint slices

Split by owner so two agents never edit the same files:

- **shared-types** → `packages/shared` (gv-architect)
- **server** → `apps/server`, `packages/sync-core` server bits (gv-server / gv-sync)
- **web** → `apps/web` UI (gv-web); graph UI → `apps/web/app/graph` (gv-graph)
- **engine** → `packages/engine` (gv-graph)
- **docs / devops** → `docs/`, `.github/`, `docker/`

Sequence: **types → server → web**, but web UI can build against the staged types
in parallel with the server.

## 3. Dispatch agents in worktree isolation

Launch each specialist with `isolation: worktree` when they mutate files in
parallel, so their changes can't collide. Brief each one with: the exact files it
owns, the shared types it builds against, "do NOT touch other areas", and
"verify gauntlet-green, commit to your branch, DO NOT push - report your SHA."

## 4. Integrate

On one branch off latest main: cherry-pick each slice's feature SHA in order
(types → server → web). `lessons.md` union-merges automatically. Then run the
full gv-gauntlet on the combined branch before shipping.

## Rules

- Disjoint ownership is the whole point - overlap causes the races that cost us
  before (run agents in worktree isolation when they write files concurrently).
- One slice = one focused commit. Keep `lessons.md` as a separate commit so the
  feature commit cherry-picks cleanly.
- Integrate, gauntlet, then gv-ship. Never ship a half-integrated feature.
