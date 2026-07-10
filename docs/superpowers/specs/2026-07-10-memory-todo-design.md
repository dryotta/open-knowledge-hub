# Memory Todo Lists and MCP App

**Status:** Approved design  
**Date:** 2026-07-10

## 1. Summary

Add Obsidian-compatible todo lists to `memory` modules. Todos remain ordinary
Markdown checkboxes inside dated memory files. The Hub deterministically scans,
filters, and updates them; the client agent still performs all language
understanding.

The feature adds:

- tolerant Obsidian Tasks parsing across memory Markdown;
- automatic todo recognition in the `remember` skill;
- label, due-date, and priority management;
- a `todo` memory skill for explicit management;
- deterministic read/update MCP tools;
- an MCP App for filtering and completing/reopening tasks.

## 2. Goals and non-goals

### Goals

1. Keep todos portable, human-readable, and usable in Obsidian.
2. Discover todos across all registered memory modules by default.
3. Let labels represent multiple lists such as `#shopping`, `#work`, and
   `#private`.
4. Render todo-list requests as an MCP App when the host supports MCP Apps, with
   a useful text fallback otherwise.
5. Support local status changes from the app and broader changes through a
   memory skill.
6. Preserve user-authored Markdown and tolerate missing or malformed optional
   metadata.

### Non-goals

- recurring tasks and dependencies;
- deletion or task-text editing in the app;
- automatic git sync after each change;
- full support for custom Obsidian checkbox statuses;
- a sidecar database or index;
- server-side natural-language interpretation.

## 3. External conventions

The design follows the Obsidian Tasks plugin's Markdown model:

- a task is a one-line Markdown checkbox;
- standard tags organize and filter tasks;
- `📅 YYYY-MM-DD` stores a due date;
- `➕ YYYY-MM-DD` stores a created date;
- `✅ YYYY-MM-DD` stores a completion date;
- priority is represented by the Tasks priority emojis;
- `🆔 value` is accepted when users author it, but OKH never inserts IDs
  automatically.

MCP App delivery follows the stable MCP Apps extension:

- a model-visible tool references a `ui://` resource through
  `_meta.ui.resourceUri`;
- the resource uses `text/html;profile=mcp-app`;
- the app receives the tool result and may call server tools through the host;
- non-supporting hosts continue to receive normal tool output.

References:

- <https://publish.obsidian.md/tasks/Reference/Task+Formats/Tasks+Emoji+Format>
- <https://publish.obsidian.md/tasks/Getting+Started/Priority>
- <https://modelcontextprotocol.io/extensions/apps/overview>
- <https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx>

## 4. Markdown contract

### 4.1 Discovery

The only required syntax is a one-line Markdown checkbox. Recognize unordered
and ordered list forms, including:

```markdown
- [ ] Buy milk
* [x] Submit report
1. [ ] Call the dentist
```

Scan Markdown files recursively inside every selected memory module. Do not
follow symlinks and do not scan `.okh` or `.git`.

Recognize:

- `[ ]` as open;
- `[x]` and `[X]` as completed;
- any other checkbox character as a visible but read-only custom status.

`#todo` is not required for discovery. It is a default marker on OKH-created
tasks so Obsidian users may configure it as a global Tasks filter.

### 4.2 Optional fields

All fields are optional and parsed independently:

| Field | Markdown | Normalized value |
|---|---|---|
| Labels | `#shopping #private` | lowercase comparison, original text preserved |
| Priority | `⏬` `🔽` `🔼` `⏫` `🔺` | lowest, low, medium, high, highest |
| Due | `📅 2026-07-11` | ISO calendar date |
| Created | `➕ 2026-07-10` | ISO calendar date |
| Completed | `✅ 2026-07-12` | ISO calendar date |
| Existing ID | `🆔 abc123` | optional lookup aid |

No priority emoji means normal priority.

Every tag except the reserved `#todo` marker is a todo label. Multiple labels
are allowed. New inferred labels are short lowercase kebab-case tags; existing
valid labels, including nested tags, are preserved.

Missing fields are normal. A malformed optional field adds a parse warning but
does not hide the task. The parser tracks source spans for known fields so an
edit changes only the requested syntax instead of regenerating the line.

### 4.3 New task format

OKH creates a task inside the current dated memory file:

```markdown
### 2026-07-10T21:27:12.254Z — Todo

- [ ] Buy milk #todo #shopping 🔼 📅 2026-07-11 ➕ 2026-07-10
```

Creation defaults:

- add `#todo`;
- add one or more supplied or inferred category labels;
- use `#general` when no category can be determined;
- add the created date;
- add due date and priority only when supplied;
- never add `🆔` automatically.

The parser accepts metadata in any order. The serializer emits a canonical order
for newly created or newly inserted fields: labels, priority, due date, created
date, completion date, existing ID.

### 4.4 Completion

Completing a task changes its checkbox to `[x]` and adds or replaces
`✅ YYYY-MM-DD`. Reopening changes it to `[ ]` and removes the completion date.
Other fields and raw Markdown remain unchanged.

## 5. Architecture

### 5.1 `TodoService`

Add a focused deterministic service with these responsibilities:

1. resolve selected memory modules;
2. enumerate Markdown files;
3. parse checkbox lines into normalized todo records;
4. filter and sort records;
5. create a task in today's memory file;
6. patch status, labels, due date, or priority;
7. preserve unrelated Markdown during writes.

The service has no language model and does not infer labels, dates, or priority.
It accepts normalized values from tools.

The parser/serializer is a separate unit from filesystem scanning and mutation
so each can be tested independently.

### 5.2 Stable update locator without automatic IDs

Each returned todo includes an opaque locator containing:

- container and module identity;
- relative Markdown path;
- original line number;
- a fingerprint of the exact task line;
- an existing Obsidian task ID when present.

Before writing, the service re-reads the file:

1. use a unique existing task ID when available;
2. otherwise verify the original line and fingerprint;
3. if the line moved, search the file for exactly one fingerprint match;
4. reject missing, changed, duplicate, or ambiguous matches.

The service never guesses and never inserts an ID. A stale error tells the app
or agent to refresh and retry.

### 5.3 Memory module integration

Add a memory-specific resolver that returns only modules whose manifest type is
`memory`. Default todo queries aggregate all such modules across registered
containers. Optional container and module arguments narrow the scope.

The existing general memory loader may remain a file listing; todo discovery is
a dedicated capability because it requires recursive parsing and mutations.

## 6. MCP tools

### 6.1 `todos`

`todos` is read-only, model-visible, and app-callable. It accepts optional:

- `container`;
- `module`;
- `status`: `open`, `completed`, `custom`, or `all`;
- `labels` and `labelMode`: `any` or `all`;
- `priorities`;
- due-date bounds and overdue-only mode;
- case-insensitive text query.

With no scope or filters, it returns all todos from all memory modules. The text
fallback summarizes counts and lists matching tasks. Structured content contains:

```ts
interface TodoListResult {
  tasks: TodoRecord[];
  warnings: TodoWarning[];
  counts: {
    total: number;
    open: number;
    completed: number;
    custom: number;
  };
}
```

The tool metadata links to:

```text
ui://open-knowledge-hub/todos
```

### 6.2 `update_todo`

`update_todo` is model-visible and app-callable. It supports two operations:

```ts
type UpdateTodoInput =
  | {
      operation: "create";
      container: string;
      module: string;
      text: string;
      entrySummary?: string;
      observation?: string;
      labels?: string[];
      due?: string;
      priority?: TodoPriority;
    }
  | {
      operation: "patch";
      ref: string;
      completed?: boolean;
      labels?: string[];
      due?: string | null;
      priority?: TodoPriority | null;
    };
```

At least one patch field is required. The tool validates dates, priorities,
labels, scope, and locator freshness before writing.

`entrySummary` and `observation` let `remember` place factual memory and its
related checkbox in one dated entry. A plain `todo` skill create omits them and
uses the default `Todo` summary.

Create and patch affect one memory module and one Markdown file per call. The
result returns the updated normalized task and the affected container so clients
can report that local unsynced changes exist.

### 6.3 Tool routing

Hub instructions and tool descriptions explicitly route requests to show, list,
filter, or review todos to `todos`, rather than `ask` or raw file inspection.

## 7. Skills

### 7.1 Updated `remember`

`remember` continues to record factual memory. It additionally identifies an
explicit action, commitment, reminder, or task the user wants tracked.

For a todo:

1. determine one target memory module;
2. extract concise task text;
3. normalize any explicit relative due date to `YYYY-MM-DD`;
4. map explicit urgency to an Obsidian priority;
5. use user-supplied labels when present;
6. query existing module todos and reuse semantically matching labels;
7. otherwise create concise lowercase labels, falling back to `general`;
8. preview the write and obtain confirmation;
9. call `update_todo` with `operation: "create"`, including the entry summary
   and factual observation when present;
10. call `sync` after the user approves persistence, following the existing write
    policy.

If the input contains both a factual observation and a todo, record both in the
same dated entry.

### 7.2 New `todo` memory skill

Add a vendored `todo` skill for:

- adding a task;
- completing or reopening a task;
- replacing labels;
- setting or clearing a due date;
- setting or clearing priority.

The skill resolves natural-language references by querying `todos`, presents the
exact proposed task change, obtains confirmation, calls `update_todo`, and then
uses the normal `sync` flow.

The skill does not delete tasks, rename task text, or manage recurrence in v1.

## 8. MCP App

### 8.1 Delivery

Use `@modelcontextprotocol/ext-apps` server helpers to register the `todos` tool
and its UI resource. Build the UI as a single local HTML bundle shipped under
`dist`; it requires no network access or external resource domains.

The app consumes the initial `todos` structured result and calls server tools
through the MCP App bridge.

### 8.2 Layout and behavior

Use a responsive filter bar above one unified list.

Filters:

- open/completed/custom/all;
- multi-select labels;
- source container/module;
- priority;
- due state or range;
- text search.

Task rows show:

- checkbox;
- task text;
- label chips;
- due date;
- priority;
- container/module/file source;
- parse warning or read-only status when relevant.

The default view shows open tasks sorted by:

1. overdue;
2. nearest due date;
3. higher priority;
4. newest created date;
5. source path and line for deterministic ties.

Filtering and sorting are client-side after the initial result for immediate
feedback.

The app only completes and reopens tasks in v1. During an update it disables the
row. On success it applies the returned task in place and marks the affected
container as locally changed. On stale or ambiguous failure it shows the error
and refreshes through `todos`.

The app does not call `sync`. It tells the user that changes are local and may be
synced through the normal conversation flow.

### 8.3 Text fallback

When the host does not support MCP Apps, `todos` still returns concise Markdown:
counts, active filters, and matching tasks grouped by label or source as
appropriate.

## 9. Writes, concurrency, and safety

- A skill follows the existing preview, confirmation, write, and sync policy.
- An app checkbox click is explicit authorization for that local status change.
- App changes remain local until the user invokes the existing `sync` flow.
- Validate every resolved path remains beneath the selected memory module.
- Do not follow symlinks during scanning or writing.
- Serialize mutations with a service mutex.
- Write through a temporary sibling file and atomic rename.
- Preserve the file's newline style and final-newline state.
- Reject invalid ISO dates, unknown priorities, invalid labels, empty task text,
  empty patches, unsupported custom-status mutations, and stale locators.
- Surface parse warnings and mutation errors; do not silently drop fields or
  return success-shaped fallbacks.

## 10. Testing and validation

### Parser and serializer

- unordered and ordered checkbox forms;
- bare tasks with every optional field absent;
- each optional field independently present;
- multiple labels and nested tags;
- all supported priorities and normal priority;
- uppercase completed state;
- custom read-only states;
- malformed dates and metadata warnings;
- metadata in different orders;
- unknown metadata preservation;
- CRLF/LF and final-newline preservation.

### Service

- recursive scans across multiple containers and memory modules;
- exclusion of non-memory modules, `.okh`, `.git`, and symlinks;
- filtering and deterministic sorting;
- append to existing and new dated files;
- completion and reopening dates;
- label, due-date, and priority patches;
- existing unique IDs, moved-line recovery, stale content, duplicate content,
  duplicate IDs, and ambiguous matches;
- path-escape rejection and atomic-write behavior.

### MCP surface and app

- `todos` and `update_todo` schemas, annotations, text, and structured output;
- `ui://` resource registration and `text/html;profile=mcp-app`;
- app tool-result rendering, filters, sorting, successful toggles, and stale
  refresh;
- text fallback when UI capabilities are absent;
- updated exact tool-surface expectations.

### Skills and evals

- `remember` distinguishes ordinary memory from explicit tracked actions;
- supplied and inferred labels;
- due-date and priority normalization;
- `todo` skill create and patch flows;
- todo-list requests route to `todos`;
- app status changes do not auto-sync.

Run:

- `npm run build`;
- `npm run typecheck`;
- `npm test`;
- `npm run typecheck:eval`;
- `npm run test:eval`;
- `npm run eval:validate`;
- `npm run eval` for the full end-to-end suite.

## 11. Acceptance criteria

1. A bare checkbox in any memory Markdown file appears in `todos`.
2. Missing optional metadata never prevents listing or unrelated updates.
3. `remember` can create a labeled, dated, prioritized Obsidian-compatible task.
4. Multiple labels can be filtered individually or together.
5. A todo-list request invokes a tool linked to the MCP App and has a useful text
   fallback.
6. The app completes and reopens a task without changing unrelated Markdown.
7. Stale or ambiguous source changes fail explicitly and never edit the wrong
   task.
8. The `todo` skill can add, complete/reopen, relabel, and change due date or
   priority.
9. App edits remain local until the normal `sync` flow is invoked.
10. Build, unit tests, eval validation, and the full end-to-end eval pass.
