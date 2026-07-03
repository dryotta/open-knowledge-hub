# Context: open-knowledge-hub

Glossary for the open-knowledge-hub MCP — a server that organizes agent knowledge
and capabilities into containers of typed modules. The server runs no LLM; it
provides deterministic tools + discipline text and the client agent does all
reasoning.

## Terms

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

### Cognitive prompts
`ask` (query), `context` (assemble a working set), `learn` (integrate into
knowledge, OKF), `remember` (record into memory), `reflect` (memory → insight).
Each returns discipline text pointing the agent at resolved module paths; exposed
as both MCP prompts and tools. `container`/`module` are optional filters.

## Runtime & surface
- TypeScript on `@modelcontextprotocol/sdk`, `zod`, `yaml`; run via `npx`. Requires
  `git`; `gh` only for `pr`-mode containers. See ADR-0001, 0002, 0004.
- Tools (deterministic): `inspect`, `add`, `sync`.
- Prompts/flows (discipline text): `ask`, `context`, `learn`, `remember`, `reflect`.
