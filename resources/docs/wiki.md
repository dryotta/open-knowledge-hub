# Publishing modules to the GitHub wiki

Open Knowledge Hub can mirror a container's modules to that repository's GitHub
wiki for human browsing, and sync human wiki edits back to the source. Any module
type may be published — you opt in per module.

## Selecting modules

A module opts into wiki publishing with keys in its `.okh/module.yaml`:

```yaml
type: knowledge
description: Telemetry knowledge base
wiki-sync: true                 # publish this module to the wiki
wiki-sync-reverse-mode: pr      # how human wiki edits flow back: pr | direct | off
wiki-sync-expanded: true        # optional: force this module's sidebar section open
```

- **`wiki-sync`** (`true`/`false`) — include this module. Every opted-in module is
  published; they appear in the sidebar sorted alphabetically by folder name.
- **`wiki-sync-reverse-mode`** — what happens to edits made in the wiki:
  - `pr` (default) — gather the edits into a single pull request against the
    default branch.
  - `direct` — commit the edits straight to the default branch.
  - `off` — one-way only; wiki edits to this module are ignored.
- **`wiki-sync-expanded`** (optional) — override the sidebar open/closed default.
  When unset, the first module (alphabetical) is expanded and the rest collapsed.

## How it works

Enabling wiki sync on a container is a control-plane action: OKH scaffolds a
version-pinned GitHub Actions workflow (`.github/workflows/okh-wiki.yml`) into the
container clone. The publish and reverse jobs run **only in CI**:

- **Forward** (push to `main`): `open-knowledge-hub wiki publish` renders every
  opted-in module and clean-mirrors the result to the repo's `.wiki.git`.
- **Reverse** (`gollum`, i.e. a human edits the wiki): `open-knowledge-hub wiki
  reverse` maps changed pages back to their source modules and lands them per each
  module's `wiki-sync-reverse-mode`.

A fixed bot identity authors both directions, so a forward publish never triggers
a reverse loop.

## Page layout

Every published page shares generated chrome:

- **Home** — a generated landing page titled with the repository name, listing
  each published module (title, description, link to its landing page).
- **`_Sidebar`** — a `🏠 Home` link followed by one collapsible `<details>` per
  module (alphabetical). Each section links the module's landing page, then its
  pages grouped by subfolder.
- **`_Header` / `_Footer`** — shared provenance (source repo, commit, timestamp).

Page slugs are **namespaced by module** to keep the flat wiki collision-free: a
concept at `telemetry/sources/eed.md` becomes the wiki page `telemetry-sources-eed`,
and a module's `index.md` becomes the page `telemetry`. Internal links written as
relative (`../sources/eed.md`), module-root (`/sources/eed.md`), or bare
(`eed.md`) paths are all rewritten to the matching namespaced slug.

## Per-module table of contents

Within a module, pages and subfolder groups are ordered by the sequence in which
the module's `index.md` first links to them; anything the `index.md` does not
reference falls back to alphabetical order after. A module with no `index.md`
gets a generated, alphabetical contents list as its landing page.

## One-time prerequisite

Enable the wiki feature once: repo **Settings → Features → Wikis**. OKH does not
toggle this for you (it needs admin scope beyond the CI token). Create the first
wiki page in the UI if GitHub requires it to initialize the `.wiki.git` repo.

## Enable / disable

```jsonc
// enable wiki sync for the container (scaffolds the workflow)
config { "container": "widgets", "set": { "wiki": { "enabled": true } } }
// disable
config { "container": "widgets", "set": { "wiki": { "enabled": false } } }
// view current state
config { "container": "widgets" }
```

After enabling (or disabling), run `sync` to commit the scaffolded workflow.
Publishing then happens automatically on the next push to `main`, and reverse sync
whenever the wiki is edited. Then opt modules in with `wiki-sync: true` in their
`.okh/module.yaml` and `sync` again.

Requires a **git-backed container with a github.com origin**; other backends are
rejected.

## Editing content

Edit source Markdown in the module for durable changes. Human wiki edits are
mirrored back to the source per the module's `wiki-sync-reverse-mode`; the
generated Home page and chrome are regenerated on every publish and are not synced
back. New wiki pages should use a module's slug prefix (e.g. `telemetry-glossary`)
so reverse sync can attribute them to the right module; they land flat at the
module root.
