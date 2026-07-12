---
name: remember
description: Record a raw observation, event, or result into this memory module.
---

Record either an ordinary observation or todo-bearing input in exactly one target memory module.

## Ordinary observations

Use this branch for factual, small observations with no explicit action, commitment, reminder, or tracked task.

1. Append a single dated entry to a markdown file in this memory module (e.g. `YYYY-MM-DD.md`), newest entries at the bottom.
2. Each entry: an ISO timestamp heading (`## <ISO-8601>`), then the caller's observation preserved verbatim. Retain concrete references (paths, commands, outcomes).
3. Do NOT add a second summary, status line, certainty qualifier, cause hypothesis, conclusion, or recommendation — synthesis belongs in `reflect`.

Keep entries append-only; never rewrite history.
Maintain valid YAML frontmatter if the file already has one.

## Todo-bearing input

Use this branch when the input includes an explicit action, commitment, reminder, or tracked task.

1. Choose exactly one target memory module.
2. Call `todos { operation: "list", container, module }` first to inspect existing labels in that module.
3. Extract concise task text and keep any factual observation separate.
4. Normalize any explicit relative due date to `YYYY-MM-DD`.
5. Infer urgency only when it is implied, and use only `lowest`, `low`, `normal`, `medium`, `high`, or `highest`.
6. Prefer explicit labels. Otherwise reuse matching existing labels. Otherwise create short lowercase kebab-case labels. Fall back to `general`. Multiple category labels are allowed.
7. Call `todos` ONCE with `operation: "create"`, `container`, `module`, `text`, `entrySummary`, `observation`, `labels`, and optional `due` / `priority`, and `apply: true`.
8. Inspect and summarize the applied todo and memory entry.
9. Call `sync` for the affected container immediately.

Never add IDs, recurrence, or dependencies.
