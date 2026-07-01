# Context: open-knowledge-hub

Glossary for the open-knowledge-hub MCP — a server that manages a catalog of
OKF knowledge packs, each published to its own git repo (full repo or subfolder).

## Terms

### Knowledge Pack
An [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf)
bundle: a directory of cross-linked markdown concept docs with YAML frontmatter,
scoped by a written contract (goals + target questions + out-of-scope) in its
root `index.md`. Published to its own git repo, either as the full repo or a
subfolder within a larger repo.

### Origin
The git repository (and optional subpath + ref) a knowledge pack is published to.
The canonical remote a pack is installed from and pushed back to. By default a
single pack lives under the repo's `knowledge/` subfolder (see **Pack subpath**),
leaving the repo root free for a `README.md`, `LICENSE`, and other non-bundle files.

### Pack subpath
Where a pack's OKF bundle lives inside its origin repo. Defaults to `knowledge/`
so one repo holds one pack plus repo-level files (README, LICENSE). Pass `.` to
place the pack at the repo root instead; any other value selects a custom
subfolder (e.g. for multiple packs in one repo).

### Catalog
The user's personal, per-machine set of registered packs — a manifest
(`$OKH_HOME/catalog.json`, default `~/.open-knowledge-hub/catalog.json`). Each
entry has a unique local **slug**, the pack's origin coordinates (repo URL,
optional subpath, optional ref), install state, and local path. Not a hosted or
shared registry.

### Slug
The unique, user-facing local name of a pack within the catalog. Several packs
may be sourced from different subpaths of the same repo, each with its own slug.

### Install / Uninstall
Install materializes a pack by full `git clone` of its origin into
`$OKH_HOME/packs/<slug>/`; for subfolder packs the pack root is
`<clone>/<subpath>`. The clone retains the origin remote so changes can be
committed and pushed back. Uninstall removes the local clone (and optionally the
catalog entry).

### Update flow (PR-based)
All edits to an installed pack (via learn / review_update) go through a pull
request — never a direct push to the default branch. The flow: create a working
branch (`okh/<slug>/<short-topic>`), commit, push the branch, open a PR via
`gh pr create`, and surface the PR URL. The agent must summarize the diff and get
explicit user confirmation before committing/pushing. The sole exception is the
initial `pack_create` publish of a brand-new repo, which commits straight to
`main`.

## Runtime & surface (non-glossary reference)

- **Runtime**: TypeScript on `@modelcontextprotocol/sdk`, run via `npx`. Requires
  `git` and `gh` installed and authenticated on the host. See ADR-0001, ADR-0002.
- **Tools (deterministic)**: `catalog_list`, `catalog_add`, `pack_install`,
  `pack_uninstall` (blocks on unpushed commits unless forced; `purge` drops the
  entry), `pack_status`, `pack_pull` (auto-stashes local changes, restores after),
  `pack_path`, `pack_create` + `pack_publish` (scaffold locally, then create the
  origin via `gh` and push `main`), and the PR write flow `pack_begin_change` /
  `pack_commit` / `pack_diff` / `pack_open_pr`.
- **Flows** (exposed as BOTH MCP prompts and equivalent tools, injecting the
  vendored OKF discipline, parametrized by slug): `ask` (single pack, okf-ask),
  `learn` (okf-learn), `review_update`, `create` (okf-new-from-repo → publish via
  `gh repo create`).
