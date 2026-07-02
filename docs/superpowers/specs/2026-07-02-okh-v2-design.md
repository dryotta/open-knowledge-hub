# OKH v2 — Design Spec

**Status:** Approved design (pre-implementation)
**Date:** 2026-07-02
**Supersedes:** the v1 "catalog of OKF knowledge packs" implementation (complete rewrite/replace)

---

## 1. Summary

The Open Knowledge Hub (OKH) is a minimalist [MCP](https://modelcontextprotocol.io)
server that organizes all agent-accessible knowledge and capabilities into
**containers** made of typed **modules**, each holding items such as memory,
knowledge, skills, tools, or project artifacts.

A small set of **five cognitive prompts** — `ask`, `context`, `learn`,
`remember`, `reflect` — provides the complete thinking loop for agents. A small
set of **three operational tools** — `inspect`, `add`, `sync` — manages and
syncs containers/modules and lets the agent discover content. A **unified graph**
that ties everything together is a forward-looking concept (see §9); initially
the agent scans and works on the local files directly.

v2 is a **complete rewrite** of v1 in the same repository, **reusing v1's proven
primitives** (process/`git`/`gh` plumbing and the vendored OKF discipline docs)
and **deleting** v1's pack/catalog service and tool/prompt surface.

## 2. Core Principles (inherited from v1)

1. **No server-side LLM.** OKH exposes only **deterministic tools** and
   **prompt templates that inject discipline text**. The **client agent does all
   reasoning** — grilling, scanning, retrieving, writing. OKH runs no model of
   its own. (v1 ADR-0001.)
2. **Git-native, with safe writes.** Content lives in folders that can be plain
   local directories, OneDrive-synced folders, or git repositories. Reuse v1's
   `exec`/`git`/`gh` layers. Git writes are either auto-synced (commit+push) or,
   for collaborative containers, published via pull requests.
3. **Discovery over interpretation.** Loaders enumerate items and surface
   metadata; they never interpret content. Skills and tools are **discovered and
   surfaced**, and executed by the **client agent** — OKH never runs arbitrary
   scripts.
4. **Prompts as both prompts and tools.** Each cognitive prompt is registered as
   an MCP **prompt** (nice UX) and an equivalent **tool** (works in any client),
   returning the same discipline text. (v1 pattern.)

## 3. Concepts

### Container
A self-contained workspace that groups everything in a single local folder. It is
the top-level unit and defines the scope in which an agent thinks and acts.
Backends:

- **Local filesystem** — a plain folder on disk.
- **OneDrive (or any OS-synced) folder** — a plain folder that the OS keeps
  synced; OKH treats it as local.
- **Git repository** — a versioned, optionally collaborative container that OKH
  keeps synced (see §6).

### Module
A typed subfolder inside a container. Each module declares *what kind of content*
it holds and *how the Hub loads it*. A container may hold multiple modules of the
same type. Module types:

| Type        | Status now      | Layout                                                        | Discovery unit                          |
|-------------|-----------------|---------------------------------------------------------------|-----------------------------------------|
| `knowledge` | Concrete (OKF)  | OKF bundle: `index.md` + concept `.md` (frontmatter + links)  | `index.md` progressive disclosure       |
| `skills`    | Concrete        | one subfolder per skill, each with a `SKILL.md`               | `SKILL.md` `name`/`description` frontmatter |
| `tools`     | Concrete        | one subfolder per tool, each with a `README.md` + script(s)   | `README.md` (name/description/usage)    |
| `memory`    | High-level/TBD  | a folder; concrete format TBD (see §9)                        | thin listing (files + any `README.md`)  |
| `project`   | High-level/TBD  | a folder; concrete format TBD (see §9)                        | thin listing (files + any `README.md`)  |

### Item
A single addressable unit inside a module: an OKF concept doc, a skill folder, a
tool folder, a memory entry, a project artifact. Loaders expose items as
`{ path, title, description, type }`.

## 4. Per-machine Layout

OKH keeps a per-machine registry under `$OKH_HOME` (default
`~/.open-knowledge-hub`). Git containers are cloned under `$OKH_HOME/containers/`;
local and OneDrive containers are registered **in place** (only referenced by
path).

```
~/.open-knowledge-hub/
├── registry.json                 # all registered containers
└── containers/
    └── my-hub/                   # a git container (cloned here)
        ├── .okh/
        │   └── okh.yaml          # container manifest
        ├── kb/                   # module: knowledge (OKF bundle)
        │   ├── index.md
        │   └── <concept>.md ...
        ├── skills/               # module: skills
        │   └── debugging/SKILL.md
        ├── tools/                # module: tools
        │   └── csv2json/{README.md, run.py}
        ├── mem/                  # module: memory (format TBD)
        └── proj/                 # module: project (format TBD)
```

`.okh/` is reserved for per-container OKH state. It holds `okh.yaml` now and is
the home for future per-container artifacts (a search index, cache, graph file).

### `registry.json` (per-machine)

```jsonc
{
  "version": 1,
  "containers": [
    {
      "name": "my-hub",
      "backend": "git",              // "git" | "local" | "onedrive"
      "origin": "https://github.com/me/my-hub.git", // git only
      "localPath": "/home/me/.open-knowledge-hub/containers/my-hub",
      "addedAt": "2026-07-02T00:00:00Z"
    },
    {
      "name": "notes",
      "backend": "local",
      "localPath": "/home/me/Documents/notes",
      "addedAt": "2026-07-02T00:00:00Z"
    }
  ]
}
```

### `.okh/okh.yaml` (per-container manifest)

```yaml
name: my-hub
sync: auto            # auto | pr   (git write model; ignored for local/onedrive)
modules:
  - path: kb
    type: knowledge
  - path: skills
    type: skills
  - path: tools
    type: tools
  - path: mem
    type: memory
  - path: proj
    type: project
    config: {}        # optional, type-specific loader settings
```

Rules:
- `name` required; should match the registry entry name.
- `sync` defaults to `auto`. `pr` selects the v1 pull-request write flow.
- `modules[].path` is relative to the container root; `type` is one of the five
  module types. `config` is optional and type-specific.
- Multiple modules of the same type are allowed.

## 5. Storage Backends

| Backend    | `add` behavior                                            | Where it lives                         | `sync` behavior                       |
|------------|-----------------------------------------------------------|----------------------------------------|---------------------------------------|
| `git`      | `git clone <origin>` into `$OKH_HOME/containers/<name>`    | managed under `$OKH_HOME`              | pull → commit → push (or PR); validate |
| `local`    | register the given path in place                          | user-chosen path                       | validate only (no VCS)                |
| `onedrive` | register the given path in place (OS handles file sync)   | user-chosen OneDrive path              | validate only (OS syncs files)        |

`onedrive` is functionally identical to `local` from OKH's perspective; it is a
distinct label so `inspect` can communicate that file sync is handled by the OS.

## 6. Write & Sync Model (git containers)

Hybrid, selected per container via `okh.yaml`'s `sync`:

- **`auto` (default):** `sync` performs `pull` → stage all changes → `commit`
  (message from the caller, or an OKH-generated default) → `push`. Suited to a
  personal hub with frequent small writes (e.g. `remember`).
- **`pr`:** the v1 pull-request flow — create a change branch `okh/<name>/<topic>`,
  commit, push, and open a PR via `gh` (never a direct push to the default
  branch). Suited to collaborative knowledge containers.

`sync` always **validates** the container regardless of backend: the manifest
parses, declared module folders exist, and each module conforms to its type's
minimal expectations (e.g. a `knowledge` module has a readable `index.md`).

Local/OneDrive containers have no VCS step; `sync` runs validation only.

## 7. Operational Tools (deterministic)

All three are registered as MCP tools. Errors surface as clean tool errors
(reuse v1's `OkhError` → tool-error mapping).

### `inspect { container?, module? }`
- **no args:** list all registered containers with `backend` (from
  `registry.json`) plus `sync` mode, state (path reachable + manifest valid),
  and module count (read from each container's `.okh/okh.yaml`).
- **`container`:** list that container's modules (`path`, `type`, item count)
  plus status — for git containers: branch, dirty, ahead/behind, unpushed; for
  all containers: manifest validity.
- **`container` + `module`:** list the module's items via its loader
  (`enumerate()`), plus the module's `config`.

### `add`
Disambiguates by arguments:
- **Add a container** `{ source, name?, sync? }` — `source` is a local/OneDrive
  path or a git URL. Registers the container in `registry.json`; a git source is
  cloned into `$OKH_HOME/containers/<name>`, a path source is registered in
  place. If `.okh/okh.yaml` is missing, scaffold a minimal one (empty `modules`).
- **Add a module** `{ container, path, type, config? }` — create the module
  folder if missing, append it to the manifest's `modules`, and scaffold a
  type-appropriate skeleton (e.g. an OKF `index.md` for `knowledge`).

### `sync { container?, message? }`
Synchronize and validate. Git containers follow the write model in §6; a caller
`message` is used for the commit (auto mode) or PR (pr mode). local/OneDrive
containers validate only. With no `container`, sync **all** registered
containers and return a per-container summary.

## 8. Cognitive Prompts (discipline text)

Each prompt is registered as **both** an MCP prompt and an equivalent tool. Each
resolves concrete filesystem paths from the registry + manifest and injects
discipline text that points the agent at those paths. **`container` and `module`
are optional, progressive filters:**

- neither → operate across the **whole hub** (all registered containers);
- `container` → scope to that container;
- `container` + `module` → scope to that specific module.

For **reads** (`ask`, `context`, and `reflect`'s scan phase), omitting
`container` means the injected discipline includes the full list of
containers → modules → resolved paths so the agent can scan across the hub.

For **writes** (`learn`, `remember`, and `reflect`'s write-back), a single target
is required: if exactly one candidate container/module exists it is used;
otherwise the discipline instructs the agent to **choose/confirm** a target from
the provided list before writing.

### `ask { container?, module?, question }`
Fork a fresh sub-agent that scans the target module(s) (starting from each
module's overview — OKF `index.md`, or a generated listing of `SKILL.md` /
`README.md` summaries) and returns a distilled, **cited** answer. Do not load
entire modules into the calling context. Reuses the vendored `okf-ask`
discipline for knowledge modules.

### `context { container?, task }`
Assemble everything relevant for a task — knowledge docs, applicable skills,
usable tools, prior memory, project artifacts — into a compact working set the
agent loads before acting.

### `learn { container?, module?, knowledge }`
Integrate new external information into a `knowledge` module. Applies the v1
`okf-learn` gate (default answer "no" unless it serves a goal) + `okf-writer` +
`OKF-FORMAT` disciplines, then writes via the §6 write model (auto commit+push,
or PR). Default target: the container's first `knowledge` module (or the one
specified).

### `remember { container?, module?, observation }`
Record a raw observation, event, or result into a `memory` module during a task.
Because the memory format is TBD (§9), the discipline records a **provisional**
entry (e.g. a timestamped markdown append) and is written via the §6 write model.

### `reflect { container?, module?, focus? }`
Process memory and experience to produce summaries, lessons, and improvements;
propose updates to `knowledge` (via the `learn` discipline) and, in the future,
to the graph. Reads memory module(s), then writes insights via the §6 write model.

## 9. Out of Scope / Future (kept high-level)

- **Unified graph.** A graph that ties items across modules together (for context
  assembly, workflow execution, and reflection-driven insight). Design is TBD.
  Initially the agent scans and works on local files directly; `.okh/` is reserved
  as the eventual home for a graph file/index.
- **Concrete `memory` format.** TBD; loader is a thin listing for now.
- **Concrete `project` format.** TBD; loader is a thin listing for now.
- **Real search/index.** Full-text and/or embedding-based search. For now,
  "search" = the agent scanning files directly, guided by the prompts. A
  deterministic `find` tool can be added later without changing the model.
- **OKH-side execution.** Running a tool's script or a skill from OKH. For now,
  discover-and-surface only; the client agent executes.
- **Automated v1 → v2 migration.** An existing v1 pack repo maps cleanly to a v2
  container with a single `knowledge` module (`.okh/okh.yaml` with one
  `type: knowledge` entry). Automated migration tooling is future work.

## 10. Implementation Plan (codebase)

Greenfield rewrite in the same repository, reusing v1 primitives.

**Reuse as-is / lightly adapted:**
- `src/index.ts` (stdio entry), `src/errors.ts` (`OkhError`), `src/exec.ts`
  (process spawning), `src/git/git.ts`, `src/git/gh.ts`, `src/util/mutex.ts`.
- `resources/okf/*` discipline docs (`OKF-FORMAT`, `okf-ask`, `okf-learn`,
  `okf-writer`, `okf-new-from-repo`) — reused by the `ask`/`learn` disciplines.
- `src/config.ts` — adapt: resolve `registry.json` (was `catalog.json`) and a
  `containers/` dir (was `packs/`).

**Delete/replace:**
- `src/catalog/*` → `src/registry/*`.
- `src/packs/service.ts` → `src/container/*` + `src/modules/*`.
- `src/discipline/index.ts` → `src/prompts/index.ts`.
- `src/server/tools.ts`, `src/server/prompts.ts` → v2 equivalents.

**New structure:**
```
src/
  index.ts
  config.ts                          # OKH_HOME, registry path, containers dir
  errors.ts
  exec.ts
  git/{git.ts, gh.ts}
  util/mutex.ts
  registry/
    schema.ts                        # registry.json + container entry (zod)
    registry.ts                      # load/save; add/remove/list containers
  container/
    manifest.ts                      # parse/validate .okh/okh.yaml (zod + yaml)
    service.ts                       # resolve paths, status, sync, add-module
  modules/
    types.ts                         # ModuleType, Item, Loader interface
    registry.ts                      # type → loader dispatch
    loaders/{knowledge,skills,tools,memory,project}.ts
  prompts/
    index.ts                         # build ask/context/learn/remember/reflect text
  server/
    index.ts                         # buildServer; wire tools + prompts
    tools.ts                         # inspect / add / sync
    prompts.ts                       # 5 prompts, registered as prompts AND tools
resources/
  okf/*                              # reused
  discipline/*                       # new v2 discipline text (context, remember, reflect)
```

**Loader contract** (`modules/types.ts`): each loader implements
`enumerate(moduleRoot): Item[]` and `overview(moduleRoot): string` (the type's
entry point — OKF `index.md`, or a generated listing of `SKILL.md` / `README.md`
summaries). Loaders are deterministic and do not interpret content.

**Dependencies:** add a YAML parser (`yaml`) for the manifest. Otherwise
unchanged: TypeScript on `@modelcontextprotocol/sdk`, `zod`, distributed via
`npx`, Node ≥ 18, requires `git` and `gh`.

## 11. Testing

Reuse vitest with real `git` against temporary repositories (v1 pattern):
- **Unit:** registry load/save + add/remove/list; manifest parse/validate
  (valid, missing fields, unknown type, missing module folder); each loader's
  `enumerate`/`overview`; tool handlers (`inspect`/`add`/`sync`); prompt-builder
  snapshots (stable discipline text).
- **Integration:** `add` (git + local) → `inspect` → `sync` round-trip against a
  temp git repo, asserting clone location, manifest scaffolding, commit/push (or
  PR branch) behavior, and validation errors.

## 12. Open Questions (non-blocking)

- Default container `name` derivation when `add` omits `name` (git basename vs
  folder basename) — implementation detail.
- Exact provisional `memory` entry shape used by `remember` before the format is
  finalized — pick a simple timestamped append; revisit in the memory-format spec.
