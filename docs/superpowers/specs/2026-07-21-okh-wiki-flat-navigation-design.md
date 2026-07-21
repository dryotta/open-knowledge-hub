# GitHub Wiki: Flat Single-Module Navigation

**Status:** Approved design
**Date:** 2026-07-21
**Revises:** `2026-07-20-okh-wiki-sync-design.md` (wiki output/rendering layer only)

## 1. Summary

The initial wiki sync (see the 2026-07-20 spec) renders each knowledge module to
**nested wiki paths** (`<module>/<sub>/<file>.md`) and links between pages with
relative paths (`../sources/eed`). A live end-to-end publish to a real repo
(`davidzh_microsoft/core-meeting-knowledge-hub`) proved this model is
fundamentally incompatible with GitHub wikis:

- **GitHub wikis are a flat namespace.** A file pushed at
  `telemetry/sources/eed.md` is **not** served at `/wiki/telemetry/sources/eed`;
  GitHub strips the folders and serves it by basename slug (`/wiki/eed`).
- Every generated link therefore points at a path GitHub does not use → **404**.
- Flattening also means **basename collisions silently drop pages** (two
  `index.md` or two `overview.md` → only one survives).
- Internal links only resolve when they use the page's actual **slug**
  (`[EED](EED)` or `[[EED]]`), resolved relative to `/wiki/`.

This revision moves the wiki output to a **flat page namespace with unique,
path-encoded slugs and slug-based links**, publishes **exactly one** knowledge
module per container (chosen explicitly in config), and rebuilds navigation as a
curated Home plus a folder-grouped, collapsible sidebar.

Unchanged from the 2026-07-20 design: CI-only publishing, the workflow scaffold,
`.okh/wiki.yml` loading (`title`, `footer`), enable/disable plumbing, token
injection/redaction, and the clone → clean-mirror → commit → push in `repo.ts`.

## 2. Goals and non-goals

### Goals

1. Produce **working internal links** on the live GitHub wiki.
2. Publish **exactly one** knowledge module per container, named explicitly in
   config (no auto-selection, even when only one knowledge module exists).
3. Provide clear navigation: a curated **Home** (from the module's `index.md`)
   and a **folder-grouped, collapsible `_Sidebar`** ToC shown on every page.
4. Keep the renderer pure and deterministic (unit-testable without git/network).
5. Fully replace the previously published (broken) nested pages on next publish
   via the existing clean-mirror.

### Non-goals

- Publishing more than one module, or multi-module grouping.
- Changing CI, enable/disable, token, or push mechanics.
- Active-page highlighting in the sidebar (GitHub wikis cannot mark it).
- Non-GitHub wiki providers.

## 3. Global constraints

- **Node/TypeScript**, ESM, run via `tsx`; tests via `vitest`.
- Renderer stays pure: input in, `{ pages, assets, warnings }` out; no I/O.
- Wiki special files keep their Gollum names: `Home.md`, `_Sidebar.md`,
  `_Footer.md`.
- Every published concept page and Home carry no raw OKF frontmatter (already
  stripped via `parseFrontmatter`).
- Deterministic output: given the same inputs, byte-identical pages.

## 4. Module selection (single, explicit)

New config field on `WikiConfig` (loaded from `.okh/wiki.yml`):

```ts
export type WikiConfig = {
  title?: string;
  footer?: string;
  module?: string; // NEW: folder name of the single knowledge module to publish
};
```

`buildAndPublishWiki` behaviour:

1. Load `.okh/wiki.yml`. If `config.module` is unset/blank → throw
   `OkhError("INVALID_ARGUMENT", "Set 'module:' in .okh/wiki.yml to the knowledge module to publish (e.g. module: telemetry).")`.
2. Discover modules. Find the one whose `basename(path) === config.module` and
   `manifest.type === "knowledge"`.
3. If not found (absent, or not `type: knowledge`) → throw
   `OkhError("INVALID_ARGUMENT", "Knowledge module '<module>' not found. Available knowledge modules: <a, b, c>.")`
   (list the discovered knowledge modules; empty list if none).
4. Build exactly that one `RenderModule` and render it.

The enable scaffold's starter `.okh/wiki.yml` gains a commented example:

```yaml
# module: <knowledge-module-folder>   # required: the single module to publish
# title: My Knowledge Base
# footer: Questions? #team-channel
```

## 5. Slugs (`src/wiki/slug.ts`)

```ts
/** Encode a module-relative path into a flat GitHub-wiki slug. */
export function pathSlug(moduleRelPath: string): string {
  return moduleRelPath.replace(/\.md$/i, "").split("/").join("-");
}
```

- `sources/eed.md` → `sources-eed`; `areas/meeting-join.md` → `areas-meeting-join`;
  `cross-cutting/id-pivots.md` → `cross-cutting-id-pivots`.
- Case is preserved (paths are already lowercase in practice); GitHub slugs are
  case-sensitive.
- Each concept page is written to the wiki **root** as `<slug>.md`.
- Collision de-dup: reuse the existing `claim()` pattern — if `<slug>.md` is
  already used, append `-2`, `-3`, … and emit a `collision` warning. (Full paths
  are unique, so real collisions are near-impossible, but the guard stays.)
- The module's `index.md` is **not** slugged; it becomes `Home.md` (§7).

## 6. Link rewriting → bare slugs

`RewriteContext` no longer needs a `moduleName` prefix layer. For each Markdown
link `[text](target)` in a concept body or in the Home body:

1. If `target` matches `^[a-z]+:` (scheme) or starts with `#` → leave untouched.
2. Split off `#anchor`.
3. Resolve the path part to a **module-relative** path:
   - Leading `/` → module-root-relative: strip the slash, use as-is.
   - Otherwise → resolve against the current page's module-relative directory
     (`posix.normalize(posix.join(currentModuleDir, pathPart))`).
4. If the resolved path (case-insensitively) equals the module's `index.md` →
   emit `[text](Home#anchor?)`.
5. Else look up the resolved path in the concept **page index**:
   - Hit → emit `[text](<slug>#anchor?)` — a **bare slug**, no `../`, no `.md`.
   - Miss, and target ends in `.md` → `dangling-link` warning, leave original.
6. Non-`.md` targets are **assets** (§8).

`currentModuleDir` is the POSIX dirname of the concept's own module-relative
source path (e.g. concept `cross-cutting/id-pivots.md` → dir `cross-cutting`), so
`../sources/eed.md`, `/sources/eed.md`, and (from a sibling) `eed.md` all resolve
to `sources/eed.md` → slug `sources-eed`.

## 7. Structural pages

### Home.md
- If the module has an `index.md`: Home body = that `index.md` with frontmatter
  stripped and links rewritten (§6). No banner (it is curated content); provenance
  lives in the footer, which renders on every page including Home.
- If the module has no `index.md`: fall back to an auto Home —
  `# <config.title ?? repo>` followed by the same folder-grouped list used in the
  sidebar (flat links).

### _Sidebar.md
Rendered once, shown on every page:

```markdown
[🏠 Home](Home)

<details open><summary><b>Areas</b> (9)</summary>

- [Audio telemetry](areas-audio)
- …

</details>

<details open><summary><b>Cross-cutting</b> (6)</summary>

- [Device classification from SCR telemetry](cross-cutting-device-classification)
- …

</details>
```

Rules:
- Top link `[🏠 Home](Home)`.
- Root-level concept pages (module-relative path with no `/`, excluding
  `index.md`) are listed first, ungrouped, as `- [title](slug)`.
- Then one group per **top-level subfolder**, ordered alphabetically by folder
  name. Group label = folder name with first letter upper-cased and the rest
  preserved (`sources` → "Sources", `cross-cutting` → "Cross-cutting"). Header
  shows the page count: `<summary><b>Label</b> (n)</summary>`.
- Each group is `<details open>` (expanded by default) with a blank line after the
  `</summary>` and before `</details>` so the Markdown list renders.
- Links use the frontmatter `title` for text and the page slug for target,
  sorted alphabetically by title within a group.

### _Footer.md
Unchanged: `_Generated by [Open Knowledge Hub](…) from [owner/repo](repoUrl) @
`<short>` on <timestamp>._` plus optional `config.footer`.

### Concept page banner
Slim, single-module form (drop the module segment):
`> 📘 <repo> › <title> · _Generated by Open Knowledge Hub — do not edit._`

## 8. Assets

Knowledge modules are text-first; the target module has zero assets. Support is
kept but flattened for correctness:
- An asset at module-relative path `a` → written to the wiki root under its
  path-encoded flat name `pathSlug(a)` (which keeps the extension, since
  `pathSlug` only strips a trailing `.md`): `assets/retry.png` → `assets-retry.png`.
- A concept image/link `![alt](../assets/retry.png)` resolves the asset the same
  way as §6 step 3, then emits `![alt](assets-retry.png)` (bare filename; GitHub
  serves wiki-root files).
- Missing asset → `dangling-asset` warning, original left in place.

## 9. Renderer API change

`RenderInput` becomes single-module:

```ts
export type RenderInput = { module: RenderModule; context: RenderContextInfo };
```

`renderWikiSite(input)` returns `{ pages, assets, warnings }` as before. Internal
helpers drop the module loop and the `<module>/` path prefix; the page index maps
module-relative concept paths (and `index.md`→`Home`) to slugs.

`buildAndPublishWiki` selects the single module (§4) and passes
`{ module, context }`.

## 10. Files

- **Create** `src/wiki/slug.ts` — `pathSlug`.
- **Modify** `src/wiki/renderer.ts` — single-module input; flat slug pages;
  slug-based link/asset rewriting; Home-from-index; folder-grouped collapsible
  sidebar; slim banner.
- **Modify** `src/wiki/publish.ts` — config-driven single-module selection and
  errors; pass `{ module, context }` to the renderer.
- **Modify** `src/wiki/config.ts` — add `module?: string`.
- **Modify** enable scaffold (starter `.okh/wiki.yml`) — commented `module:` line.
- **Modify** `resources/docs/wiki.md` — document single-module `module:` config,
  flat slugs, and the new navigation.
- **Tests**: `test/wiki-slug.test.ts` (new), `test/wiki-renderer.test.ts`
  (rewrite for the new scheme), `test/wiki-publish.test.ts` (module-selection
  errors + happy path), `test/wiki-config.test.ts` (`module` parsed).

## 11. Testing strategy

Pure-function unit tests (no git/network):

- **slug**: nested path, hyphenated filename, `.md` stripping, collision de-dup.
- **renderer**:
  - Concept pages emitted at **root** slugs (`sources-eed.md`), not nested.
  - Home = module `index.md` body, frontmatter stripped, `index.md` self-links →
    `Home`, other links → bare slugs.
  - Link rewriting: relative (`./`, `../`), module-root (`/sources/eed.md`), and
    bare sibling all → same bare slug; `#anchor` preserved; unresolved `.md` →
    `dangling-link` warning.
  - `_Sidebar`: `[🏠 Home](Home)`; one `<details open>` per subfolder with
    counts; titles from frontmatter; alphabetical group and item order; root-level
    pages listed ungrouped first.
  - `_Footer` unchanged; slim banner format.
  - No-`index.md` fallback Home.
- **publish**: missing `module` → `INVALID_ARGUMENT`; unknown/non-knowledge
  `module` → `INVALID_ARGUMENT` listing available; happy path renders only the
  named module.
- **config**: `module` parsed from `.okh/wiki.yml`.

## 12. Live verification

After implementation, re-run the CLI publish against
`davidzh_microsoft/core-meeting-knowledge-hub` (Wikis already initialized). The
clean-mirror replaces the current broken nested pages. Confirm on the live wiki
that sidebar and in-page links resolve (spot-check `sources-eed`,
`cross-cutting-id-pivots`, and a `../`-style cross-link).

## 13. Migration

No data migration: the wiki is fully generated and clean-mirrored on every
publish, so the next publish removes all nested pages and replaces them with the
flat set. Container authors must add `module:` to `.okh/wiki.yml`; without it the
publish fails fast with an actionable error.
