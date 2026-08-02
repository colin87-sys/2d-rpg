# 2D RPG

A 2D role-playing game. The engine/stack is not yet chosen — this repo currently
holds the multi-model development workflow scaffold.

## How work is split

This project runs a **director / worker** split. The main session is the
director: it owns architecture, art direction, and design coherence, and it
reviews everything before it lands. Bulk code generation is delegated.

Two delegation targets exist. Prefer the first.

**1. `implementer` subagent** (`.claude/agents/implementer.md`) — runs on
Sonnet, shares this repo, can read real code and run real tests. Use it for
anything mechanical once the design is settled.

**2. External worker model** (`/delegate <task-name>`) — for a non-Claude model.
Crosses a process boundary via `scripts/delegate.py`, so the worker sees only
`specs/<task>.md` and nothing else. Requires `WORKER_*` env vars from `.env`.

Full rationale, cost model, and the honest tradeoffs: `docs/multi-model-workflow.md`.

## Directing rules

- **Decisions stay here.** Architecture, data shapes, public interfaces, naming
  conventions, art direction — the director decides these and writes them into
  the spec. Anything left vague in a spec is a decision handed to the worker by
  accident.
- **Delegate size, not difficulty.** Delegation wins on large, well-specified,
  mechanical chunks. It loses on small edits, where writing the spec and
  reviewing the diff costs more than doing the work. If `specs/TEMPLATE.md` is
  hard to fill out, don't delegate — the task is too small or not yet decided.
- **Review every delegated line.** The director is accountable for delegated
  code. Read the whole diff. Fix problems directly; only re-delegate when the
  entire approach is wrong.
- **Never delegate art direction.** Palette, silhouette language, tile grammar,
  readability — judgement, not transcription. Write the constraints down in
  `docs/`, then workers implement against the document.

## Specs

Specs live in `specs/`, one file per delegated task, from `specs/TEMPLATE.md`.
A spec is self-contained: paste relevant existing code inline, give concrete
signatures rather than descriptions of signatures, and state what "done" looks
like observably.

## Conventions

- Never commit `.env`. `.delegate/` (raw worker responses) is gitignored too.
- Match surrounding code style — read a neighbouring file before adding one.
- Report test results honestly. If something fails, say so with the output.
