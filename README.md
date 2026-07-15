# open-knowledge-hub

A minimalist [MCP](https://modelcontextprotocol.io) server that organizes all
agent-accessible knowledge and capabilities into **containers** made of typed
**modules**. The **hub** is the system itself; it manages your containers.

It exposes three kinds of surface. **Operational tools** (`inspect`, `add_container`, `add_module`, `sync`,
`config`, `todos`) *act* — they read state or change containers. Four **flows** (`ask`,
`context`, `onboard`, `run`) *return instructions*: each hands your agent discipline
text to follow. A flow never acts on its own — your agent does the reasoning and
any edits. A **diagnostic tool** (`capabilities`) probes which MCP client features are
active and immediately tests them with live requests. The same process also hosts a
loopback-only web UI for browsing modules/files and managing todos. The server runs
**no LLM** — it exposes deterministic tools and injects discipline text; your agent
does all the reasoning.

## Concepts

- **Hub** — the system itself (this server), which you address by a wake phrase.
  There is one hub; it manages any number of containers. Modules always live
  inside a container, never directly in "the hub".
- **Container** — a self-contained workspace in a local folder. Backends: a plain
  **local** folder, a **OneDrive** (OS-synced) folder, or a **git** repository
  (cloned + synced). Registered in a per-machine `registry.json` under `$OKH_HOME`
  (default `~/.open-knowledge-hub`); git containers are cloned into
  `$OKH_HOME/containers/`, local/OneDrive folders are registered in place.
- **Module** — a self-contained typed subfolder. Each module carries its own
  `.okh/module.yaml` manifest (`type`, `name`, `description`, optional `config`).
  The hub auto-discovers modules by scanning the container for these manifests.
  Built-in types: `knowledge` (OKF markdown), `llmwiki` (OKF-backed living wiki),
  `memory`, and `skills` (a folder of `SKILL.md` skills, organized under any depth of
  subfolders, with an `index.md` scope contract describing what belongs in the module;
  a skill can also launch/run a CLI tool). Custom types (any other string) use a generic
  file-listing loader; skills come entirely from the module.

### Module manifest (`<module>/.okh/module.yaml`)
```yaml
type: knowledge   # built-in (knowledge, skills, memory, llmwiki) or any custom string
name: my-kb
description: Project notes   # optional
# config: {}                 # optional, type-specific
```

The container's `name` and `sync` mode (`auto` | `shared`) are set in the **registry
entry** at `add_container`-time, not in a per-container file.

### Type skills
Built-in types ship vendored skills: `knowledge` → `learn`, `initialize`; `llmwiki`
→ `initialize`, `write`, `lint`; `memory` → `remember`, `reflect`, `todo`; `skills`
→ `initialize` (under `resources/module-types/<type>/skills/`). A module's
effective skill set = vendored (for its type) ∪ module-local skills (discovered from
`.okh/skills/` and common roots like `.claude/skills/`). Shared, module-less skills
(`grilling`, `okf-writer`, `ingest`) live under `resources/shared/skills/` and run via
<!-- ingest can keep a copy of each ingested source in the module (opt-in per module; ./sources/<YYYY-MM>/). -->
`run { skill }` with no container/module. Skills use the standard `SKILL.md` format.

### Memory todos

Every Markdown checkbox in a memory module is discoverable as a todo, including
Obsidian Tasks-style lines. Todos may include tags/category labels, priority emoji,
due dates (`📅 YYYY-MM-DD`), created dates (`➕ YYYY-MM-DD`), and completion dates
(`✅ YYYY-MM-DD`). Existing IDs can provide stable lookup, but OKH never generates
them. Ordinary open and completed statuses are editable; custom checkbox statuses
are visible but read-only.

Supporting hosts render the unified todo list and filters as an MCP App. Every
`todos` result also includes the live browser URL for the hosted todo frontend.
`todos { operation: "create" | "update" }` writes when `apply: true` is supplied;
omit it for an explicit preview. Agent-driven mutations pass `apply: true` directly
and sync immediately. MCP App actions may apply directly and remain local until an
explicit `sync`.

## Web UI

Each running MCP server instance hosts a web UI on `127.0.0.1`. The default port is
assigned dynamically to avoid conflicts; call `todos` to get the current `/todos`
URL. The UI provides:

- `/browse` — containers, modules, directory navigation, and text-file previews.
- `/todos` — todo filters, creation, completion/reopen, and unsynced-change notices.

Set `OKH_WEB_PORT` to a specific port when a stable local URL is needed, for example
`"env": { "OKH_WEB_PORT": "8787" }`. The server intentionally rejects non-loopback,
cross-origin, and DNS-rebound requests because the UI can read local module files.

## MCP surface

OKH exposes three kinds of tools plus matching prompts.

### Operational tools (perform actions)

These read state or change containers directly.

| Tool | Args | Purpose |
| --- | --- | --- |
| `inspect` | `container?`, `module?` | List containers / a container's modules+status / a module's items. |
| `add_container` | `source`, `name?`, `sync?`, `backend?`, `create?` | Register a container. Returns a plan unless `create:true`. |
| `add_module` | `container?`, `path?`, `type?`, `name?`, `description?`, `config?`, `create?` | Returns a step-by-step workflow to add/create/initialize a module; applies on `create:true` (identity args required then). |
| `sync` | `container?`, `message?`, `action?` | Validate + synchronize. `auto`-mode git: commit+push to origin. `shared`-mode git: commit+push shared branch rebased onto origin/main; `action: "publish-pr"` (shared-mode only) opens or returns the existing PR to main. |
| `config` | `set?` | View configuration (no args) or change it, e.g. `{ set: { wakePhrase: "brain" } }`. |
| `todos` | `operation?`, `container?`, `module?`, `status?`, `labels?`, `labelMode?`, `priorities?`, `dueAfter?`, `dueBefore?`, `overdue?`, `query?`, `text?`, `entrySummary?`, `observation?`, `ref?`, `completed?`, `due?`, `priority?`, `apply?` | Unified todo API: `list` reads across memory modules, `create` previews or adds one todo, and `update` previews or mutates one todo by opaque `ref`. Writes stay local until `sync`. |

### Diagnostic tool

| Tool | Args | Purpose |
| --- | --- | --- |
| `capabilities` | _(none)_ | Detect and immediately test advertised client roots, sampling, and form elicitation; report MCP Apps extension negotiation. |

> **Note:** `capabilities` is a diagnostic/interactive tool. If sampling is advertised it triggers a small client-model request; if form elicitation is advertised it displays a confirmation prompt. Output never includes returned roots, sampled content, elicited values, extension config, or raw client errors.

### Flows (return instructions — they do not act)

Each flow returns **discipline text**: step-by-step instructions your agent
follows to do the work. A flow never reads or writes your files itself — your
agent does the reasoning and any edits, then persists with `sync`. All four are
exposed both as prompt-tools (below) and as MCP prompts (for clients with a
prompt UI), with identical content.

| Flow | Args | Returns instructions to… |
| --- | --- | --- |
| `ask` | `container?`, `module?`, `question?` | …answer a question from your containers' modules. |
| `context` | `container?`, `task?` | …assemble a task's working set across your containers. |
| `run` | `container`, `module`, `skill`, `input?` | …invoke a named skill on a module (`learn`, `remember`, `reflect`, `todo` are skills, not standalone tools). |
| `onboard` | _(none)_ | …guide first-run setup (terminology, wake phrase, first container + modules). |

**Prompts (4):** `ask`, `context`, `onboard`, `run` — the
same four flows, for clients with a prompt UI. Content matches the prompt-tools
exactly. `container`/`module` are optional filters: omit them to span every
registered container (the whole hub).

**Resources:** `ui://open-knowledge-hub/todos` provides the embedded unified
memory-todo list for MCP App-capable hosts. Tool results also link to the hosted
browser frontend.

## Prerequisites

- **Node.js ≥ 18** (ships with `npx`).
- **git** — clone/commit/branch/push.
- **[GitHub CLI](https://cli.github.com/) (`gh`)**, authenticated — required for git
  containers using `shared` sync (to resolve the default branch `user/<gh-login>/hub`)
  and to open pull requests via `sync { action: "publish-pr" }`. The server stores no
  credentials.

## Installation

Run straight from GitHub via `npx` (builds on first launch):
```jsonc
{
  "mcpServers": {
    "open-knowledge-hub": {
      "command": "npx",
      "args": ["-y", "github:dryotta/open-knowledge-hub"]
      // "env": { "OKH_HOME": "/Users/me/.open-knowledge-hub" }
    }
  }
}
```

See **[SETUP.md](./SETUP.md)** for the full walkthrough, including first-run
onboarding — say **"Use the Open Knowledge Hub MCP and run onboard to set me up."**

## Typical usage

- `add_container { source: "https://github.com/me/my-notes.git", name: "my-notes" }` → clone + register a container.
- `add_module` → returns a step-by-step workflow; after proposing the module, `add_module { container: "my-notes", path: "kb", type: "knowledge", name: "kb", create: true }` adds it.
- `run { container: "my-notes", module: "kb", skill: "learn", input: "..." }` → your agent
  folds knowledge in, then `sync { container: "my-notes" }` commits+pushes.
- `ask { container: "my-notes", question: "..." }` → cited answer from the modules.
- `todos { labels: ["shopping"], status: "open" }` → interactive filtered list (or text fallback).
- `todos {}` → list todos and return the live hosted `/todos` URL.
- `todos { operation: "create", container: "my-notes", module: "mem", text: "Buy milk", labels: ["shopping"], apply: true }` → write the todo immediately and sync.
- `todos { operation: "update", ref: "<opaque-ref>", completed: true, apply: true }` → apply a completion immediately and sync. Omit `apply: true` for an explicit preview. MCP App checkbox clicks apply directly; changes remain local until `sync`.

## Wake phrase

Address the hub by its wake phrase (default `hub`), e.g. `hub, ask …` or
`hub, run …`.
Change it with the `config` tool (`config { set: { wakePhrase: "brain" } }`); OKH
stores it in `$OKH_HOME/preferences.json` and announces it in the server
instructions. See **[USAGE.md](./USAGE.md)** for recommended prompts.

## Development

See **[DEVELOPMENT.md](./DEVELOPMENT.md)** for build, test, and eval commands, and
how to run a local development build in your MCP client.

## License

MIT
