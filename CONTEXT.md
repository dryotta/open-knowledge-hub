# Context: open-knowledge-hub

Glossary for the open-knowledge-hub MCP — a server that organizes agent knowledge
and capabilities into containers of typed modules. The server runs no LLM; it
provides deterministic tools + discipline text and the client agent does all
reasoning.

## Terms

### Hub
The system itself: this MCP server, addressed by a wake phrase (default `hub`).
There is one hub; it manages any number of containers. Modules live inside
containers, never directly in the hub. "Across the hub" means across all
registered containers.

### Container
A self-contained workspace in a local folder; the top-level unit. Backends:
`local` folder, `onedrive` (OS-synced) folder, or `git` repository. Registered in
the per-machine registry; git containers are cloned into `$OKH_HOME/containers/`,
local/onedrive folders are registered in place by path.

### Registry
The per-machine set of registered containers: `$OKH_HOME/registry.json` (default
`~/.open-knowledge-hub/registry.json`). Each entry has a `name`, `backend`, `sync`
mode (`auto` | `pr`), optional `origin` (git), and `localPath`. Container `name`
and `sync` are set at `add`-time, not in a per-container file.

### Module manifest (`<module>/.okh/module.yaml`)
Each module folder carries a manifest with `type`, `name`, `description` (optional),
and `config` (optional). The hub auto-discovers modules by scanning the container
for these manifests — a folder is a module iff it has `.okh/module.yaml`.
Built-in types ship vendored skills (`knowledge` → `learn`; `memory` → `remember`,
`reflect`). Module-local skills are discovered from `.okh/skills/` and common
external roots like `.claude/skills/`. `.okh/` is reserved for OKH state.

### Module
A self-contained typed subfolder with its own `.okh/module.yaml`. Built-in types:
`knowledge` (OKF bundle), `memory`. Custom types (any other string) use a generic
file-listing loader; skills come entirely from the module. A loader per type
enumerates items and produces an overview; loaders never interpret content.

### Sync model
`auto`: `sync` commits local changes and pushes (fast-forward pull to integrate
remote). `pr`: commit on a branch, push, and open a pull request via `gh`. Local/
OneDrive containers are validated only. `sync` always validates module manifests
and conformance.

### Cognitive flows
`ask` (query), `context` (assemble a working set), `onboard` (guided setup), `run`
(invoke a named skill on a module). `learn`, `remember`, `reflect` are **skills**,
not standalone tools — invoke them via `run { container, module, skill, input? }`.
Each flow returns discipline text (instructions the agent follows); a flow never
reads or writes itself — the agent does. Exposed as both MCP prompts and
prompt-tools (identical content).

## Runtime & surface
- TypeScript on `@modelcontextprotocol/sdk`, `zod`, `yaml`; run via `npx`. Requires
  `git`; `gh` only for `pr`-mode containers. See ADR-0001, 0002, 0004.
- Operational tools (act on state): `inspect`, `add`, `sync`, `config`.
- Flows (return discipline/instructions, never act): `ask`, `context`, `onboard`,
  `run`. Each is exposed as a prompt-tool and as an MCP prompt with identical
  content.
