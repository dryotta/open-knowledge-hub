# GitHub Wiki: Manifest-Driven, Two-Way Sync

**Status:** Approved design
**Date:** 2026-07-21
**Builds on:** `2026-07-21-okh-wiki-flat-navigation-design.md` (flat slugs, sidebar,
link rewriting — all retained). This spec changes **where the config lives**, **how
the chrome is produced**, and **adds reverse (wiki → repo) sync**.

## 1. Summary

Three changes to the shipped one-way, config-file-driven wiki:

1. **Selection moves into the module manifest.** A knowledge module opts in with
   two top-level keys in its own `.okh/module.yaml`:
   ```yaml
   type: knowledge
   description: Core meeting telemetry references…
   wiki-sync: true                 # publish this module to the wiki
   wiki-sync-reverse-mode: pr      # pr (default) | direct | off
   ```
   The dedicated `.okh/wiki.yml` file is **removed entirely** — wiki config is a
   repo-local, per-module setting, not a separate file.

2. **Chrome is generated from metadata + git status**, not from a config file. The
   wiki `_Header.md` / `_Footer.md` / `_Sidebar.md` are derived from the module's
   `module.yaml` (title/description) and the source commit (`owner/repo@sha`,
   date, edit-source links). Page bodies become **clean content** (no in-body
   banner), which is what makes round-tripping tractable.

3. **Two-way sync.** In addition to forward (repo → wiki) publishing on push to
   `main`, a `gollum`-triggered reverse job captures human wiki edits and flows
   them back into the source module — as a **PR to main** (default), a **direct
   commit** to main, or **not at all** (`off`), per `wiki-sync-reverse-mode`.

## 2. Goals and non-goals

### Goals

1. Enable/disable and configure wiki sync entirely from **one module's
   `module.yaml`** — no dedicated repo config file.
2. Generate GitHub wiki chrome (`_Header`, `_Footer`, `_Sidebar`) from module
   metadata + git provenance; keep page **bodies clean** (round-trippable).
3. Let humans **edit the wiki directly** and have those edits flow back to the
   repo with full fidelity: modify, **create**, **rename**, and **delete**.
4. Make the reverse landing mode configurable: `pr` | `direct` | `off`.
5. Never loop: a forward publish must not re-trigger a reverse sync (and vice
   versa), by construction.
6. Never lose source metadata: reverse edits **preserve the original file's OKF
   frontmatter**.
7. Keep the renderer pure/deterministic and everything unit-testable without
   git/network.

### Non-goals

- Publishing more than one module (flat wiki namespace = exactly one module).
- Conflict *resolution* beyond standard git/PR review (see §9 convergence).
- Preserving wiki page **order** chosen by a human in the UI (GitHub wikis sort
  the sidebar we generate; order is derived from paths).
- Non-GitHub wiki providers.

## 3. Manifest schema change (`src/modules/manifest.ts`)

`moduleManifestBodySchema` is `.strict()`; add two optional top-level keys:

```ts
const reverseModeSchema = z.enum(["pr", "direct", "off"]);

const moduleManifestBodySchema = z
  .object({
    type: z.string().min(1),
    description: z.string().default(""),
    config: z.record(z.string(), z.unknown()).optional(),
    "wiki-sync": z.boolean().optional(),
    "wiki-sync-reverse-mode": reverseModeSchema.optional(),
  })
  .strict();
```

- `wiki-sync` absent/`false` → module not published.
- `wiki-sync-reverse-mode` defaults to `"pr"` when `wiki-sync` is true and the key
  is omitted. It is ignored (with no error) when `wiki-sync` is false/absent.
- Kebab-case keys are used verbatim (quoted in the Zod object and read via
  `manifest["wiki-sync"]`). `ModuleManifest` type gains both optional fields.
- `scaffoldModuleManifest` is unchanged (opt-in is added by the author or the
  enable flow, not by default module creation).

### Selection rule

`buildAndPublishWiki` and the reverse job both resolve the target module the same
way, via a shared helper `selectWikiModule(repoRoot)`:

1. `discoverModules(repoRoot)`, keep `manifest.type === "knowledge"` **and**
   `manifest["wiki-sync"] === true`.
2. **Zero** matches → `OkhError("INVALID_ARGUMENT", "No knowledge module has
   'wiki-sync: true' in its .okh/module.yaml. Mark exactly one to publish.")`.
3. **More than one** → `OkhError("INVALID_ARGUMENT", "Multiple knowledge modules
   set 'wiki-sync: true' (<a>, <b>). A GitHub wiki is a flat namespace; mark
   exactly one.")`.
4. Exactly one → return `{ moduleRoot, name, manifest }`, including the resolved
   `reverseMode` (default `"pr"`).

## 4. Config removal (`src/wiki/config.ts`)

`.okh/wiki.yml` and the whole `WikiConfig` file layer are removed:

- Delete `src/wiki/config.ts` and `test/wiki-config.test.ts`.
- `RenderContextInfo` drops `config`. `title`/`footer` inputs are gone; the wiki
  title is the module's display name (folder basename, or `index.md`'s first `#`
  heading if present); provenance replaces the old free-text footer.
- `loadWikiConfig` callers are removed.
- The enable scaffold stops writing `.okh/wiki.yml`; `removeWikiFiles` stops
  trying to remove it (harmless if a stale one exists — left to the author).

## 5. Chrome from metadata + git status (`src/wiki/renderer.ts`)

Page bodies no longer carry a banner. Provenance and navigation move entirely into
the three Gollum special files, rendered once and shown on every page.

### `_Header.md`
```markdown
# <Wiki Title>

_This wiki is generated from [`<owner>/<repo>`](<repoUrl>) · module `<module>`.
Edits here open a <pr|commit> back to the source._
```
- **Wiki Title** = module `index.md` first H1 if present, else the module folder
  name title-cased.
- The reverse-mode phrase adapts: `pr` → "open a pull request back to the
  source"; `direct` → "commit back to the source"; `off` → "For reference only —
  edit the source repository." (`off` omits the "edits here…" invitation.)

### `_Footer.md`
```markdown
---
_Generated by [Open Knowledge Hub](…) from
[`<owner>/<repo>@<short>`](<repoUrl>/tree/<sha>) on <timestamp>._
```
Provenance is derived from git (`owner/repo`, full/short `sha`, ISO timestamp).
No user-supplied footer text (removed with `WikiConfig`).

### `_Sidebar.md`
Unchanged from the flat-nav spec: `[🏠 Home](Home)`, root pages ungrouped, then one
`<details open>` group per top-level subfolder with counts, links = `[title](slug)`.

### Concept pages and Home
- Concept page = `<slug>.md`, content = **clean rewritten body only** (no banner).
- `Home.md` = module `index.md` (frontmatter stripped, links rewritten), or the
  auto folder-grouped list fallback when there is no `index.md`.
- A per-page "Edit source" affordance is **not** injected into bodies (that would
  reverse-sync back into the source). Edit-source lives only in the footer, which
  reverse sync ignores.

## 6. Renderer output additions (for reverse mapping)

`renderWikiSite` gains, alongside `{ pages, assets, warnings }`, a pure
**`slugToSource: Map<string, string>`** (wiki slug → module-relative source path,
plus `"Home" → "index.md"`). This is the same `pageIndex` inverted and is the
single source of truth used by both forward link-rewriting and reverse mapping.
Chrome files (`_Header`, `_Footer`, `_Sidebar`) are **not** in the map.

## 7. Forward sync (repo → wiki) — mostly unchanged

`on: push` to `main`. `buildAndPublishWiki`:

1. `selectWikiModule(repoRoot)` (§3) instead of reading `.okh/wiki.yml`.
2. Render (§5). Push via clean-mirror in `repo.ts` (unchanged), authored by a
   **fixed bot identity** (§8) with `GITHUB_TOKEN`.
3. Diff-gated: no changes → `up-to-date`, no commit.

The clone/clean-mirror/commit/push mechanics in `src/wiki/repo.ts` are unchanged
except that `commit` now sets an explicit committer (§8).

## 8. Reverse sync (wiki → repo) — new

New module `src/wiki/reverse.ts`, CLI subcommand `wiki reverse`, run by a
`gollum`-triggered job.

### Bot identity (loop guard + BASE detection)
Both forward and reverse commits use a fixed identity, e.g.
`OKH Wiki Bot <okh-wiki-bot@users.noreply.github.com>`, passed as
`-c user.name -c user.email` on `git commit`. This is required so CI commits
succeed (runners have no default identity for our ad-hoc clones) **and** gives
reverse a reliable marker.

### Steps (`reverseSyncWiki(repoRoot, opts)`)
1. Resolve `owner/repo` and `wikiRemoteUrl` (reuse `defaultResolve`). Resolve the
   target module + `reverseMode` via `selectWikiModule`. If `reverseMode === "off"`
   → return `{ outcome: "disabled" }` (no-op; the CI job still ran but does
   nothing — mode stays purely in `module.yaml`).
2. Clone the **wiki** repo (full history) with the token.
3. **BASE** = the most recent commit whose committer email is the bot identity.
   - None found → `{ outcome: "no-baseline" }` (nothing to sync yet). This also
     covers "human edited before any forward publish."
4. `git diff --name-status -M<threshold> BASE..HEAD -- '*.md'` → entries of
   `{ status: A|M|D|R, oldPath?, newPath }`.
   - **Empty diff → `{ outcome: "up-to-date" }`.** This is the primary loop guard:
     right after a forward publish `HEAD === BASE`, so a `gollum` fired by the bot
     push yields nothing.
   - Drop `_Header.md`, `_Footer.md`, `_Sidebar.md` (regenerated chrome).
5. Build the forward `slugToSource` map (§6) by rendering the **current source**
   module (no push). This maps existing wiki slugs → exact source paths.
6. For each change, compute the source-repo mutation:
   - `Home` → `<module>/index.md`.
   - slug **in** map → its source path.
   - slug **not** in map (brand-new page, or a rename target to a new name) →
     `<module>/<slug>.md` (flat at module root; `pathSlug` is not reversible, so
     new pages are not de-slugged into subfolders — the next forward publish
     re-slugs a root file `foo-bar.md` → `foo-bar`, round-tripping cleanly).
   - `A`/`M` → write body (see §8 body transform), **preserving** any existing
     source file's frontmatter.
   - `D` → delete the mapped source file (skip if absent).
   - `R old→new` → delete old mapped source path **and** add/modify new.
7. Apply mutations to a checkout of the source repo (`main`), commit with the bot
   identity, message `Sync wiki edits (<n> pages)`.
8. Land per `reverseMode`:
   - `pr`: create branch `okh/wiki-sync/<runId-or-timestamp>` off current `main`,
     push, open a PR via the GitHub REST API
     (`POST /repos/{owner}/{repo}/pulls`, `head`→`base: main`) using the token.
     Body summarizes A/M/R/D counts and lists pages.
   - `direct`: push straight to `main` (fast-forward; on non-ff, rebase-retry
     once, then fail with an actionable error).
9. Diff-gated: if step 6 produced no net source change (e.g. an edit that
   normalizes to identical bytes), return `{ outcome: "up-to-date" }` without a
   PR/commit.

### Body transform (wiki page → source file)
For each `A`/`M` page:
1. Read the wiki page content. Bodies have **no banner** now (removed in §5), so no
   banner-stripping is needed; if a legacy banner line is present (`> 📘 …
   do not edit.`), strip it defensively.
2. **Un-rewrite links** (best-effort): for each `[text](target)` where `target` is
   a bare slug in `slugToSource`, rewrite to a path relative to this page's source
   dir (`Home`→`index.md`; `sources-eed` from page `cross-cutting/x.md` →
   `../sources/eed.md`). Unknown slugs are left untouched.
3. **Frontmatter:** if the destination source file already exists, parse its
   frontmatter and **re-attach it verbatim** above the new body. If it does not
   exist (new page), write the body with no frontmatter. This is the hard
   data-integrity requirement (dedicated test).

## 9. Loop safety & convergence

- **Forward → reverse:** forward pushes with `GITHUB_TOKEN` and the bot identity.
  Reverse's BASE = last bot commit, so immediately after a forward push the
  `BASE..HEAD` diff is **empty** → reverse no-ops. (Secondary guard: GitHub
  suppresses workflow runs for `GITHUB_TOKEN`-authored events.)
- **Reverse → forward:** reverse lands in the **repo** (PR merge or direct commit).
  A merge/commit to `main` triggers forward, which regenerates the wiki including
  the change → the wiki and repo converge.
- **Race (documented limitation):** in `pr` mode, if a push to `main` triggers a
  forward publish *before* the reverse PR merges, the clean-mirror temporarily
  reverts the human's wiki view. The edit is not lost — it lives in the open PR;
  merging it and the subsequent forward publish restore it. `direct` mode avoids
  the window (reverse commit → forward re-render, one hop).

## 10. Workflow scaffold (`resources/wiki/workflow.yml`)

A single `okh-wiki.yml` with **two** event triggers and two jobs gated by event:

```yaml
name: OKH Wiki Sync
on:
  push:
    branches: [main]
  gollum:
permissions:
  contents: write
  pull-requests: write
concurrency:
  group: okh-wiki
  cancel-in-progress: false      # don't cancel a reverse mid-flight
jobs:
  forward:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npx --yes open-knowledge-hub@__OKH_VERSION__ wiki publish
        env: { GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
  reverse:
    if: github.event_name == 'gollum'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with: { ref: main }
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npx --yes open-knowledge-hub@__OKH_VERSION__ wiki reverse
        env: { GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }} }
```

Both jobs are always scaffolded; `wiki-sync-reverse-mode: off` makes the reverse
job a runtime no-op (§8 step 1), keeping mode entirely in `module.yaml`.
`pull-requests: write` is required for `pr` mode.

## 11. Enable/disable scaffold (`src/container/service.ts`)

- `scaffoldWikiFiles`: write only the workflow (`.github/workflows/okh-wiki.yml`).
  **Do not** write `.okh/wiki.yml`, and **do not** silently edit any module
  manifest. Selecting the module (`wiki-sync: true`) is an explicit author action,
  documented in `resources/docs/wiki.md`; the enable flow's job is purely to
  scaffold the workflow. (Auto-flagging a sole knowledge module is deferred — §14.)
- `removeWikiFiles`: remove only the workflow file.
- `test/service-wiki.test.ts` asserts workflow presence/absence only; update it to
  drop `.okh/wiki.yml` assertions.

## 12. CLI (`src/wiki/cli.ts`)

- `wiki publish [--dry-run] [--repo <path>]` — unchanged surface; now selects via
  the manifest.
- **New** `wiki reverse [--repo <path>] [--dry-run]` — runs `reverseSyncWiki`.
  `--dry-run` computes and prints the planned A/M/R/D mutations without
  committing/PRing. Token from `GITHUB_TOKEN`/`WIKI_TOKEN`. Prints the outcome
  (`disabled` / `no-baseline` / `up-to-date` / `pr:<url>` / `committed:<sha>`).

## 13. Files

- **Modify** `src/modules/manifest.ts` — add `wiki-sync`, `wiki-sync-reverse-mode`.
- **Add** `src/wiki/select.ts` — `selectWikiModule(repoRoot)` (shared).
- **Modify** `src/wiki/renderer.ts` — drop in-body banner; metadata `_Header`;
  provenance `_Footer`; export `slugToSource`; drop `WikiConfig` from context.
- **Add** `src/wiki/reverse.ts` — `reverseSyncWiki` (diff, map, transform, land).
- **Add** GitHub REST PR helper (small `fetch` wrapper) — `src/wiki/github.ts`.
- **Modify** `src/wiki/publish.ts` — use `selectWikiModule`; bot identity; drop
  config; pass metadata to renderer.
- **Modify** `src/wiki/repo.ts` — set committer identity on `commit`.
- **Modify** `src/wiki/cli.ts` — add `reverse` subcommand.
- **Delete** `src/wiki/config.ts`, `test/wiki-config.test.ts`.
- **Modify** `src/container/service.ts` — scaffold only the workflow; no
  `.okh/wiki.yml`.
- **Modify** `resources/wiki/workflow.yml` — two triggers / two jobs.
- **Modify** `resources/docs/wiki.md` — document `module.yaml` keys, chrome,
  two-way sync, modes, convergence/race.
- **Modify** `resources/tool-meta/config.md` if it references `.okh/wiki.yml`
  (point authors to the `module.yaml` keys instead).
- **Tests**: `test/module-manifest.test.ts` (+ new keys, defaults, strictness),
  `test/wiki-select.test.ts` (0/1/N modules), `test/wiki-renderer.test.ts`
  (no-banner bodies, metadata header, provenance footer, `slugToSource`),
  `test/wiki-reverse.test.ts` (A/M/R/D mapping, new→flat, Home→index,
  **frontmatter preserved**, link un-rewrite, empty-diff no-op, `off`/no-baseline
  outcomes, pr vs direct dispatch via injected git/REST), `test/wiki-cli.test.ts`
  (reverse subcommand + updated fixtures using `wiki-sync`), `test/wiki-publish.test.ts`
  (manifest selection errors + happy path), `test/service-wiki.test.ts` (no
  `.okh/wiki.yml`).

## 14. Open questions (resolve during implementation)

1. **Enable auto-flag:** should `container wiki enable` auto-set `wiki-sync: true`
   on a sole knowledge module, or only print guidance? Spec default: **guidance
   only** (no silent manifest edits). Revisit if the UX feels heavy.
2. **Rename fidelity:** renaming an existing page to a *new* name lands the target
   as a flat `<module>/<slug>.md` rather than reconstructing subfolders. Accepted
   for v1 (deterministic, non-lossy; author can relocate).

## 15. Live verification

Against `davidzh_microsoft/core-meeting-knowledge-hub`:
1. Set `telemetry/.okh/module.yaml`: `wiki-sync: true`, `wiki-sync-reverse-mode: pr`.
2. Forward publish (CLI, token): confirm clean bodies, metadata header, provenance
   footer, working sidebar/links on the live wiki.
3. Edit a page in the wiki UI; run `wiki reverse` (or let the gollum job run):
   confirm a PR opens with the edit, **frontmatter preserved**, links un-rewritten.
4. Test `direct` mode on a scratch page; confirm a commit to `main` and
   convergence on the next forward publish. Confirm empty-diff no-op right after a
   forward publish (loop guard).
