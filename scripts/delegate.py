#!/usr/bin/env python3
"""
Hand a written spec to an external "worker" model and collect the code it writes.

This is the bridge that lets a Claude session act as director while a cheaper
model does the bulk code generation. Claude writes the spec, calls this script,
then reviews the diff.

Usage:
    scripts/delegate.py specs/inventory-system.md
    scripts/delegate.py specs/inventory-system.md --apply
    scripts/delegate.py specs/combat.md --dry-run

Config comes from the environment (see .env.example):
    WORKER_API_BASE   OpenAI-compatible base URL (default https://api.openai.com/v1)
    WORKER_MODEL      Model id to send as the worker
    WORKER_API_KEY    Bearer token for that endpoint
    WORKER_MAX_TOKENS Output cap (default 16000)

Output is always written to .delegate/out/<spec-name>.md so the raw worker
response survives for review even when --apply is used.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import NoReturn

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = REPO_ROOT / ".delegate" / "out"

# The worker is told to emit files in this exact envelope so the parser below
# can apply them deterministically instead of guessing at markdown fences.
FILE_BEGIN = re.compile(r"^<<<FILE:\s*(?P<path>.+?)\s*>>>$")
FILE_END = "<<<END>>>"

WORKER_SYSTEM_PROMPT = """You are an implementation worker on a 2D RPG codebase.

A senior engineer has already made the architectural decisions. Your job is to
write the code that the spec describes — not to redesign it. If the spec is
ambiguous, pick the smallest reasonable interpretation and note it at the end
under a `## Notes` heading. Do not invent extra features, files, abstractions,
or configuration that the spec does not ask for.

Emit every file you write using this exact envelope, with no markdown fences
around it:

<<<FILE: relative/path/from/repo/root.ext>>>
...the complete file contents...
<<<END>>>

Rules:
- Give the COMPLETE contents of each file, never a diff or a fragment.
- Paths are relative to the repository root, and must not start with `/` or contain `..`.
- Emit nothing between `<<<END>>>` and the next `<<<FILE:` line.
- Any commentary goes after all file blocks, under `## Notes`.
"""


def fail(msg: str) -> NoReturn:
    print(f"delegate: {msg}", file=sys.stderr)
    sys.exit(1)


def build_prompt(spec_text: str, spec_path: Path) -> str:
    return f"Implementation spec (`{spec_path}`):\n\n{spec_text.strip()}\n"


def call_worker(prompt: str, *, base: str, model: str, key: str, max_tokens: int) -> str:
    """POST to an OpenAI-compatible /chat/completions endpoint."""
    body = json.dumps(
        {
            "model": model,
            "max_completion_tokens": max_tokens,
            "messages": [
                {"role": "system", "content": WORKER_SYSTEM_PROMPT},
                {"role": "user", "content": prompt},
            ],
        }
    ).encode()

    req = urllib.request.Request(
        f"{base.rstrip('/')}/chat/completions",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {key}",
        },
        method="POST",
    )

    # Honors SSL_CERT_FILE / REQUESTS_CA_BUNDLE, which matters behind a proxy
    # that terminates TLS with its own CA.
    ctx = ssl.create_default_context()
    ca = os.environ.get("SSL_CERT_FILE") or os.environ.get("REQUESTS_CA_BUNDLE")
    if ca and Path(ca).exists():
        ctx.load_verify_locations(ca)

    try:
        with urllib.request.urlopen(req, context=ctx, timeout=900) as resp:
            payload = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")[:2000]
        fail(f"worker API returned {e.code}: {detail}")
    except urllib.error.URLError as e:
        fail(f"could not reach {base}: {e.reason}")

    try:
        return payload["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        fail(f"unexpected response shape: {json.dumps(payload)[:2000]}")


def parse_files(response: str) -> list[tuple[str, str]]:
    """Pull (path, contents) pairs out of the worker's envelope format."""
    files: list[tuple[str, str]] = []
    current_path: str | None = None
    buf: list[str] = []

    for line in response.splitlines():
        if current_path is None:
            m = FILE_BEGIN.match(line.strip())
            if m:
                current_path = m.group("path")
                buf = []
        elif line.strip() == FILE_END:
            files.append((current_path, "\n".join(buf) + "\n"))
            current_path = None
        else:
            buf.append(line)

    if current_path is not None:
        fail(f"worker output has an unterminated block for {current_path!r}")

    return files


def safe_target(rel_path: str) -> Path:
    """Resolve a worker-supplied path, refusing anything outside the repo."""
    if rel_path.startswith("/"):
        fail(f"refusing absolute path from worker: {rel_path}")
    target = (REPO_ROOT / rel_path).resolve()
    if not target.is_relative_to(REPO_ROOT):
        fail(f"refusing path outside repository: {rel_path}")
    return target


def main() -> None:
    ap = argparse.ArgumentParser(description="Delegate a spec to the worker model.")
    ap.add_argument("spec", type=Path, help="path to the spec markdown file")
    ap.add_argument("--apply", action="store_true", help="write the returned files to disk")
    ap.add_argument("--dry-run", action="store_true", help="print the prompt and exit")
    args = ap.parse_args()

    if not args.spec.is_file():
        fail(f"spec not found: {args.spec}")

    prompt = build_prompt(args.spec.read_text(), args.spec)

    if args.dry_run:
        print(prompt)
        return

    model = os.environ.get("WORKER_MODEL")
    key = os.environ.get("WORKER_API_KEY")
    if not model:
        fail("WORKER_MODEL is not set (see .env.example)")
    if not key:
        fail("WORKER_API_KEY is not set (see .env.example)")

    base = os.environ.get("WORKER_API_BASE", "https://api.openai.com/v1")
    max_tokens = int(os.environ.get("WORKER_MAX_TOKENS", "16000"))

    print(f"delegate: sending {args.spec} to {model} via {base}", file=sys.stderr)
    response = call_worker(prompt, base=base, model=model, key=key, max_tokens=max_tokens)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    raw_path = OUT_DIR / f"{args.spec.stem}.md"
    raw_path.write_text(response)
    print(f"delegate: raw response -> {raw_path.relative_to(REPO_ROOT)}", file=sys.stderr)

    files = parse_files(response)
    if not files:
        fail("worker returned no file blocks; inspect the raw response above")

    for rel_path, _ in files:
        print(f"  {'apply' if args.apply else 'proposed'}: {rel_path}")

    if not args.apply:
        print("\ndelegate: re-run with --apply to write these files.", file=sys.stderr)
        return

    for rel_path, contents in files:
        target = safe_target(rel_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(contents)

    print(f"\ndelegate: wrote {len(files)} file(s). Review the diff before committing.", file=sys.stderr)


if __name__ == "__main__":
    main()
