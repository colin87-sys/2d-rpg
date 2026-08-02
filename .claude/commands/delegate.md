---
description: Write a spec for the current task and hand it to the external worker model
argument-hint: <short name for the task, e.g. inventory-system>
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(python3 scripts/delegate.py:*), Bash(git diff:*), Bash(git status:*)
---

Delegate the current task to the external worker model. The task name is: $1

Work through these steps in order. You are the director — you own the design
decisions and the review. The worker owns the typing.

## 1. Write the spec

Read whatever parts of the codebase this task touches, then write
`specs/$1.md`. The spec is the entire contract — the worker sees nothing but
this file, so it must be self-contained. Include:

- **Goal** — one paragraph on what this system does and why.
- **Files** — exact paths to create or modify.
- **Interfaces** — the function signatures, types, data shapes, and events the
  rest of the codebase will use. Be concrete; this is where you make the
  architectural decisions rather than letting the worker make them.
- **Existing code it must fit** — paste the relevant snippets inline. The
  worker has no repository access.
- **Constraints** — engine/library versions, conventions, performance limits,
  what NOT to touch.
- **Done means** — the observable behaviour that says it's finished.

Keep design reasoning out of the spec. Decisions, not deliberation.

## 2. Send it

```
python3 scripts/delegate.py specs/$1.md
```

That prints the files the worker proposes without writing anything. If the
response is obviously off-spec, tighten the spec and re-run rather than
patching the output yourself.

## 3. Apply and review

```
python3 scripts/delegate.py specs/$1.md --apply
git diff
```

Read every line of the diff. You are accountable for this code — the worker is
not. Fix what's wrong directly; only re-delegate if the whole approach is off.

## 4. Report

Tell me what landed, what you had to correct, and anything the spec should have
said but didn't. If the worker call failed or `WORKER_*` env vars are unset,
say so plainly and offer to implement it with the `implementer` subagent instead.
