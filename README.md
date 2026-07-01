# open-knowledge-hub

An [MCP](https://modelcontextprotocol.io) server that manages a personal **catalog of knowledge
packs**. Each pack is an [Open Knowledge Format (OKF)](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
bundle — a directory of cross-linked markdown concept docs — published to its own git repo (a
full repo or a subfolder within one).

The server handles the mechanical lifecycle (install / uninstall / update / status) and exposes
knowledge **flows** — *ask*, *learn*, *review & update*, and *create* — that inject the OKF
discipline into your agent. All reasoning happens in your agent; the server provides deterministic
tools plus vendored discipline text. Edits are always published as **pull requests**, never pushed
straight to a pack's default branch.

## How it works

- **Catalog** — a per-machine manifest (`$OKH_HOME/catalog.json`, default
  `~/.open-knowledge-hub/catalog.json`) listing each pack's slug, git origin (URL + optional
  subpath + ref), install state, and local path.
- **Install** — a full `git clone` of the origin into `$OKH_HOME/packs/<slug>/`. By default a pack
  lives under the repo's `knowledge/` subfolder, so the pack root is `<clone>/knowledge`; this keeps
  the repo root free for a `README.md`, `LICENSE`, and other non-bundle files. Pass `subpath: "."`
  for a pack that lives at the repo root, or a custom subpath for multi-pack repos. The clone keeps
  its origin remote, so changes can be committed and turned into a PR.
- **Flows** — `ask` / `learn` / `review_update` / `create` return instruction text (the vendored
  `okf-*` disciplines under `resources/okf/`), parametrised for the target pack. Available as both
  MCP **prompts** (nice UX) and **tools** (work in any client).

## Prerequisites

- **Node.js ≥ 18** (ships with `npx`).
- **git** — for clone / commit / branch operations.
- **[GitHub CLI](https://cli.github.com/) (`gh`)**, authenticated — for creating a new pack's repo
  (`gh repo create`) and opening PRs (`gh pr create`). The server stores **no** credentials; `gh`
  and `git` use your existing auth. See [Troubleshooting](#troubleshooting).

## Installation

`open-knowledge-hub` is distributed straight from its GitHub repo — no npm publish required.
Pick one of the methods below. All of them build the TypeScript sources automatically on install
(via the `prepare` script), so the only prerequisites are Node.js ≥ 18, `git`, and an
authenticated `gh` (see [Prerequisites](#prerequisites)).

Repo: `github.com/dryotta/open-knowledge-hub`

### Method A — run from GitHub via `npx` (recommended)

No local checkout needed. Point your MCP client's config at `npx` with the GitHub spec; `npx`
fetches, builds, and runs it. Add to your client's `mcpServers` block (Claude Desktop, Copilot
CLI, Cursor, etc.):

```jsonc
{
  "mcpServers": {
    "open-knowledge-hub": {
      "command": "npx",
      "args": ["-y", "github:dryotta/open-knowledge-hub"]
      // Optional: override the catalog/packs location (defaults to ~/.open-knowledge-hub)
      // "env": { "OKH_HOME": "/Users/me/.open-knowledge-hub" }
    }
  }
}
```

Pin to a tag or branch by appending `#<ref>`, e.g. `github:dryotta/open-knowledge-hub#v0.1.0`.
The first launch takes a few extra seconds while it builds; subsequent runs are cached.

Verify from a shell before wiring it in:

```bash
npx -y github:dryotta/open-knowledge-hub <<'EOF'
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"x","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
EOF
```

You should see a JSON response listing the tools.

### Method B — global install from GitHub

Installs an `open-knowledge-hub` command onto your PATH:

```bash
npm install -g github:dryotta/open-knowledge-hub
```

Then configure the client with the bare command:

```jsonc
{
  "mcpServers": {
    "open-knowledge-hub": {
      "command": "open-knowledge-hub",
      "args": []
    }
  }
}
```

Update later with the same command; uninstall with `npm uninstall -g open-knowledge-hub`.

### Method C — clone & build (for development or offline use)

```bash
git clone https://github.com/dryotta/open-knowledge-hub.git
cd open-knowledge-hub
npm install        # builds via the prepare script
npm link           # optional: exposes `open-knowledge-hub` on your PATH
```

Configure the client to run the built entry point (works without `npm link`):

```jsonc
{
  "mcpServers": {
    "open-knowledge-hub": {
      "command": "node",
      "args": ["/absolute/path/to/open-knowledge-hub/dist/index.js"]
    }
  }
}
```

After changing source, rerun `npm run build`.

> **Note:** Methods A and B fetch the code over git, so the repository must be pushed to GitHub and
> readable by your account. For a private repo, ensure `git`/`gh` are authenticated (Method A/B use
> your ambient git credentials to clone).

## Tools

| Tool | Purpose |
| --- | --- |
| `catalog_list` | List catalog entries with state + origin. |
| `catalog_add` | Register a pack (slug, repoUrl, subpath?, ref?) without installing. Subpath defaults to `knowledge`; pass `.` for a root pack. |
| `pack_install` | Clone a pack's origin. Can register + install in one step via `repoUrl`. |
| `pack_uninstall` | Remove a pack's clone. Blocks on unpushed commits unless `force`; `purge` drops the entry. |
| `pack_status` | Branch, dirty state, ahead/behind, unpushed commits. |
| `pack_pull` | Fast-forward from origin; local changes auto-stashed and restored. |
| `pack_path` | Resolve an installed pack's root path. |
| `pack_create` | Scaffold a new local pack (dir + `git init` + skeleton `index.md` under `knowledge/`). |
| `pack_publish` | Create the GitHub repo for a new pack and push `main`. |
| `pack_begin_change` | Create the working branch `okh/<slug>/<topic>`. |
| `pack_commit` | Stage all + commit. |
| `pack_diff` | Diffstat for summarising changes before a PR. |
| `pack_open_pr` | Push the change branch and open a PR. |
| `ask` / `learn` / `review_update` / `create` | Flow tools returning OKF discipline text. |

## Prompts

`ask`, `learn`, `review_update`, `create` — the same flows as first-class MCP prompts.

## Typical usage

- **Install and query a pack**: `pack_install { slug, repoUrl }` → `ask { slug, question }`.
- **Teach a pack something**: `learn { slug, knowledge }` → your agent runs the okf-learn gate,
  edits files at the pack path, then (with your approval) `pack_begin_change` → `pack_commit` →
  `pack_open_pr`.
- **Create a new pack**: `create { slug }` → `pack_create` → author content → `pack_publish`.

## Development

```bash
npm install       # install deps
npm run build     # compile to dist/
npm test          # run the vitest suite (uses real git against temp repos)
npm run typecheck # type-only check
npm run dev       # run from source via tsx
```

The codebase is layered: `exec` (process spawning) → `git` / `gh` (CLI wrappers) →
`catalog` (manifest) → `packs/service` (orchestration) → `server` (MCP tools + prompts).

## Troubleshooting

**`gh: command not found`** — install the GitHub CLI: `brew install gh` (macOS),
or see <https://cli.github.com/>.

**`gh` auth errors when creating a repo or PR** — run `gh auth status`; if not logged in,
`gh auth login` and follow the prompts. Ensure the account has permission to create repos in the
target owner/org.

**`git` push/clone auth errors** — the server uses your ambient git credentials. Verify with
`git ls-remote <repoUrl>`. For HTTPS, configure a credential helper (`gh auth setup-git` wires
`gh` in as one); for SSH, ensure your key is loaded (`ssh-add -l`).

**`Target directory ... already exists and is not empty`** — a previous clone is present. Uninstall
the pack (`pack_uninstall`) or remove the directory under `$OKH_HOME/packs/`.

**Commit fails with "please tell me who you are"** — set a git identity:
`git config --global user.name "..."` and `git config --global user.email "..."`.

## License

MIT
