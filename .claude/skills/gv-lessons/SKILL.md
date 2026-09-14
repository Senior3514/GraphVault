---
name: gv-lessons
description: >-
  Record what was learned and keep the roadmap honest after every GraphVault
  slice. Use right after finishing/shipping a change, when a mistake or a
  non-obvious gotcha surfaces, when asked to "update the roadmap / log a lesson /
  close out this slice", or at the end of any loop iteration. The agent company
  always learns and evolves - an unlogged lesson gets repeated.
---

# Record lessons & update the roadmap

The continuous-learning loop. Two append-only updates close out every slice.

## 1. Append a lesson

Add a concise, concrete entry to `docs/agent-company/lessons.md`. A good lesson:

- States the **situation**, the **gotcha/mistake**, and the **rule going forward**
  - in 1-4 lines, specific and actionable (not "be careful").
- Captures something a future agent would otherwise rediscover the hard way
  (e.g. "GitHub's PR merge doesn't honor `.gitattributes merge=union`, so update
  stale branches by merging main in locally first").
- Is honest about what didn't work, not just wins.

`lessons.md` is **union-merged** (`.gitattributes`), so concurrent appends from
parallel branches combine automatically - just append, never restructure. If the
post-merge file isn't prettier-clean, `pnpm exec prettier --write` it.

## 2. Tick the roadmap

Update `docs/ROADMAP.md`: flip the item you finished to ✅ (or 🟡 if partial),
add any newly-discovered follow-up as ⬜, and keep statuses **honest** - never
mark something ✅ that isn't actually done and verified. Re-order by impact if the
landscape shifted.

## Rules

- Append, don't rewrite history. Keep entries short and high-signal.
- One slice → one lesson (or a few tightly-related ones).
- Honesty over optimism: a roadmap that overstates progress is worse than none.
- This is the final step of a slice - after gv-gauntlet and gv-ship.
