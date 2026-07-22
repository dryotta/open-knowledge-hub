---
title: AGENTS.md best practices
description: How to write a high-signal AGENTS.md for a folder module, distilled from the agents.md standard and analysis of thousands of real files.
---

# AGENTS.md best practices

`AGENTS.md` is a "README for agents": freeform Markdown that tells an AI coding agent
how to work in a folder. It is machine-focused and distinct from a human `README.md`.
Keep it short, specific, and current — a sprawling file is the failure mode.

## Six core areas

Cover these where they apply; omit any that do not:

1. **Commands** — the exact commands to build, run, and format, each with its flags.
   Put the most-used commands first; agents copy these verbatim.
2. **Testing** — how to run the tests and what "passing" means. Name the single most
   useful command.
3. **Project structure** — where important files live and what each top-level area does.
4. **Code style** — language and versions, formatting rules, and naming conventions.
5. **Git workflow** — branch, commit, and PR expectations, if any.
6. **Boundaries** — explicit "never touch" rules. "Never commit secrets" is the single
   most common and most valuable constraint.

## Writing guidance

- Prefer executable commands and one real code example over paragraphs of prose.
- Be specific about the stack and versions; vague guidance produces vague behavior.
- State boundaries as explicit prohibitions ("never …"), not soft preferences.
- Point to the folder's own skills (`.agents/skills/`, `.claude/skills/`,
  `.github/skills/`) and say when to use each.
- Never invent commands, paths, versions, or tools — discover them from the folder.
- Iterate: tighten the file whenever an agent makes a mistake it could have avoided.

## Nesting

In a nested layout, the `AGENTS.md` nearest an edited file takes precedence. A folder
module's root `AGENTS.md` governs its whole tree unless a deeper `AGENTS.md` overrides
it for a subtree.
