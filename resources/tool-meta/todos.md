---
title: Manage todos
args:
  operation: "Operation to perform: list, create, or update; defaults to `list`."
  container: "Container name for list/create operations. Omit on list to scan all registered containers."
  module: "Memory module path for list/create operations. Omit on list to scan every memory module in scope."
  status: "List only: filter by todo status: open, completed, custom, or all."
  labels: "List/create/update: filter by normalized todo labels, set labels on create, or replace labels on update."
  labelMode: "List only: how labels match when labels are provided: any or all."
  priorities: "List only: filter by one or more todo priorities."
  dueAfter: "List only: keep todos due on or after this YYYY-MM-DD date."
  dueBefore: "List only: keep todos due on or before this YYYY-MM-DD date."
  overdue: "List only: when true, show only overdue open todos; when false, exclude overdue open todos."
  query: "List only: case-insensitive text query matched against todo text and labels."
  text: "Create only: todo text."
  entrySummary: "Create only: optional dated-entry heading summary."
  observation: "Create only: optional prose placed above the created todo in the dated entry."
  ref: "Update only: opaque todo ref returned by `todos`."
  completed: "Update only: set true to complete a todo or false to reopen it."
  due: "Create/update: set a YYYY-MM-DD due date, clear it with null on update, or omit to leave it unchanged."
  priority: "Create/update: set a todo priority, clear it with null on update, or omit to leave it unchanged."
  apply: "Create/update only: write the previewed change when true."
---
List, preview, create, or update Markdown todos in memory modules. `operation`
defaults to `list`. Create and update return a preview without writing unless
`apply: true` is supplied. Agent-driven requests present that preview and obtain
confirmation before applying; MCP App checkbox clicks may apply directly.

Use this directly only when asked to show, review, or filter a todo list, or when
an active memory-module skill already directed a deterministic todo mutation. For
a natural-language todo change, call `run` before `todos`: explicit remember
requests use `skill: "remember"`; other todo changes use `skill: "todo"`.
Agent-driven writes call `sync` afterward; MCP App changes remain local until
explicit sync.

Validation by operation:

- `list` accepts `container`, `module`, `status`, `labels`, `labelMode`,
  `priorities`, `dueAfter`, `dueBefore`, `overdue`, and `query`.
- `create` requires `container`, `module`, and non-blank `text`; it may also use
  `entrySummary`, `observation`, `labels`, `due`, `priority`, and `apply`. For
  create, `due` must be a valid YYYY-MM-DD date when present, and `priority`
  cannot be null.
- `update` requires the exact `ref` returned by `todos` and at least one of
  `completed`, `labels`, `due`, or `priority`; `due: null` clears the due date
  and `priority: null` clears a non-normal priority.
