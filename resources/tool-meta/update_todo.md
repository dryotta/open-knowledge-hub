---
title: Update one todo
args:
  operation: "Whether to create a new todo or patch an existing one."
  container: "Target container for create operations."
  module: "Target memory module for create operations."
  text: "Todo text for create operations."
  entrySummary: "Optional dated-entry heading summary for create operations."
  observation: "Optional prose placed above the created todo in the dated entry."
  ref: "Opaque todo ref returned by todos; required for patch operations."
  completed: "Set true to complete a todo or false to reopen it during patch operations."
  labels: "Replace the todo labels during create or patch operations."
  due: "Set a YYYY-MM-DD due date, clear it with null on patch, or omit to leave it unchanged."
  priority: "Set a todo priority, clear it with null on patch, or omit to leave it unchanged."
---
Create or safely update one todo in a memory module. For a natural-language user request, first call `run { container, module, skill: "todo", input? }` and follow its returned discipline; call `sync` after a successful write. Never guess stale or ambiguous refs; always use the exact ref returned by `todos`.
