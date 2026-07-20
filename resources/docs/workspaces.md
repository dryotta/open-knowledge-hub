---
title: Workspaces and projects
description: Configure reusable workspaces, create durable projects, and coordinate frozen client-executed runs with human guidance and immutable results.
---

# Workspaces and projects

A `workspace` module hosts a reusable way of working. Examples include investigations,
presentations, proposals, and design studies.

```text
Workspace -> Project -> Run -> Result
```

- A **Workspace** supplies shared guidance, acceptance criteria, one lead agent, and an
  optional agent pool.
- A **Project** is a durable active or archived goal.
- A **Run** freezes exact inputs around one client-owned agentic loop.
- A successful run publishes one immutable **Result**. The project stays active so it
  can be revised again.

OKH stores the durable boundaries but runs no model. The MCP client plans, delegates,
asks the user, and iterates using the frozen profiles returned by the Hub.

## Set up a workspace

Create the module with a routing description and agent references:

```text
add_module {
  container: "work",
  path: "investigations",
  type: "workspace",
  description: "Investigate evidence-based questions and compare alternatives.",
  config: {
    lead: "coordinators/orchestrator",
    agents: [
      "research-agents/researcher",
      "review-agents/evidence-checker"
    ]
  },
  create: true
}
```

Then run its initialization discipline:

```text
run {
  container: "work",
  module: "investigations",
  skill: "initialize",
  input: "Use primary evidence, compare alternatives consistently, and state uncertainty."
}
```

The skill directs a workspace-level `create`:

```text
workspace {
  operation: "create",
  container: "work",
  module: "investigations",
  guidance: "Prefer primary evidence and state uncertainty.",
  acceptance: [
    "Material claims cite primary or authoritative sources.",
    "The conclusion states tradeoffs and unresolved risks."
  ],
  commandId: "<uuid>"
}
```

The manifest owns `description`, `lead`, and `agents`; edit those with `config`.
The workspace README owns guidance and acceptance; edit those with
`workspace { operation: "update" }`. Configuration changes affect future runs only.
OKH records initialization and shared README command outcomes in
`.okh/workspace-events.json`, so exact retries return their original response even after
later workspace or project changes.

Agent references support:

| Form | Meaning |
| --- | --- |
| `agent` | Unique agent ID in the current container |
| `module/agent` | Agent in one module of the current container |
| `container/module/agent` | Fully qualified agent |

## Create a project

Natural request:

> hub, start a new investigation into supplier concentration and recommend two
> alternatives by August 15.

The client discovers the workspace, runs its `create` skill, and calls:

```text
workspace {
  operation: "create",
  container: "work",
  module: "investigations",
  project: "supplier-concentration",
  title: "Supplier concentration investigation",
  goal: "Recommend two resilient alternatives with evidence and risks.",
  acceptance: ["Cover both North America and Europe."],
  targetDate: "2026-08-15",
  tags: ["sourcing", "strategy"],
  commandId: "<uuid>"
}
```

Creation does not start agent execution. The client calls `sync` after the durable
project write.

## Start, resume, and continue

Natural requests:

- `hub, investigate supplier concentration`
- `hub, resume the supplier concentration investigation`
- `hub, revise the supplier investigation using the latest regulator release`

All route through:

```text
run {
  container: "work",
  module: "investigations",
  skill: "coordinate",
  input: "<the user's exact request>"
}
```

The coordinate discipline first calls:

```text
workspace {
  operation: "get",
  container: "work",
  module: "investigations",
  project: "supplier-concentration",
  include: ["resume", "results"]
}
```

- With `activeRun`, it resumes the exact frozen run.
- Without `activeRun`, it calls `start` with the current ETag and optional correction.
- An archived project must be explicitly unarchived before a new run.

`start` returns the staging directory, exact workspace/project/agent snapshots, current
result file links, criterion IDs, and report contract. Before delegation, the client
must write, read, and delete a probe file in staging. A failed probe becomes a durable
paused report; no agent work begins.

The client applies the frozen lead profile, delegates to frozen pool profiles when
useful, reviews outputs, and iterates in its native agentic loop. It never calls live
`use_agent` for an active run.

## Pause, guide, and cancel

A client that needs durable human input reports:

```text
workspace {
  operation: "report",
  container: "work",
  module: "investigations",
  project: "supplier-concentration",
  run: "2026-07-19-002",
  state: "paused",
  checkpoint: {
    summary: "Regulator data needs interpretation.",
    stagedPaths: ["notes/regulator-data.md"],
    question: "Should its six-month lag be acceptable?"
  },
  etag: "sha256:...",
  commandId: "<uuid>"
}
```

The same conversation can ask the user directly. Guidance from another client or the
web UI uses:

```text
workspace {
  operation: "intervene",
  container: "work",
  module: "investigations",
  project: "supplier-concentration",
  run: "2026-07-19-002",
  action: "guide",
  guidance: "Use the dataset and label the six-month lag.",
  etag: "sha256:...",
  commandId: "<uuid>"
}
```

Guidance makes the run ready to resume but does not execute it. `cancel` closes any
active Hub run and rejects late reports; it cannot terminate an external client process
already running.

## Publish and revise results

For success, the client writes one complete output tree in staging and reports evidence
for every run-local criterion:

```text
workspace {
  operation: "report",
  container: "work",
  module: "investigations",
  project: "supplier-concentration",
  run: "2026-07-19-002",
  state: "succeeded",
  resultPath: ".",
  evidence: [
    { criterion: "workspace-1", references: ["report.md#sources"] },
    { criterion: "project-1", references: ["report.md#regional-coverage"] }
  ],
  etag: "sha256:...",
  commandId: "<uuid>"
}
```

OKH validates paths, evidence coverage, and fixed output limits, publishes an immutable
result, makes it current, and clears `activeRun`. To revise it, tell the client to
continue the project with a correction; that starts another run from the current
result. To make an older successful result current without rerunning:

```text
workspace {
  operation: "update",
  container: "work",
  module: "investigations",
  project: "supplier-concentration",
  action: "restore",
  fromRun: "2026-07-19-001",
  etag: "sha256:...",
  commandId: "<uuid>"
}
```

## Query and lifecycle

```text
workspace {
  operation: "list",
  container: "work",
  module: "investigations",
  status: "active",
  attention: true,
  tags: ["sourcing"],
  sort: "targetDate",
  order: "asc"
}
```

Projects have only `active` and `archived` status. A paused run remains active, so it
must be cancelled or reach a terminal report before archive or restore. Archived
projects are frozen until unarchived.

Every mutation uses a caller-generated UUID command ID. Retry the exact same arguments
with the same ID after a timeout; reusing it for different arguments conflicts.
Existing-content mutations also use the latest returned SHA-256 ETag. The Hub never
syncs implicitly, so the client calls `sync` after each requested durable boundary.
