---
name: todo
description: Add, complete, reopen, relabel, reprioritize, or reschedule todos in this memory module.
---

Manage this memory module's todos only through deterministic tools: `todos`, `update_todo`, and `sync`.

1. Call scoped `todos { container, module }` first.
2. Resolve the user's reference from those results. Use the opaque `ref` returned by `todos` for any patch operation.
3. If zero or multiple matches remain, ask the user to clarify and never guess.
4. Supported changes are: add a task, complete or reopen a task, replace labels, set or clear due, and set or clear priority.
5. For add requests, normalize any explicit relative due date to `YYYY-MM-DD` and keep the task text concise.
6. Present the exact proposed change and require confirmation before any write.
7. Call `update_todo` exactly once:
   - `operation: "create"` for add
   - `operation: "patch"` with the `ref` from `todos` for complete, reopen, replace labels, set or clear due, and set or clear priority
8. Report the local change, then call `sync` for the affected container.

Do not delete todos, rename task text, add IDs, manage recurrence or dependencies, or mutate custom statuses.
