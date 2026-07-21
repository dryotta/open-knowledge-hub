# Wiki Flat Single-Module Navigation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the wiki output layer so it publishes exactly one knowledge module (chosen in config) to a flat GitHub-wiki namespace with working slug-based links and a folder-grouped collapsible sidebar.

**Architecture:** A new pure `pathSlug` helper encodes module-relative paths into flat wiki slugs. `renderer.ts` becomes single-module: it emits `<slug>.md` root pages, a curated `Home.md` from the module `index.md`, and a `_Sidebar.md` grouped by top-level subfolder with `<details open>`. `publish.ts` selects the one module named by `.okh/wiki.yml`'s new `module:` key and errors if absent/wrong. Clone/push/CLI/CI are unchanged.

**Tech Stack:** Node/TypeScript (ESM), `tsx`, `vitest`. POSIX path math via `node:path` `posix`.

## Global Constraints

- Renderer stays pure: input in, `{ pages, assets, warnings }` out; no filesystem or network I/O.
- Wiki special files keep Gollum names: `Home.md`, `_Sidebar.md`, `_Footer.md`.
- Frontmatter is stripped from every concept body and Home via `parseFrontmatter`.
- Deterministic output: same inputs → byte-identical pages; group + item order alphabetical.
- Internal links must be **bare slugs** (`[t](sources-eed)`), never nested paths or `.md`.
- Commit trailers on every commit: `Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>` and `Copilot-Session: c7a78b2b-2b13-492b-93de-e9626ff7f678`.
- Tests: `node_modules/.bin/vitest run test/<file>.test.ts`; typecheck: `node_modules/.bin/tsc --noEmit`.

---

### Task 1: Slug helper

**Files:**
- Create: `src/wiki/slug.ts`
- Test: `test/wiki-slug.test.ts`

**Interfaces:**
- Produces: `pathSlug(moduleRelPath: string): string` — strips a trailing `.md`, replaces `/` with `-`. Case preserved.

- [ ] **Step 1: Write failing tests** (`test/wiki-slug.test.ts`)

```ts
import { describe, it, expect } from "vitest";
import { pathSlug } from "../src/wiki/slug.js";

describe("pathSlug", () => {
  it("encodes nested paths", () => {
    expect(pathSlug("sources/eed.md")).toBe("sources-eed");
    expect(pathSlug("cross-cutting/id-pivots.md")).toBe("cross-cutting-id-pivots");
  });
  it("handles root-level files", () => {
    expect(pathSlug("glossary.md")).toBe("glossary");
  });
  it("preserves an existing extension on non-md assets", () => {
    expect(pathSlug("assets/retry.png")).toBe("assets-retry.png");
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (`pathSlug` not defined)

Run: `node_modules/.bin/vitest run test/wiki-slug.test.ts`

- [ ] **Step 3: Implement** (`src/wiki/slug.ts`)

```ts
/** Encode a module-relative path into a flat GitHub-wiki slug. */
export function pathSlug(moduleRelPath: string): string {
  return moduleRelPath.replace(/\.md$/i, "").split("/").join("-");
}
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit** — `feat(wiki): add flat path-slug helper`

---

### Task 2: Config `module` field

**Files:**
- Modify: `src/wiki/config.ts`
- Test: `test/wiki-config.test.ts`

**Interfaces:**
- Produces: `WikiConfig` gains `module?: string`; `parseWikiConfig` reads a `module:` line.

- [ ] **Step 1: Add failing test** to `test/wiki-config.test.ts`

```ts
it("reads the module key", () => {
  expect(parseWikiConfig("module: telemetry\ntitle: T\n")).toEqual({ module: "telemetry", title: "T" });
});
```

- [ ] **Step 2: Run — expect FAIL**

Run: `node_modules/.bin/vitest run test/wiki-config.test.ts`

- [ ] **Step 3: Implement** — in `src/wiki/config.ts`, extend the type and parser:

```ts
export type WikiConfig = { title?: string; footer?: string; module?: string };
```
and inside the key switch add:
```ts
else if (key === "module") cfg.module = value;
```

- [ ] **Step 4: Run — expect PASS**

- [ ] **Step 5: Commit** — `feat(wiki): parse module key from wiki.yml`

---

### Task 3: Single-module flat renderer + publish selection

This is the core. The renderer API change (`RenderInput.modules[]` → `RenderInput.module`) ripples into `publish.ts`, so both are updated and committed together to keep the build green.

**Files:**
- Modify: `src/wiki/renderer.ts` (rewrite output layer)
- Modify: `src/wiki/publish.ts` (single-module selection + errors)
- Test: `test/wiki-renderer.test.ts` (rewrite), `test/wiki-publish.test.ts` (selection)

**Interfaces:**
- Consumes: `pathSlug` (Task 1), `WikiConfig.module` (Task 2), `parseFrontmatter` (existing).
- Produces (renderer): `RenderInput = { module: RenderModule; context: RenderContextInfo }`; `renderWikiSite(input): WikiSite`; `bannerFor(repo, title): string` (module segment dropped). `RenderModule` shape unchanged (`path, description?, indexMarkdown?, concepts[], assets[]`).
- Produces (publish): `buildAndPublishWiki` selects the module whose `basename(path) === config.module` and `type === "knowledge"`; throws `OkhError("INVALID_ARGUMENT", …)` when `module` unset or not found.

#### 3a — Renderer

- [ ] **Step 1: Rewrite `test/wiki-renderer.test.ts`** to the single-module flat scheme. Replace `input()`/`linkInput()`/`assetInput()` to use `module:` (singular) and assert:
  - Concept page at **root slug**: `paths` contains `sources-eed.md` (not nested); banner is `bannerFor("widgets","EED")`.
  - `bannerFor("widgets","Retry")` === `> 📘 widgets › Retry · _Generated by Open Knowledge Hub — do not edit._`.
  - Home = module `index.md` body, frontmatter stripped; a link `[e](./sources/eed.md)` in index → `[e](sources-eed)`; a self `[home](./index.md)` → `[home](Home)`.
  - Links from a concept: `./timeout.md`, `../sources/eed.md`, `/sources/eed.md`, and bare `eed.md` (from a sibling) all → bare slug; `#anchor` preserved; `https://…` untouched; missing `.md` → `dangling-link` warning.
  - `_Sidebar` contains `[🏠 Home](Home)`, a `<details open><summary><b>Sources</b> (n)</summary>` per top-level subfolder, `[title](slug)` items sorted alphabetically, groups alphabetical, root-level pages listed ungrouped before groups.
  - `_Footer` unchanged (owner/repo, short commit, timestamp, optional footer text).
  - No-`index.md` fallback: Home starts with `# <title>` and lists grouped links.
  - Asset: `![d](../assets/retry.png)` → `![d](assets-retry.png)`; `site.assets` path === `assets-retry.png`; missing asset → `dangling-asset`.

- [ ] **Step 2: Run — expect FAIL** (`module` shape / new output)

Run: `node_modules/.bin/vitest run test/wiki-renderer.test.ts`

- [ ] **Step 3: Rewrite `src/wiki/renderer.ts`.** Key changes (full design in the spec §5–§9):
  - Types: `RenderInput = { module: RenderModule; context: RenderContextInfo }`; drop `sortedModules`, `NavEntry.module` prefix. `bannerFor(repo, title)` drops the module arg.
  - **Page index**: map each concept module-relative path → `pathSlug(path)`; map `index.md` → sentinel `"Home"`. Build a `used` set for collision de-dup on slugs (`-2` + `collision` warning).
  - **Concept pages**: for each non-reserved concept, write `{ path: `${slug}.md`, content: banner + "\n\n" + rewritten body }`. `stripFrontmatter` the body.
  - **rewriteBody**: resolve target → module-relative path (leading `/` → strip slash; else `posix.normalize(posix.join(currentModuleDir, pathPart))` where `currentModuleDir = posix.dirname(conceptModuleRelPath)`). If resolved === module `index.md` (case-insensitive) → `Home`. Else lookup in page index → bare slug. `.md` miss → `dangling-link`. Non-`.md` → asset: resolve, `pathSlug` flat name, collect, emit bare filename; miss → `dangling-asset`. Preserve `#anchor`; skip scheme/`#` targets.
  - **Home**: if `module.indexMarkdown`, body = `stripFrontmatter` + rewritten (context: currentModuleDir = "" i.e. module root, currentSlug irrelevant). Else fallback `# ${title}` + grouped list (reuse sidebar grouping helper, flat `[title](slug)`).
  - **_Sidebar**: `[🏠 Home](Home)`, blank line, then root-level pages (module-rel path with no `/`, excluding `index.md`) as `- [title](slug)`; then per top-level subfolder (alphabetical) a `<details open><summary><b>${titleCase(folder)}</b> (${n})</summary>` block, blank line, sorted `- [title](slug)` items, blank line, `</details>`. `titleCase` = upper-case first char only. Sort items by title.
  - **_Footer**: unchanged.
  - `renderWikiSite`: build index from the single module, render concepts, structural pages; collect + dedupe assets; sort pages/assets by path.

  Grouping helper (module-relative concept records `{ slug, title, path }`):
```ts
type PageRec = { slug: string; title: string; path: string };
function groupBySubfolder(recs: PageRec[]): { root: PageRec[]; groups: { name: string; items: PageRec[] }[] } {
  const root: PageRec[] = [];
  const byFolder = new Map<string, PageRec[]>();
  for (const r of recs) {
    const i = r.path.indexOf("/");
    if (i === -1) root.push(r);
    else {
      const folder = r.path.slice(0, i);
      (byFolder.get(folder) ?? byFolder.set(folder, []).get(folder)!).push(r);
    }
  }
  const groups = [...byFolder.entries()]
    .map(([name, items]) => ({ name, items: items.sort((a, b) => a.title.localeCompare(b.title)) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  root.sort((a, b) => a.title.localeCompare(b.title));
  return { root, groups };
}
const titleCase = (s: string): string => (s ? s[0].toUpperCase() + s.slice(1) : s);
```

- [ ] **Step 4: Run — expect PASS** (`test/wiki-renderer.test.ts`)

- [ ] **Step 5: Commit** — `feat(wiki): flat single-module renderer with grouped sidebar`

#### 3b — Publish selection

- [ ] **Step 6: Update `test/wiki-publish.test.ts`.** Fixture already has a `design` (knowledge) + `skills` module. Add `.okh/wiki.yml` writing helper. Assert:
  - Missing `module:` → rejects with `INVALID_ARGUMENT`.
  - `module: nope` → rejects, message lists `design`.
  - `module: design` dry-run → `pages >= 3` (Home, _Sidebar, _Footer, retry slug), `wikiUrl` correct.
  - `module: design` publish to bare remote → `published`.

```ts
async function writeWikiConfig(dir: string, body: string) {
  await mkdir(join(dir, ".okh"), { recursive: true });
  await writeFile(join(dir, ".okh", "wiki.yml"), body);
}
```
(Note: fixture writes `.okh/wiki.yml` after `git init`; commit it or the working tree read still sees it — `loadWikiConfig` reads the working tree, so no commit needed.)

- [ ] **Step 7: Run — expect FAIL**

Run: `node_modules/.bin/vitest run test/wiki-publish.test.ts`

- [ ] **Step 8: Update `src/wiki/publish.ts`.** Replace the module loop with single-module selection:

```ts
const config = await loadWikiConfig(repoRoot);
if (!config.module) {
  throw new OkhError(
    "INVALID_ARGUMENT",
    "Set 'module:' in .okh/wiki.yml to the knowledge module to publish (e.g. module: telemetry).",
  );
}
const discovered = await discoverModules(repoRoot);
const knowledge = discovered.filter((m) => m.manifest?.type === "knowledge");
const picked = knowledge.find((m) => basename(m.path) === config.module);
if (!picked) {
  const avail = knowledge.map((m) => basename(m.path)).join(", ") || "(none)";
  throw new OkhError(
    "INVALID_ARGUMENT",
    `Knowledge module '${config.module}' not found. Available knowledge modules: ${avail}.`,
  );
}
const moduleModel = await buildRenderModule(join(repoRoot, picked.path), basename(picked.path), picked.manifest.description);
const site = renderWikiSite({ module: moduleModel, context: { …info, timestamp, config } });
```
Move `loadWikiConfig` above discovery. Keep `dryRun`, publish, and result unchanged.

- [ ] **Step 9: Run — expect PASS** (`test/wiki-publish.test.ts`)

- [ ] **Step 10: Typecheck** — `node_modules/.bin/tsc --noEmit` → clean.

- [ ] **Step 11: Commit** — `feat(wiki): select single knowledge module by config`

---

### Task 4: Scaffold starter config + docs

**Files:**
- Modify: `src/container/service.ts` (starter `.okh/wiki.yml` body)
- Modify: `resources/docs/wiki.md`
- Test: existing `test/service-wiki.test.ts` only checks file existence — no new test needed; run it to confirm still green.

- [ ] **Step 1: Update starter config** in `service.ts` `scaffoldWikiFiles`:

```ts
"# Open Knowledge Hub wiki config\n" +
  "# module: <knowledge-module-folder>   # required: the single module to publish\n" +
  "# title: My Knowledge Base\n" +
  "# footer: (c) My Org\n",
```

- [ ] **Step 2: Update `resources/docs/wiki.md`** — change "every knowledge module" to a single explicit module; document the required `module:` key; describe flat slugs and the grouped collapsible sidebar; update the "How it works" numbered list (renders one module's `index.md` as Home + one `<slug>` page per concept). Update the customizing example to include `module:`.

- [ ] **Step 3: Run** `node_modules/.bin/vitest run test/service-wiki.test.ts` → PASS.

- [ ] **Step 4: Commit** — `docs(wiki): single-module config and flat navigation`

---

### Task 5: Full verification + live E2E

- [ ] **Step 1: Full suite** — `node_modules/.bin/vitest run` → all green (1 pre-existing skip acceptable).
- [ ] **Step 2: Typecheck** — `node_modules/.bin/tsc --noEmit` → clean.
- [ ] **Step 3: Live E2E** against `davidzh_microsoft/core-meeting-knowledge-hub`:
  - EMU token: `DZ_TOKEN=$(gh auth token --hostname github.com --user davidzh_microsoft)`.
  - Clone with `https://x-access-token:${DZ_TOKEN}@github.com/davidzh_microsoft/core-meeting-knowledge-hub.git`.
  - Add `module: telemetry` to `.okh/wiki.yml` in the clone (commit locally so discovery + config see it), then run `GITHUB_TOKEN=$DZ_TOKEN node_modules/.bin/tsx src/index.ts wiki publish --repo <clone>`.
  - Confirm: 0 broken links, 0 raw frontmatter, sidebar groups render, and live pages `sources-eed`, `cross-cutting-id-pivots` resolve. Spot-check a `../`-style cross-link.
- [ ] **Step 4:** Report page count + warnings to the user for review.

---

## Self-Review

**Spec coverage:** §4 module selection → Task 2 + Task 3b; §5 slugs → Task 1 + Task 3a; §6 link rewriting → Task 3a; §7 structural pages → Task 3a; §8 assets → Task 3a; §9 renderer API → Task 3a; §10 files → Tasks 1–4; §11 testing → Tasks 1–4; §12 live verify → Task 5. Full coverage.

**Placeholder scan:** none — all steps carry real code or concrete edits.

**Type consistency:** `RenderInput.module` (singular) used consistently in Task 3; `bannerFor(repo, title)` two-arg used in both renderer impl and tests; `pathSlug` signature identical across Tasks 1/3; `config.module` string across Tasks 2/3b.
