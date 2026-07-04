# open-knowledge-hub

A minimalist [MCP](https://modelcontextprotocol.io) server that organizes all
agent-accessible knowledge and capabilities into **containers** made of typed
**modules**. The **hub** is the system itself; it manages your containers.

It exposes two kinds of surface. **Operational tools** (`inspect`, `add`, `sync`,
`config`) *act* — they read state or change containers. Six **flows** (`ask`,
`context`, `learn`, `remember`, `reflect`, `onboard`) *return instructions*: each
hands your agent discipline text to follow. A flow never acts on its own — your
agent does the reasoning and any edits. The server runs **no LLM** — it exposes
deterministic tools and injects discipline text; your agent does all the reasoning.

## Concepts

- **Hub** — the system itself (this server), which you address by a wake phrase.
  There is one hub; it manages any number of containers. Modules always live
  inside a container, never directly in "the hub".
- **Container** — a self-contained workspace in a local folder. Backends: a plain
  **local** folder, a **OneDrive** (OS-synced) folder, or a **git** repository
  (cloned + synced). Registered in a per-machine `registry.json` under `$OKH_HOME`
  (default `~/.open-knowledge-hub`); git containers are cloned into
  `$OKH_HOME/containers/`, local/OneDrive folders are registered in place.
- **Module** — a typed subfolder declared in the container's `.okh/okh.yaml`
  manifest. Types: `knowledge` (OKF markdown), `skills` (Claude-Code `SKILL.md`
  folders), `tools` (folders each with a `README.md` + script), `memory` and
  `project` (format TBD).

### `.okh/okh.yaml`
```yaml
name: my-notes
sync: auto        # auto (commit+push) | pr (branch + pull request)
modules:
  - path: kb
    type: knowledge
  - path: skills
    type: skills
  - path: tools
    type: tools
```

## MCP surface

OKH exposes two kinds of tools plus matching prompts.

### Operational tools (perform actions)

These read state or change containers directly.

| Tool | Args | Purpose |
| --- | --- | --- |
| `inspect` | `container?`, `module?` | List containers / a container's modules+status / a module's items. |
| `add` | `source,name?,sync?,backend?,create?` or `container,path,type,config?,create?` | Register a container, or add a module. Returns a plan unless `create:true`. |
| `sync` | `container?`, `message?` | Validate + synchronize (commit+push, or PR). |
| `config` | `set?` | View configuration (no args) or change it, e.g. `{ set: { wakePhrase: "brain" } }`. |

### Flows (return instructions — they do not act)

Each flow returns **discipline text**: step-by-step instructions your agent
follows to do the work. A flow never reads or writes your files itself — your
agent does the reasoning and any edits, then persists with `sync`. All six are
exposed both as prompt-tools (below) and as MCP prompts (for clients with a
prompt UI), with identical content.

| Flow | Args | Returns instructions to… |
| --- | --- | --- |
| `ask` | `container?`, `module?`, `question?` | …answer a question from your containers' modules. |
| `context` | `container?`, `task?` | …assemble a task's working set across your containers. |
| `learn` | `container?`, `module?`, `knowledge?` | …integrate knowledge into a knowledge module (OKF). |
| `remember` | `container?`, `module?`, `observation?` | …record an observation into a memory module. |
| `reflect` | `container?`, `module?`, `focus?` | …turn memory into insight and updates. |
| `onboard` | _(none)_ | …guide first-run setup (terminology, wake phrase, first container + modules). |

**Prompts (6):** `ask`, `context`, `learn`, `remember`, `reflect`, `onboard` — the
same six flows, for clients with a prompt UI. Content matches the prompt-tools
exactly. `container`/`module` are optional filters: omit them to span every
registered container (the whole hub).

**Resources:** none.

## Prerequisites

- **Node.js ≥ 18** (ships with `npx`).
- **git** — clone/commit/branch/push.
- **[GitHub CLI](https://cli.github.com/) (`gh`)**, authenticated — only for `pr`-mode
  containers (opening pull requests). The server stores no credentials.

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

## Typical usage

- `add { source: "https://github.com/me/my-notes.git", name: "my-notes" }` → clone + register a container.
- `add { container: "my-notes", path: "kb", type: "knowledge" }` → add a module.
- `learn { container: "my-notes", knowledge: "..." }` → your agent folds it in, then
  `sync { container: "my-notes" }` commits+pushes (or opens a PR).
- `ask { container: "my-notes", question: "..." }` → cited answer from the modules.

## Wake phrase

Address the hub by its wake phrase (default `hub`), e.g. `hub, remember that …`.
Change it with the `config` tool (`config { set: { wakePhrase: "brain" } }`); OKH
stores it in `$OKH_HOME/preferences.json` and announces it in the server
instructions. See **[USAGE.md](./USAGE.md)** for recommended prompts.

## Development

```bash
npm install       # install deps
npm run build     # compile to dist/
npm test          # vitest (uses real git against temp repos)
npm run typecheck # type-only check
npm run dev       # run from source via tsx
```

Layering: `exec` → `git`/`gh` → `registry` → `container` (manifest + service) →
`modules` (loaders) → `prompts` → `server`.

## License

MIT
