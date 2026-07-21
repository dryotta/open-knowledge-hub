# Publishing knowledge to the GitHub wiki

Open Knowledge Hub can mirror a container's **knowledge** modules to that
repository's GitHub wiki for human browsing. Only `type: knowledge` modules are
published; skills, memory, agents, and other module types are never mirrored.

## How it works

Enabling wiki publishing on a container is a control-plane action: OKH scaffolds
a version-pinned GitHub Actions workflow (`.github/workflows/okh-wiki.yml`) and a
starter config (`.okh/wiki.yml`) into the container clone. The actual publish
runs **only in CI**, on every push to `main`. The workflow invokes
`open-knowledge-hub wiki publish`, which:

1. discovers every knowledge module from the repo root,
2. renders `Home`, a grouped `_Sidebar` table of contents, a `_Footer`, a
   landing page per module, and one page per concept, and
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
title: Widgets Knowledge Base   # heading shown on Home and in the sidebar
footer: (c) Acme Corp           # appended to _Footer on every page
```

Both keys are optional. Generated concept pages and module landings carry a
"do not edit" banner — edit the source Markdown in the module, not the wiki.
