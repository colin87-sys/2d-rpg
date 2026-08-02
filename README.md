# 2d-rpg

A 2D role-playing game.

## Development workflow

This repo uses a **director / worker** model split: an expensive,
high-judgement model holds architecture and art direction, while bulk code
generation goes to a cheaper model.

- **Inside Claude** — delegate to the `implementer` subagent (runs on Sonnet,
  shares the repo). Start here.
- **External model** — `/delegate <task-name>` hands a spec to any
  OpenAI-compatible endpoint via `scripts/delegate.py`.

Setup for the external path:

```bash
cp .env.example .env      # fill in WORKER_API_BASE, WORKER_MODEL, WORKER_API_KEY
set -a; source .env; set +a
```

Full rationale, cost model, and the honest tradeoffs:
[`docs/multi-model-workflow.md`](docs/multi-model-workflow.md).
