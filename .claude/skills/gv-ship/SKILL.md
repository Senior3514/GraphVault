---
name: gv-ship
description: >-
  Ship a finished GraphVault change end-to-end to production: branch off the
  latest origin/main, run the full gauntlet, push, open a draft PR, and merge it
  autonomously to main (squash). Use this whenever a change is ready to land,
  when asked to "ship it / push and merge / get this into main / open a PR", or
  as the final step of any feature, fix, or loop iteration. Encodes the proven,
  data-safe integration pattern - never ship red, never clobber parallel work,
  resolve lessons.md as a union.
---

# Ship a change to production

The repeatable, safe path from a working change to merged-on-main. Follow it
exactly - the rules exist because each one prevented a real incident.

## Pipeline

1. **Sync & branch.** `git fetch origin main` then branch off it:
   `git checkout -B <descriptive-branch> origin/main`. Always base on the
   *latest* main, never a stale tip.
2. **Bring the change in.** Cherry-pick the feature commit, or apply the edits.
   If integrating an agent's work, cherry-pick its SHA.
3. **No-clobber gate.** `git diff origin/main HEAD --stat` - confirm ONLY the
   files you intend to change appear. If unrelated files would revert, STOP.
4. **Gauntlet.** Run the full gv-gauntlet. Green or stop.
5. **Push** (`git push -u origin <branch>`, retry on network error with backoff).
6. **PR.** Open a PR (draft first is fine). Fill the repo PR template honestly:
   what/why, how tested (real commands + totals), and tick the data-safety /
   privacy / input-validation boxes.
7. **Merge.** Confirm `mergeable_state` is `clean` or `unstable` (unstable =
   only the known-red hosted CI), then squash-merge to main.
8. **After merge.** If main moved, other open branches may now conflict on
   `lessons.md` - update them (see Rules). Update ROADMAP + lessons (gv-lessons).

## Rules (load-bearing)

- **Never `git merge -X ours`** against main - it silently reverts parallel
  work. To make a tree match main, `git checkout origin/main -- .` instead.
- **`docs/agent-company/lessons.md` is union-merged** (`.gitattributes
  merge=union`). On conflict, keep BOTH blocks; if the union output isn't
  prettier-clean, `pnpm exec prettier --write docs/agent-company/lessons.md`.
- **Never ship red.** Local gauntlet must be fully green.
- **Keep the live app click-and-use.** No dead routes, no broken first-run.
- **Squash-merge** to keep main history linear (matches existing PRs).
- A hosted-CI red check that contradicts a green local gauntlet is infra, not
  code - merge by the verified-local signal, and say why.

## Updating a stale branch after main moves

```bash
git fetch origin main
git checkout <branch>
git merge origin/main --no-edit      # union driver auto-resolves lessons.md
grep -c '<<<<<<<' docs/agent-company/lessons.md   # must be 0
pnpm format:check || pnpm exec prettier --write docs/agent-company/lessons.md
git push origin <branch>
```
