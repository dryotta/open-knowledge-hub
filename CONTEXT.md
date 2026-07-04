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
`~/.open-knowledge-hub/registry.json`). Each entry has a `name`, `backend`,
optional `origin` (git), and `localPath`.

### Manifest (`.okh/okh.yaml`)
Per-container file declaring `name`, `sync` mode (`auto` | `pr`), and `modules`
(each `path` + `type` + optional `config`). `.okh/` is reserved for OKH state.

### Module
A typed subfolder: `knowledge` (OKF bundle), `skills` (`SKILL.md` folders),
`tools` (folders with `README.md`), `memory` / `project` (format TBD). A loader per
type enumerates items and produces an overview; loaders never interpret content.

### Sync model
`auto`: `sync` commits local changes and pushes (fast-forward pull to integrate
remote). `pr`: commit on a branch, push, and open a pull request via `gh`. Local/
OneDrive containers are validated only. `sync` always validates the manifest and
module conformance.

### Cognitive flows
`ask` (query), `context` (assemble a working set), `learn` (integrate into
knowledge, OKF), `remember` (record into memory), `reflect` (memory → insight).
Each returns discipline text (instructions the agent follows) pointing at resolved
module paths; a flow never reads or writes itself — the agent does. Exposed as
both MCP prompts and prompt-tools (identical content). `container`/`module` are
optional filters.

## Runtime & surface
- TypeScript on `@modelcontextprotocol/sdk`, `zod`, `yaml`; run via `npx`. Requires
  `git`; `gh` only for `pr`-mode containers. See ADR-0001, 0002, 0004.
- Operational tools (act on state): `inspect`, `add`, `sync`, `config`.
- Flows (return discipline/instructions, never act): the five cognitive flows
  (`ask`, `context`, `learn`, `remember`, `reflect`) plus `onboard` (guided setup;
  the wake phrase is persisted via `config`). Each is exposed as a prompt-tool and
  as an MCP prompt with identical content.
