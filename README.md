# open-knowledge-hub

A minimalist [MCP](https://modelcontextprotocol.io) server that organizes all
agent-accessible knowledge and capabilities into **containers** made of typed
**modules**. Five **cognitive prompts** (`ask`, `context`, `learn`, `remember`,
`reflect`) provide the thinking loop; three **operational tools** (`inspect`,
`add`, `sync`) manage and synchronize containers. The server runs **no LLM** —
it exposes deterministic tools and injects discipline text; your agent does all
the reasoning.

## Concepts

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
name: my-hub
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

**Tools (9)**

| Tool | Args | Purpose |
| --- | --- | --- |
| `inspect` | `container?`, `module?` | List containers / a container's modules+status / a module's items. |
| `add` | `source,name?,sync?,backend?` or `container,path,type,config?` | Register a container, or add a module. Returns a plan unless `create:true`. |
| `sync` | `container?`, `message?` | Validate + synchronize (commit+push, or PR). |
| `onboard` | `wakePhrase?` | Guide first-run setup; persist a custom wake phrase. |
| `ask` | `container?`, `module?`, `question?` | Discipline to answer from the hub's modules. |
| `context` | `container?`, `task?` | Discipline to assemble a task's working set. |
| `learn` | `container?`, `module?`, `knowledge?` | Discipline to integrate knowledge (OKF). |
| `remember` | `container?`, `module?`, `observation?` | Discipline to record into memory. |
| `reflect` | `container?`, `module?`, `focus?` | Discipline to turn memory into insight. |

**Prompts (6):** `ask`, `context`, `learn`, `remember`, `reflect`, `onboard` — same
behaviour as the matching prompt-tools, for clients with a prompt UI.
Container/module are optional filters: omit both to span the whole hub.

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

- `add { source: "https://github.com/me/my-hub.git", name: "my-hub" }` → clone + register.
- `add { container: "my-hub", path: "kb", type: "knowledge" }` → add a module.
- `learn { container: "my-hub", knowledge: "..." }` → your agent folds it in, then
  `sync { container: "my-hub" }` commits+pushes (or opens a PR).
- `ask { container: "my-hub", question: "..." }` → cited answer from the modules.

## Wake phrase

Address the hub by its wake phrase (default `hub`), e.g. `hub, remember that …`.
Change it with the `onboard` tool; OKH stores it in `$OKH_HOME/preferences.json`
and announces it in the server instructions. See **[USAGE.md](./USAGE.md)** for
recommended prompts.

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
