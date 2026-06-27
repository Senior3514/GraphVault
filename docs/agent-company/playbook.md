# GraphVault Agent Company - Operating Playbook

The company's how-we-work manual. It is a **living document**: every milestone
retrospective may tighten it. Read it before you start; improve it when you
finish.

## 1. Prime directives

1. **Never silently lose user data.** This app syncs people's notes. When in
   doubt, preserve both sides (conflict copies) and surface it.
2. **Inspect before changing.** Never restart from scratch if code exists; work
   incrementally in milestones.
3. **Decouple cores from UI.** The engine, sync-core, and graph engine are
   reusable libraries with no UI imports.
4. **Plain over clever.** Auditable, validated, boring code wins in a security-
   and integrity-sensitive app.
5. **Report faithfully.** If tests fail, say so with output. No green-washing.

## 2. Ownership matrix (how we avoid conflicts)

Parallel agents must own **disjoint directories**. This is the single most
important rule for conflict-free parallel delivery.

| Area                      | Owner                | Paths                                                                                                  |
| ------------------------- | -------------------- | ------------------------------------------------------------------------------------------------------ |
| Contracts / spec          | gv-architect         | `docs/sync-protocol.md`, `packages/shared/**`                                                          |
| Sync server               | gv-server-engineer   | `apps/server/**`                                                                                       |
| Web UI shell + editor     | gv-web-engineer      | `apps/web/**` except graph/sync dirs below                                                             |
| Graph engine + graph UI   | gv-graph-engineer    | `packages/engine/**`, `apps/web/app/graph/**`, `apps/web/components/graph/**`, `apps/web/lib/graph/**` |
| Sync engine + sync wiring | gv-sync-engineer     | `packages/sync-core/**`, `apps/web/lib/sync/**`, `apps/web/app/sync-status/**`                         |
| Security hardening        | gv-security-engineer | `apps/server/**` (coordinated), reviews everywhere                                                     |
| Docker / CI               | gv-devops            | `docker/**`, `docker-compose.yml`, `.dockerignore`, `.github/workflows/**`                             |
| Docs / prose              | gv-docs-writer       | `README.md`, `DESIGN.md`, `docs/**`                                                                    |

**Shared/contended files** (`apps/web/components/Sidebar.tsx`, any
`package.json`, root `tsconfig.json`, `pnpm-lock.yaml`): only ONE agent edits a
given shared file per round, OR the orchestrator reconciles it centrally during
integration. The lockfile is always regenerated centrally - see §4.

## 3. Dispatch protocol (orchestrator)

- Launch specialists with the `Agent` tool and `isolation: "worktree"` so each
  works on an isolated copy. Send independent agents in one message to run them
  in parallel.
- Every dispatch must state: scope, **ownership boundaries**, quality bar, and
  the standing rules: **do NOT stage `pnpm-lock.yaml`**, **do NOT push**, report
  branch + commit SHA + honest pass/fail at the end.

## 4. Integration protocol

1. Confirm branches touch disjoint files (`git diff --name-only base..branch`).
2. Cherry-pick each specialist's commit onto the feature branch (disjoint → no
   conflicts).
3. Add root glue yourself: `tsconfig.json` project references for new packages,
   `pnpm-workspace.yaml` only if a new top-level glob is needed.
4. Run ONE `pnpm install` to regenerate `pnpm-lock.yaml` centrally.
5. Run the full gauntlet (§5). Fix integration issues. Commit + push.

## 5. Definition of Done (the gauntlet)

A change ships only when ALL pass, run from the repo root:

```bash
pnpm install
pnpm -r build
pnpm -r typecheck
pnpm lint
pnpm format:check
pnpm -r test
```

Plus, when relevant, a **runtime smoke test** (e.g. boot the server and exercise
register → vault → blob → push → changes). The QA/Reviewer signs off. New
behavior must be covered by new tests - passing tests that don't exercise the
change do not count.

## 6. Conventions (from CLAUDE.md)

- TypeScript everywhere; shared wire types live in `@graphvault/shared` and stay
  in lockstep with `docs/sync-protocol.md`.
- Validate all external input with zod from `@graphvault/shared`.
- Config via environment variables only; no hardcoded secrets; no telemetry.
- Conventional, descriptive commit messages. Composite-package `typecheck`
  scripts use `tsc -b` (not `tsc -b --noEmit` - see lessons.md).
- Run `pnpm exec prettier --write` on files you touch.

## 7. Continuous improvement loop

> Everyone always learns and evolves.

- **Before** a task: read this playbook + `lessons.md`.
- **During**: when you hit a non-obvious snag, note it.
- **After**: append a concrete, actionable entry to `lessons.md` (symptom → root
  cause → fix/rule). If a lesson is process-level, also tighten this playbook.
- **Per milestone**: the orchestrator runs a short retrospective - what slowed us
  down, what to automate, which guardrail to add - and updates these docs.

The goal is a company that is measurably faster and safer each milestone because
its written memory keeps growing.
