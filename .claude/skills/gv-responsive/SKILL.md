---
name: gv-responsive
description: >-
  Verify and repair GraphVault's responsive layout across web, mobile, and
  desktop so it always looks proportional and is usable one-handed. Use when
  touching layout/shell/navigation/editor/settings, when a screen looks cut off
  or not proportional on a phone, when asked to "fix mobile / make it responsive
  / check it on small screens", or before shipping any UI change. Mobile-broken
  UI is a ship blocker.
---

# Responsive & mobile check

The web app is the mobile and (via PWA) desktop app too, so responsiveness is not
optional. A real bug here (a missing viewport export) once made the whole mobile
UI cut off - these checks exist so that never recurs.

## Must-haves

- **Viewport is correct.** `apps/web/app/layout.tsx` exports `viewport` with
  `width=device-width`, `initialScale: 1`, and **`viewportFit: 'cover'`** - the
  last is what makes `env(safe-area-inset-*)` actually resolve. Without it,
  safe-area padding is inert and notched phones clip the UI.
- **Safe-area insets** are applied to top/bottom bars and FABs
  (`env(safe-area-inset-*)`), and full-height uses **`100dvh`** (not `100vh`).
- **No horizontal overflow** at 320-414px widths; content reflows, never
  side-scrolls.
- **Tap targets ≥ 44px** (bottom nav, FAB, primary buttons) - `min-h-[44px]`+.
- **Single-pane mobile workspace** with a bottom bar (Notes/Editor/Details) and
  drawers; panes/resizers are desktop-only.
- **One-handed reach** - primary actions sit in the thumb zone on mobile.

## Method

1. Inspect the shell (`AppFrame`, workspace layout) and the changed screen.
2. Check the built output where it matters: confirm `viewport-fit=cover` and the
   theme-color land in `apps/web/out/index.html` after `pnpm run build:web`.
3. Reason through 320px / 768px / 1280px widths; fix concrete clipping, overflow,
   small tap targets, or `100vh` usage. Keep light/dark via tokens, motion-safe.
4. Don't over-redesign - surgical fixes only. Verify with gv-gauntlet; ship.
