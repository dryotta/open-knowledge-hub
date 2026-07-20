---
title: Manage workspaces and projects
args:
  operation: "Required operation: list, get, create, start, report, update, or intervene. Never call start directly: first call run with the selected workspace module and skill coordinate."
  container: "Exact container name that owns the workspace module."
  module: "Exact module path whose manifest type is workspace."
  project: "Project folder ID. Required for project/run operations; omit from workspace-level get, create, or update."
  status: "List only: active, archived, or all; defaults to active."
  attention: "List only: true selects projects whose active run is paused without later guidance; false excludes them."
  tags: "List/create only: normalized lowercase kebab-case tags to filter by or assign."
  tagMode: "List only: match any or all supplied tags; defaults to any."
  targetAfter: "List only: keep projects targeted on or after this YYYY-MM-DD date."
  targetBefore: "List only: keep projects targeted on or before this YYYY-MM-DD date."
  query: "List only: case-insensitive text matched against project ID, title, and tags."
  sort: "List only: updatedAt, createdAt, targetDate, or title; defaults to updatedAt."
  order: "List only: asc or desc; defaults by sort field."
  limit: "List only: page size from 1 through 100; defaults to 25."
  cursor: "List only: opaque nextCursor from a previous list response."
  include: "Get only: add resume and/or results details to a project response."
  title: "Project create only: non-empty display title."
  goal: "Project create only: non-empty goal written under the required Goal heading."
  guidance: "Workspace/project create guidance, or intervene guide text, depending on operation."
  acceptance: "Workspace/project create only: acceptance-criterion text in source order; a workspace needs at least one."
  targetDate: "Project create only: optional YYYY-MM-DD target date. Set it only when the user supplied the complete date including year; otherwise omit it."
  correction: "Start only: optional human correction for this new run."
  run: "Report/intervene only: exact active run ID."
  state: "Report only: paused, succeeded, failed, or cancelled."
  checkpoint: "Paused report only: summary plus optional stagedPaths, question, and reason."
  resultPath: "Successful report only: safe path relative to the run staging directory; use . for its root."
  evidence: "Successful report only: one entry per acceptance criterion with its run-local criterion ID and non-empty references."
  reason: "Failed/cancelled report or cancel intervention: human-readable reason."
  patch: "Update only: selected guidance, acceptance, title, goal, targetDate, or tags fields; null clears supported optional text/date fields."
  action: "Update: archive, unarchive, or restore. Intervene: guide or cancel."
  fromRun: "Restore only: successful run whose immutable result should become current."
  etag: "Mutation of existing workspace/project content: exact SHA-256 ETag returned by get or the previous mutation."
  commandId: "Mutation only: caller-generated UUID. Reuse the same ID and exact arguments only when retrying that command."
---
Manage durable projects and client-executed runs in a `workspace` module. This is one
deterministic tool with seven operations:

- `list` filters and paginates project summaries.
- `get` reads workspace settings or one project; `include: ["resume"]` reconstructs
  an active run from frozen inputs and `include: ["results"]` returns immutable result
  history.
- `create` initializes a workspace when `project` is omitted, or creates one active
  project when it is supplied.
- `start` freezes a new run and returns staging plus the orchestration inputs. It never
  resumes an existing run.
- `report` is the executing MCP client's only run-state write.
- `update` edits README-owned fields, archives/unarchives, or restores a prior result.
- `intervene` records external human guidance or cancellation on a live run.

**Mandatory routing gate for a natural-language request:**

- Run the target workspace skill before its mutations: `initialize` for initial setup,
  `configure` for settings, `create` for a new project, and `coordinate` before any
  start, resume, continuation, or revision. Never call `start` directly. Direct
  list/get, external cancellation, explicit archive/restore operations, and a read-only
  refusal of an impossible run do not need a skill.
- If the user names an existing project but omits its workspace, call root `inspect`,
  then query every discovered workspace with `workspace:list` before selecting a unique
  match. Do not infer the workspace from the project name or artifact type. If multiple
  matches remain, ask the user.
- If the user requests new work without naming a workspace, root `inspect` may select a
  unique workspace from its declared type and description.

Skills return the exact discipline for composing this tool with `config`,
`read_resource`, client-native subagents, and `sync`. Use resource-link URIs exactly as
returned by `workspace:get` or `workspace:start`; never construct or rewrite an OKH URI.

All mutations require `commandId`. Existing-content mutations also require `etag`;
stale state changes nothing. The tool does not run a model and never syncs implicitly.
Create command IDs with an actual RFC 4122 UUID generator available to the client; never
invent UUID-shaped literals.
After a requested durable unit completes, call `sync` for the changed container.
State/action-specific fields are strict: paused reports accept only `checkpoint`;
succeeded reports accept only `resultPath` and `evidence`; failed/cancelled reports
accept only `reason`; guide accepts `guidance`, while cancel accepts optional `reason`.

Examples:

```text
workspace {
  operation: "list",
  container: "work",
  module: "investigations",
  status: "active",
  attention: true,
  limit: 25
}

workspace {
  operation: "get",
  container: "work",
  module: "investigations",
  project: "supplier-risk",
  include: ["resume", "results"]
}

workspace {
  operation: "create",
  container: "work",
  module: "investigations",
  project: "supplier-risk",
  title: "Supplier risk",
  goal: "Recommend resilient alternatives with evidence and risks.",
  acceptance: ["Cover both operating regions."],
  tags: ["sourcing"],
  commandId: "<uuid>"
}

workspace {
  operation: "start",
  container: "work",
  module: "investigations",
  project: "supplier-risk",
  correction: "Use the latest regulator release.",
  etag: "sha256:...",
  commandId: "<uuid>"
}

workspace {
  operation: "report",
  container: "work",
  module: "investigations",
  project: "supplier-risk",
  run: "2026-07-19-002",
  state: "succeeded",
  resultPath: ".",
  evidence: [
    { criterion: "workspace-1", references: ["report.md#sources"] },
    { criterion: "project-1", references: ["report.md#coverage"] }
  ],
  etag: "sha256:...",
  commandId: "<uuid>"
}

workspace {
  operation: "update",
  container: "work",
  module: "investigations",
  project: "supplier-risk",
  action: "restore",
  fromRun: "2026-07-19-001",
  etag: "sha256:...",
  commandId: "<uuid>"
}

workspace {
  operation: "intervene",
  container: "work",
  module: "investigations",
  project: "supplier-risk",
  run: "2026-07-19-002",
  action: "guide",
  guidance: "Accept the lag and label the uncertainty.",
  etag: "sha256:...",
  commandId: "<uuid>"
}
```

A paused run remains active. Archive and restore therefore require it to reach a
terminal report or be cancelled. Cancellation closes the Hub record but cannot stop
an already-running external client process; late reports are rejected.
