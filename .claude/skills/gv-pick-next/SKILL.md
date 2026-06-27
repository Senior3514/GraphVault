---
name: gv-pick-next
description: >-
  Choose the single highest-impact unfinished improvement for GraphVault and turn
  it into a scoped, bounded plan. Use this to start a build/loop iteration, when
  asked "what should we work on / what's next / pick the most important thing",
  or whenever there's no explicit task but the project should move forward. Reads
  the roadmap and lessons, weighs impact vs risk vs token cost, and commits to
  ONE focused slice rather than a scattershot list.
---

# Pick the next improvement

The planning step of the autonomous build loop. Output exactly one well-scoped
piece of work - not a survey, not three things.

## Inputs to read

1. `docs/ROADMAP.md` - the living status. Find `⬜ planned` and `🟡 in progress`
   items; the ✅ ones are done (don't re-do them; verify if unsure).
2. `docs/agent-company/lessons.md` - recent lessons; avoid repeating mistakes and
   prefer directions the team already learned are valuable.
3. `CLAUDE.md` - the mission and non-goals (do NOT build non-goals).

## The product vision to optimize for

"Obsidian, but open-source, private, flexible, secure, fast - web + mobile +
desktop, one-click for end users, market-breaking." Local-first, zero telemetry,
never lose user data.

## Scoring (pick the top one)

Rank candidates by, in order:

1. **User-visible impact** toward the vision (does an end user feel it?).
2. **Unblocks other work** or removes a sharp edge (data-loss, security, broken
   first-run, mobile breakage all rank highest).
3. **Boundedness** - completable in one focused slice with a clear test.
4. **Risk** - prefer low-risk, surgical changes for autonomous merge.
5. **Token cost** - one improvement per iteration; no busywork.

If nothing scores well - the high-value roadmap is genuinely done - **say so and
stop** rather than inventing work.

## Output

A short plan:

- **What** (one sentence) and **why it's #1 now**.
- **Scope/ownership** - which files/areas; is it one slice or does it need
  gv-slice decomposition?
- **Definition of done** - the test/observation that proves it works.
- **Risks** and how the change stays data-safe / private / non-breaking.

Then hand off: implement directly (single slice) or via gv-slice (multi-slice),
verify with gv-gauntlet, land with gv-ship, record with gv-lessons.
