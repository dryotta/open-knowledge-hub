# Publishing knowledge to the GitHub wiki

Open Knowledge Hub can mirror **one** of a container's `type: knowledge` modules
to that repository's GitHub wiki for human browsing. You pick the single module
to publish; skills, memory, agents, and other module types are never mirrored.

Only one module is published because GitHub wikis are a **flat namespace** — a
page is addressed by its slug, folders are not part of the URL, so a single
focused module gives clean, working navigation.

## How it works

Enabling wiki publishing on a container is a control-plane action: OKH scaffolds
a version-pinned GitHub Actions workflow (`.github/workflows/okh-wiki.yml`) and a
starter config (`.okh/wiki.yml`) into the container clone. The actual publish
runs **only in CI**, on every push to `main`. The workflow invokes
`open-knowledge-hub wiki publish`, which:

1. reads `.okh/wiki.yml` and selects the single knowledge module named by the
   `module:` key,
2. renders the module's `index.md` as **Home**, a folder-grouped `_Sidebar`
   table of contents, a `_Footer`, and one flat page per concept (a concept at
   `sources/eed.md` becomes the wiki page `sources-eed`), rewriting internal
   links to the matching page slugs, and
3. clean-mirrors the repo's `.wiki.git` and pushes it.

## One-time prerequisite

Enable the wiki feature once: repo **Settings → Features → Wikis**. OKH does not
toggle this for you (it needs admin scope beyond the CI token). Create the first
wiki page in the UI if GitHub requires it to initialize the `.wiki.git` repo.

## Enable / disable

```jsonc
// enable
config { "container": "widgets", "set": { "wiki": { "enabled": true } } }
// disable
config { "container": "widgets", "set": { "wiki": { "enabled": false } } }
// view current state
config { "container": "widgets" }
```

After enabling (or disabling), run `sync` to commit the scaffolded workflow.
Publishing then happens automatically on the next push to `main`.

Requires a **git-backed container with a github.com origin**; other backends are
rejected.

## Customizing the wiki

Edit `.okh/wiki.yml` in the container:

```yaml
module: telemetry               # required: folder name of the knowledge module to publish
title: Widgets Knowledge Base   # heading shown on the fallback Home / empty state
footer: (c) Acme Corp           # appended to _Footer on every page
```

`module:` is **required** — publishing fails with an actionable error if it is
missing or does not name a `type: knowledge` module. `title` and `footer` are
optional. Generated concept pages carry a "do not edit" banner — edit the source
Markdown in the module, not the wiki.

## Navigation

- **Home** is the module's `index.md`, rendered verbatim (frontmatter stripped)
  with its links rewritten to wiki slugs. If the module has no `index.md`, Home
  falls back to a grouped list of every page.
- **Sidebar** (`_Sidebar`) shows a `🏠 Home` link, then one collapsible
  `<details open>` group per top-level subfolder (with a page count), each
  listing its pages by title. It renders on every page.
- **Links** between pages use bare slugs (`[EED](sources-eed)`), so they resolve
  correctly in GitHub's flat wiki. Cross-references written as relative
  (`../sources/eed.md`), module-root (`/sources/eed.md`), or bare (`eed.md`)
  paths are all rewritten to the same slug.
