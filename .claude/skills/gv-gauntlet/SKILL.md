---
name: gv-gauntlet
description: >-
  Run GraphVault's full verification gauntlet - typecheck, lint, format:check,
  all workspace tests, and the web build - and report a precise pass/fail verdict.
  Use this BEFORE shipping any change, before opening or merging a PR, whenever
  someone asks "is it green / does it build / are tests passing", after finishing
  an edit, or when integrating work from another branch or agent. This is the
  quality gate: nothing ships red. Prefer this over running checks ad-hoc so the
  exact same gauntlet that CI runs is reproduced locally.
---

# GraphVault verification gauntlet

The single source of truth for "is this safe to ship." It mirrors `.github/workflows/ci.yml`
step-for-step, so a local green here means the change is sound even when the
hosted CI runner is unavailable.

## Run it

From the repo root, in order (fastest checks first so failures surface early):

```bash
pnpm install --frozen-lockfile   # only if deps may have changed
pnpm typecheck                   # tsc across all workspaces
pnpm lint                        # eslint .
pnpm format:check                # prettier --check .
pnpm test                        # pnpm -r run test (every workspace)
pnpm run build:web               # Next.js static export
pnpm run smoke:web               # load every route in headless Chromium
```

`smoke:web` is the safety net that unit tests + build miss: it loads every
exported route in a real browser and fails on ANY client-side exception
(hydration mismatch, stale-chunk crash, etc.) - the exact class of bug that
once white-screened production. It needs `build:web` to have run first, and
skips gracefully when no Chromium is available.

Or use the bundled script, which runs all of them and stops at the first failure:

```bash
bash .claude/skills/gv-gauntlet/scripts/gauntlet.sh
```

## Reporting

Report a clear verdict, not raw logs:

- **GREEN** - list each step with ✅ and the test totals (e.g. "web 757/757,
  server 207/207"). Only a fully green gauntlet authorizes a ship.
- **RED** - name the exact failing step, the file/line, and the minimal fix.
  Do not proceed to push/merge.

## Rules

- **Never ship red.** A single failing step fails the whole gauntlet.
- `format:check` failures are usually unformatted Markdown after a union merge of
  `docs/agent-company/lessons.md` - fix with `pnpm exec prettier --write <file>`,
  never by hand.
- Vendored/authored trees (`.claude/`, `apps/extension/`) are formatter-ignored
  by design; don't "fix" them.
- If the hosted GitHub Actions check is red but this local gauntlet is fully
  green, the failure is infrastructure (runner/billing), not the code - say so
  explicitly and don't chase it.
