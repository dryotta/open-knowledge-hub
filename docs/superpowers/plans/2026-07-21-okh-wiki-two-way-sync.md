# Implementation Plan: OKH Wiki Manifest-Driven Two-Way Sync

**Spec:** `docs/superpowers/specs/2026-07-21-okh-wiki-two-way-sync-design.md`
**Branch:** `dryotta-wiki-sync-design` (PR #48)

## Revision R1 — Multi-module

After the single-module tasks below landed, the design was generalized to publish
**every** module with `wiki-sync: true` (any type), sorted alphabetically. See the
spec's "Revision R1" section for the authoritative deltas. Implemented changes:
`selectWikiModule` → `selectWikiModules` (plural, all types); generic `.md`
enumeration in `buildRenderModule`; multi-module renderer with namespaced slugs,
a generated Home landing, one `<details>` sidebar section per module (first open),
and index.md-driven per-module ordering; a new `wiki-sync-expanded` manifest key;
and reverse sync that partitions changed pages by module and lands each per its
`wiki-sync-reverse-mode` (`direct` commit, combined `pr`, or `off`).

## For agentic workers

**REQUIRED SUB-SKILL:** Use `test-driven-development` for every task — write the
failing test first, watch it fail, implement, watch it pass, then commit. One
commit per task with the required trailers.

## Global constraints

- Use `npm install` (not `npm ci`); do **not** commit `package-lock.json`.
- Targeted tests: `node_modules/.bin/vitest run test/<file>.test.ts`.
- Typecheck: `node_modules/.bin/tsc --noEmit`.
- Kebab-case manifest keys are read as `manifest["wiki-sync"]`.
- Every commit ends with:
  ```
  Co-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>
  Copilot-Session: c7a78b2b-2b13-492b-93de-e9626ff7f678
  ```

## Bot identity (shared constant)

`src/wiki/constants.ts` exports `WIKI_BOT_NAME`, `WIKI_BOT_EMAIL`, and
`WIKI_CHROME = new Set(["_Header.md","_Footer.md","_Sidebar.md"])`.

## Tasks

1. **Manifest keys** — `manifest.ts` + `module-manifest.test.ts`. Add
   `"wiki-sync": z.boolean().optional()` and
   `"wiki-sync-reverse-mode": z.enum(["pr","direct","off"]).optional()`.
2. **selectWikiModule** — `src/wiki/select.ts` + `test/wiki-select.test.ts`.
   0/1/N knowledge modules with `wiki-sync: true`. Returns
   `{ moduleRoot, name, manifest, reverseMode }` (default `"pr"`).
3. **Git helpers** — `commitAs`, `logLastCommitBy`, `nameStatus` in `git.ts` +
   `test/git-wiki.test.ts` (real temp repos).
4. **Renderer reshape + config removal** — `renderer.ts` (metadata `_Header`,
   provenance `_Footer`, clean bodies, `slugToSource`, `RenderContextInfo` gains
   `title`+`reverseMode`, drops `config`); delete `src/wiki/config.ts` and
   `test/wiki-config.test.ts`; rewrite `test/wiki-renderer.test.ts`.
5. **Publish refactor** — `publish.ts` (`selectWikiModule`, bot identity, derive
   title) + `repo.ts` (`commitAs`); rewrite `test/wiki-publish.test.ts`.
6. **GitHub REST PR** — `src/wiki/github.ts` `openPr(...)` + `test/wiki-github.test.ts`
   (mocked `fetch`).
7. **Reverse core** — `src/wiki/reverse.ts` `reverseSyncWiki` +
   `test/wiki-reverse.test.ts` (A/M/R/D, new→flat, Home→index, frontmatter
   preserved, link un-rewrite, empty-diff no-op, off/no-baseline, pr vs direct).
8. **CLI reverse** — `src/wiki/cli.ts` + `test/wiki-cli.test.ts` (uses
   `wiki-sync` manifest, adds `reverse`).
9. **Workflow + scaffold + docs** — `resources/wiki/workflow.yml` (two
   triggers/jobs), `service.ts` scaffold (workflow only), `test/service-wiki.test.ts`,
   `resources/docs/wiki.md`, `resources/tool-meta/config.md`.
10. **Verify** — full `vitest run` + `tsc --noEmit`, then live E2E.

## Loop-safety invariant

Reverse diffs `BASE..HEAD` where BASE = most recent wiki commit by the bot
identity. Immediately after a forward push `HEAD === BASE` → empty diff → reverse
no-ops. This is intrinsic, independent of GITHUB_TOKEN event suppression.

## Data-integrity invariant

Reverse MUST re-attach the destination source file's original OKF frontmatter
verbatim when writing an edit back. Compute raw frontmatter as
`text.slice(0, text.length - parseFrontmatter(text).body.length)`.
