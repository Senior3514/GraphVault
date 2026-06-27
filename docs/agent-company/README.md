# The GraphVault Agent Company

A dedicated, self-contained "company" of AI agents that operates **this project
only**. It is defined in-repo (committed under `.claude/agents/` and `docs/agent-
company/`) so it travels with GraphVault and is independent of any other project
or its agents.

> Mission: ship GraphVault v0 - local-first Markdown notes, self-hosted sync, and
> a graph you can think in - incrementally, safely, and with **no silent data
> loss**.

## Org chart

```
                       gv-orchestrator  (delivery lead / PM)
                              │  plans · partitions · dispatches · integrates · ships
        ┌───────────┬─────────┼──────────┬───────────┬──────────┬──────────┐
   gv-architect  server     web        graph        sync     security    devops
   (contracts)   engineer   engineer   engineer     engineer  engineer    (docker/CI)
                                                                  │
                                                            gv-docs-writer
                                                                  │
                                                            gv-qa-reviewer  (quality gate)
```

## Roster

| Agent                  | Role               | Primary ownership                                           |
| ---------------------- | ------------------ | ----------------------------------------------------------- |
| `gv-orchestrator`      | Delivery lead / PM | Planning, dispatch, integration, PR, retrospectives         |
| `gv-architect`         | Systems architect  | `docs/sync-protocol.md`, `packages/shared` (contracts)      |
| `gv-server-engineer`   | Backend            | `apps/server`                                               |
| `gv-web-engineer`      | Frontend shell     | `apps/web` UI (editor, pages, vault lib) - excl. graph/sync |
| `gv-graph-engineer`    | Graph              | `packages/engine`, `apps/web/app/graph`                     |
| `gv-sync-engineer`     | Sync               | `packages/sync-core`, `apps/web/lib/sync`, `/sync-status`   |
| `gv-security-engineer` | Security           | Server hardening, encryption, security reviews              |
| `gv-devops`            | DevOps / release   | `docker/`, `docker-compose.yml`, `.github/workflows`        |
| `gv-docs-writer`       | Technical writer   | `README.md`, `DESIGN.md`, `docs/`                           |
| `gv-qa-reviewer`       | Quality gate       | Verification gauntlet + code review (read-mostly)           |

The agents are real Claude Code subagents - invoke one with the `Agent` tool
(`subagent_type: "gv-server-engineer"`, etc.) or let Claude auto-delegate by the
`description` in each agent's front matter.

## How the company works

1. **Plan** - the orchestrator reads the repo and the current milestone.
2. **Partition** - work is split so each specialist owns a **disjoint set of
   directories** (see `playbook.md` → Ownership matrix). Disjoint ownership is
   what makes parallel execution conflict-free.
3. **Dispatch** - specialists run in parallel in isolated **git worktrees**
   (`Agent` tool with `isolation: "worktree"`), each committing without pushing.
4. **Integrate** - the orchestrator cherry-picks the disjoint commits onto the
   feature branch and wires any root-level glue.
5. **Verify** - one unified `install → build → typecheck → lint → format → test`
   plus a runtime smoke test. The QA/Reviewer signs off. Nothing ships red.
6. **Ship** - conventional commit, push, keep the draft PR current.
7. **Learn** - every agent appends concrete lessons to `lessons.md` and the
   playbook is tightened. **Everyone always learns and evolves.**

## Continuous learning

The company has a memory. Before starting, every agent reads `playbook.md`
(how we work) and `lessons.md` (what we've learned the hard way). After finishing,
every agent contributes new lessons. Retrospectives run at each milestone. This
is what keeps the company getting faster and safer over time - see
`playbook.md` → "Continuous improvement loop".

## Files

- `.claude/agents/gv-*.md` - the executable agent definitions (roster).
- `docs/agent-company/playbook.md` - the operating playbook (evolving).
- `docs/agent-company/lessons.md` - the living lessons-learned knowledge base.
