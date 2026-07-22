---
name: initialize
description: Author or improve this folder module's AGENTS.md so agents can work in it effectively.
resources:
  - okh://docs/agents-md.md
---

# Initialize a folder module

This `folder` module is a space for unstructured work. Give it a high-signal
`AGENTS.md` at the module root so any agent — Claude Code, GitHub Copilot, or a client
that called `enter` — can work here effectively. Apply the embedded AGENTS.md
best-practices doc, but ground every line in this folder's actual contents.

## Stage 1 — Learn the folder

Call `inspect { container, module }` and read any existing `AGENTS.md` and top-level
files to learn the folder's real purpose, stack, commands, and conventions. Never
invent commands, paths, versions, or tools; discover them here or ask the user one
focused question at a time when a decision materially changes the guidance.

## Stage 2 — Write AGENTS.md

Write a concise `AGENTS.md` at the module root covering the six core areas from the
embedded best-practices doc where they apply to this folder:

1. **Purpose** — what the folder is for and who relies on it.
2. **Commands** — exact build/run/format commands, most-used first, with flags.
3. **Testing** — how to run tests and what "passing" means.
4. **Project structure** — where important files live.
5. **Code style** — languages, versions, formatting, naming.
6. **Git workflow** — branch/commit/PR expectations, if any.
7. **Boundaries** — explicit "never touch" rules; always include "never commit secrets".

Prefer executable commands and one real example over prose. If the folder has skills
under `.agents/skills/`, `.claude/skills/`, or `.github/skills/`, name them and say when
to use each.

## Stage 3 — Persist and verify

Write only `AGENTS.md` (and skill files if you author skills). Call
`inspect { container, module }` again to confirm the module is valid, then follow the
run tool's write policy and sync the changed container.

Report what you wrote and any boundary you set. Do not claim the Hub enforces commands,
permissions, or isolation; the executing client owns those controls.
