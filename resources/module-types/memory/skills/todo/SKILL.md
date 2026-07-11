---
name: todo
description: Add, complete, reopen, relabel, reprioritize, or reschedule todos in this memory module.
---

Manage this memory module's todos through deterministic `todos` mutations, then `sync`.

1. Call scoped `todos { operation: "list", container, module }`.
2. For update requests, resolve exactly one task `ref` from those results, or ask the user to clarify and never guess.
3. Supported changes are: add a task; complete or reopen a task; replace labels; set or clear due; and set or clear priority.
4. For add requests, normalize any explicit relative due date to `YYYY-MM-DD` and keep the task text concise.
5. Call `todos` with `operation: "create"` or `operation: "update"` for the single intended mutation, and omit `apply`.
6. Present the exact returned preview, surface `needsConfirmation`, and require explicit confirmation before any write.
7. After confirmation, repeat the identical `todos` mutation with `apply: true`.
8. Call `sync` for the affected container.

Use this skill for natural-language todo management, but skill invocation is not an authorization token: every deterministic todo operation still goes through `todos`.

Do not delete todos, rename task text, add IDs, manage recurrence or dependencies, or mutate custom statuses.
