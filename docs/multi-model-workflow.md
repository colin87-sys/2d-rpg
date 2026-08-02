# Multi-model workflow: director + worker

The idea you've probably seen described: run an expensive, high-judgement model
as the **director** — it holds the architecture, the art direction, the design
coherence — and hand the mechanical code generation to a cheaper **worker**
model. You pay top rates only for the thinking.

This repo is set up for that. There are two ways to do it, and you should
almost certainly start with the first.

---

## Tier 1 — stay inside Claude (recommended starting point)

Claude Code lets subagents run on a different model than your main session.
So: main session on Fable, `implementer` subagent on Sonnet 5.

Set your main model to Fable:

```
/model claude-fable-5
```

Then just ask for work normally. When the task is mechanical, delegate:

> Use the implementer subagent to build the inventory system per the design we
> just settled.

`.claude/agents/implementer.md` pins that subagent to Sonnet. Fable never
generates the boilerplate; it writes the spec, reads the report, reviews the
diff.

**Why start here:** zero integration, no API keys, no second bill, no context
bridge to maintain. Subagents share the repo, so the worker can read the actual
code instead of working from a paste. Most of the cost saving is available at
this tier.

Published rates, per million tokens:

| Model | Model ID | Input | Output |
|---|---|---|---|
| Claude Fable 5 | `claude-fable-5` | $10 | $50 |
| Claude Opus 5 | `claude-opus-5` | $5 | $25 |
| Claude Sonnet 5 | `claude-sonnet-5` | $3 | $15 |
| Claude Haiku 4.5 | `claude-haiku-4-5` | $1 | $5 |

Code generation is output-heavy, and output is where the gap bites: Fable's
$50/M against Sonnet's $15/M. Moving bulk generation to Sonnet cuts that line
item by roughly two thirds.

Worth knowing before you commit to Fable-as-director: **Opus 5 is half Fable's
price and is itself very strong on architecture and long-horizon agentic work.**
Fable is the higher tier, but the gap between them is much smaller than the gap
between either and a generic coding model. Try Opus 5 directing Sonnet 5 before
assuming you need Fable.

---

## Tier 2 — external worker model (what you asked about)

If you specifically want a non-Claude model doing the code writing, that has to
cross a process boundary. Claude Code subagents only run Claude models — there
is no config that points one at another provider. So the director shells out.

The flow:

```
Fable (director)                          worker model
  │
  ├─ reads the codebase
  ├─ writes specs/<task>.md   ──────────►  receives the spec, nothing else
  │                                              │
  │                           ◄──────────  returns complete file contents
  ├─ applies files
  ├─ reviews the diff, fixes what's wrong
  └─ commits
```

### Setup

```bash
cp .env.example .env
# fill in WORKER_API_BASE, WORKER_MODEL, WORKER_API_KEY
set -a; source .env; set +a
```

`WORKER_MODEL` takes whatever string your provider uses. Look it up in their
model list rather than guessing — a wrong id is a 404, and model names change
faster than anyone's memory of them.

### Use

```
/delegate inventory-system
```

That slash command walks the director through: write the spec → preview the
worker's output → apply → review the diff. Or drive the script directly:

```bash
python3 scripts/delegate.py specs/inventory-system.md            # preview
python3 scripts/delegate.py specs/inventory-system.md --apply    # write files
python3 scripts/delegate.py specs/inventory-system.md --dry-run  # print prompt only
```

Raw responses land in `.delegate/out/` (gitignored) so you can inspect what the
worker actually said when the parse looks wrong.

### The spec is the whole system

The worker has no repository access. It sees `specs/<task>.md` and nothing
else. That constraint is doing real work for you — it forces the director to
make every architectural decision explicitly instead of leaving them implicit
in the code. A vague spec is a decision you handed to the cheap model by
accident.

Use `specs/TEMPLATE.md`. Paste relevant existing code inline. Give concrete
signatures, not descriptions of signatures.

---

## Where the savings actually come from — and don't

Be clear-eyed about this, because the naive cost model oversells it.

**Real saving:** the director never generates the bulk code tokens. On a large
system that's the majority of output, and output is the expensive side.

**Not saved:** the director still reads the codebase to write the spec, and
still reads the full diff to review it. Those are input tokens on the expensive
model, and reviewing generated code you didn't write is *more* reading than
writing it yourself would have been. Prompt caching helps a lot on the repeated
context, and it's on by default.

**Net:** delegation pays off on large, well-specified, mechanical chunks. It
loses on small edits, where spec-writing plus review costs more than just doing
it. Rule of thumb — if you can't fill out `specs/TEMPLATE.md` without effort,
the task is too small or too undecided to delegate.

Tier 2 also adds real friction Tier 1 doesn't have: a second API bill and key
to manage, no shared repo context, a text protocol that can be malformed, and
no ability for the worker to run your tests. Weigh that against the per-token
delta before wiring it up.

---

## For art direction specifically

Art direction is the one thing to keep entirely with the director. It's
judgement, not generation — the palette, silhouette language, tile grammar,
readability rules for a 2D RPG. Write those decisions down once as a document
in `docs/`, and have the director reference it. Then the worker implementing a
tileset loader doesn't need taste; it needs the constraint document.

That's the general pattern: **push decisions up to the expensive model, push
transcription down to the cheap one.**

---

## Upgrade path

If shelling out via Bash starts to chafe, the next step is wrapping the worker
in an MCP server so the director can call it as a native tool with structured
output instead of parsing a text envelope. That's more moving parts; only do it
once the script is genuinely load-bearing.
