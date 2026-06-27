---
name: gv-perf-budget
description: >-
  Measure and protect GraphVault's web performance budget - First Load JS, shared
  baseline, and heavy-dependency code-splitting - and catch regressions. Use after
  adding a dependency or a heavy component, when a route feels slow or the bundle
  grew, when asked to "check bundle size / make it faster / lazy-load this", or
  before shipping a UI change that pulls a big library. Fast, smooth UX is a market
  differentiator; report deltas honestly.
---

# Performance budget check

"Secure & fast" is a north-star promise. Perceived speed comes mostly from a lean
initial bundle. This skill keeps it lean and catches regressions before they ship.

## Measure

`pnpm run build:web` prints the route table with **First Load JS** per route and a
shared baseline. For ground truth on what's in which chunk, inspect
`apps/web/.next/app-build-manifest.json` (which chunks load for which route) - the
route table alone can mislead.

Record **before vs after** for the routes a change touches, plus the shared
baseline.

## Budget guidelines

- **Shared baseline** stays small - it loads on every route. New heavy deps must
  NOT land here.
- **Heavy, on-demand components** (graph/force lib, charts, editors, AI panels)
  are **dynamically imported** (`next/dynamic`, `ssr:false` for canvas/DOM libs
  in static export) so they stay out of First Load until used.
- Every lazy boundary gets a **lightweight, accessible loading placeholder**
  (no layout shift, motion-safe, themed) - never a dead screen.
- A new dependency must justify its First Load cost or be code-split. Prefer zero
  new deps where the platform already provides it.

## Method

1. Build, capture the route-table + manifest numbers.
2. Identify the heaviest module a change adds to First Load; if it's not needed on
   first paint, dynamically import it and re-measure.
3. **Report the real delta** - if a change adds X kB, say so; if it doesn't
   actually reduce anything (e.g. the lib was already split), say that honestly
   instead of claiming a win.
4. Verify with gv-gauntlet; land with gv-ship.
