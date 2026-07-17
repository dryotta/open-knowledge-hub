# OKH Ingest Source Retention — Implementation Plan

> **Historical note:** Standalone skill APIs referenced below were removed. Current
> ingest guidance is an MCP instruction resource applied to a target module's skill.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a knowledge module opt in (during `initialize`) to keeping a copy of each ingested source document under `./sources/<YYYY-MM>/`, and have `ingest` honor that policy and cite the retained copy.

**Architecture:** Pure discipline — the policy lives in the module's `index.md` (`## Sources` section); `initialize` grills & writes it, `ingest` reads & honors it. No `src/`/schema/tool change. A new deterministic eval assertion verifies a source was retained.

**Tech Stack:** Markdown resources (SKILL.md, index-skeleton.md), TypeScript/Vitest for the eval assertion, promptfoo harness.

**Spec:** `docs/superpowers/specs/2026-07-09-okh-ingest-source-retention-design.md`

---

## File Structure

- `resources/module-types/knowledge/skills/initialize/SKILL.md` — Stage 1 records the retention policy.
- `resources/module-types/knowledge/index-skeleton.md` — optional `## Sources` placeholder.
- `resources/shared/skills/ingest/SKILL.md` — new Retain stage + provenance + renumber.
- `README.md`, `USAGE.md` — document retention.
- `eval/fixtures/health-hub/health/index.md` — enable retention in the fixture.
- `eval/assertions/source-retained.ts` — deterministic "source was copied under sources/" check.
- `eval/scenarios/ingest/into-existing-module.yaml` — add the assertion + a judge criterion.

---

## Task 1: `initialize` records the retention policy + skeleton placeholder

**Files:**
- Modify: `resources/module-types/knowledge/skills/initialize/SKILL.md` (Stage 1)
- Modify: `resources/module-types/knowledge/index-skeleton.md`

- [ ] **Step 1: Add source-retention to initialize Stage 1**

In `resources/module-types/knowledge/skills/initialize/SKILL.md`, find the paragraph in Stage 1 that
begins "Optionally record **sourcing conventions**" and replace it with these two paragraphs:

    Optionally record **sourcing conventions** — where the module's knowledge comes from and how
    claims are checked (e.g. code: "cite repository paths, pin a commit SHA"). Capture this only when
    it helps the module.

    Also decide **source retention** — whether documents ingested into this module should be **kept
    in the module** (default **no**). If yes, write a `## Sources` section to `index.md` recording
    **Retain copies: yes**, the **Folder** (default `./sources/`), and the **Bucketing** (default by
    month, `<YYYY-MM>/`, the ingest date). If retention stays off, either omit the section or write
    `Retain copies: no`. `ingest` reads this section and honors it.

(Write those as normal markdown paragraphs in the SKILL.md — no code fence.)

- [ ] **Step 2: Add the optional Sources section to the skeleton**

In `resources/module-types/knowledge/index-skeleton.md`, insert this block immediately before the
`## Concepts` section (i.e. after the existing sourcing-conventions HTML comment and before
`## Concepts`):

```markdown
## Sources

<!-- Optional — ingestion retention policy. Default: do not keep copies.
To keep a copy of each ingested source in this module, set Retain copies: yes and adjust:
- **Retain copies:** yes
- **Folder:** `./sources/`
- **Bucketing:** by month — `<YYYY-MM>/` (the ingest date)
-->

Retain copies: no

```

- [ ] **Step 3: Verify skills + skeleton still parse / tests green**

Run: `npx vitest run test/inspect.test.ts test/loaders.test.ts test/service.test.ts`
Expected: PASS (the knowledge scaffold still writes a valid `index.md` containing `okf_version`;
skill discovery reads frontmatter, unchanged).

- [ ] **Step 4: Commit**

```bash
git add resources/module-types/knowledge/skills/initialize/SKILL.md resources/module-types/knowledge/index-skeleton.md
git commit -m "feat(initialize): grill + record per-module source retention policy in index.md

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: `ingest` honors the retention policy

**Files:**
- Modify: `resources/shared/skills/ingest/SKILL.md`

- [ ] **Step 1: Insert the Retain stage and renumber**

In `resources/shared/skills/ingest/SKILL.md`, replace the block that currently runs from
`## Stage 3 — Normalize into candidates (with provenance)` through the end of
`## Stage 4 — Route to the target (delegate scope and writing)` with the following (this inserts a
new Stage 3 "Retain", makes Normalize Stage 4, Route Stage 5, and updates provenance). Concretely,
replace this existing text:

```markdown
## Stage 3 — Normalize into candidates (with provenance)

Turn the extracted material into **discrete candidate facts or concepts**. Each candidate carries
a **source citation** — the file name/path or URL, plus page/section/row where available — so the
target skill can ground and cite it. Group candidates by their likely target module, and (for a
knowledge module) by its declared structure.

## Stage 4 — Route to the target (delegate scope and writing)
```

with:

```markdown
## Stage 3 — Retain sources (if the module's policy says so)

Read the target module's `index.md` `## Sources` policy — via `inspect { container, module }`
(its overview includes `index.md`) or by reading `index.md` directly. Then:

- **Retain copies: yes** → for each source you **successfully extracted**, copy the original file
  into `<module>/<folder>/<bucket>/<original-filename>` (default `<module>/sources/<YYYY-MM>/`,
  bucketed by the ingest date). Create folders as needed; overwrite on a name collision. Never
  retain a source you could **not** read.
- **Retain copies: no**, or no `## Sources` section → retain nothing.

Retained copies are committed on the next `sync` — flag this for large, binary, or sensitive
documents so the user can opt out.

## Stage 4 — Normalize into candidates (with provenance)

Turn the extracted material into **discrete candidate facts or concepts**. Each candidate carries
a **source citation**:

- retention **on** → cite the **retained in-module path** (`sources/<YYYY-MM>/<file>`) — stable,
  versioned, and synced with the module.
- retention **off** → cite the original file path or URL (plus page/section/row where available).

Group candidates by their likely target module, and (for a knowledge module) by its declared
structure.

## Stage 5 — Route to the target (delegate scope and writing)
```

- [ ] **Step 2: Renumber the remaining stages**

In the same file, rename `## Stage 5 — Report` to `## Stage 6 — Report` (it currently follows the
Route stage). The Route stage body is unchanged; only its heading changed to Stage 5 in Step 1, and
Report becomes Stage 6.

- [ ] **Step 3: Update the completion criterion**

In `resources/shared/skills/ingest/SKILL.md`, replace the completion-criterion list:

```markdown
- Every provided source is **accounted for** — ingested, deferred, or reported as unreadable.
- Every **written** candidate carries a source citation and passed the target skill's scope gate.
- Scope conflicts were **surfaced** to the user, not silently resolved.
- No filesystem crawling occurred; missing sources were requested from the user.
```

with:

```markdown
- Every provided source is **accounted for** — ingested, deferred, or reported as unreadable.
- If the module retains sources, each successfully-ingested source was copied into the configured
  folder (default `sources/<YYYY-MM>/`) and its concepts cite the retained copy.
- Every **written** candidate carries a source citation and passed the target skill's scope gate.
- Scope conflicts were **surfaced** to the user, not silently resolved.
- No filesystem crawling occurred; missing sources were requested from the user.
```

- [ ] **Step 4: Verify the skill still parses**

Run: `npx vitest run test/run.test.ts`
Expected: PASS (the canonical ingest instruction resource still loads and retains
its routing guidance).

- [ ] **Step 5: Commit**

```bash
git add resources/shared/skills/ingest/SKILL.md
git commit -m "feat(ingest): retain ingested sources per module policy and cite the retained copy

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Docs

**Files:**
- Modify: `README.md:46`
- Modify: `USAGE.md:58`

- [ ] **Step 1: README**

In `README.md`, replace:

```markdown
(`grilling`, `okf-writer`, `ingest`) live under `resources/shared/skills/` and run via
```

with:

```markdown
(`grilling`, `okf-writer`, `ingest`) live under `resources/shared/skills/` and run via
<!-- ingest can keep a copy of each ingested source in the module (opt-in per module; ./sources/<YYYY-MM>/). -->
```

- [ ] **Step 2: USAGE**

In `USAGE.md`, replace the ingest entry:

```markdown
- **Ingest documents:** `hub, ingest these lab PDFs into my Health module.` — give file paths/URLs or paste the content (OKH can't see chat attachments). The `ingest` skill extracts each source into cited candidates, proposes a routing plan, then folds them into the target module via `learn`/`remember`, respecting the module's scope contract.
```

with:

```markdown
- **Ingest documents:** `hub, ingest these lab PDFs into my Health module.` — give file paths/URLs or paste the content (OKH can't see chat attachments). The `ingest` skill extracts each source into cited candidates, proposes a routing plan, then folds them into the target module via `learn`/`remember`, respecting the module's scope contract. A module can opt in (during `initialize`) to **keeping a copy of each ingested document** under `./sources/<YYYY-MM>/`; `ingest` honors that policy and cites the retained copy.
```

- [ ] **Step 3: Commit**

```bash
git add README.md USAGE.md
git commit -m "docs: document per-module ingest source retention

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Eval — deterministic source-retained assertion + scenario

**Files:**
- Create: `eval/assertions/source-retained.ts`
- Modify: `eval/fixtures/health-hub/health/index.md`
- Modify: `eval/scenarios/ingest/into-existing-module.yaml`

- [ ] **Step 1: Enable retention in the fixture**

In `eval/fixtures/health-hub/health/index.md`, insert this section immediately before the
`## Concepts` section (after the `## Structure` list, before `## Concepts`):

```markdown
## Sources

- **Retain copies:** yes
- **Folder:** `./sources/`
- **Bucketing:** by month — `<YYYY-MM>/` (the ingest date)

```

- [ ] **Step 2: Create the deterministic assertion**

Create `eval/assertions/source-retained.ts`:

```ts
import { join } from "node:path";
import { readdir } from "node:fs/promises";

interface Ctx {
  config?: { module?: string; dir?: string; filename?: string };
  providerResponse?: { metadata?: { containerPath?: string } };
}

/** Recursively collect file names under `dir` (empty if the dir is missing). */
async function walkNames(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walkNames(p)));
    else if (e.isFile()) out.push(e.name);
  }
  return out;
}

/**
 * Pass iff a copy of the ingested source (config.filename) exists somewhere under
 * `<containerPath>/<module>/<dir>/` (default dir "sources") — i.e. the ingest skill
 * honored the module's retention policy.
 */
export default async function sourceRetained(_output: string, context: Ctx) {
  const containerPath = context.providerResponse?.metadata?.containerPath;
  const module = context.config?.module ?? "kb";
  const dir = context.config?.dir ?? "sources";
  const filename = context.config?.filename;
  if (!containerPath) return { pass: false, score: 0, reason: "no containerPath in metadata" };
  if (!filename) return { pass: false, score: 0, reason: "source-retained needs config.filename" };
  const root = join(containerPath, module, dir);
  const names = await walkNames(root);
  const pass = names.includes(filename);
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass
      ? `retained ${filename} under ${module}/${dir}/`
      : `no copy of ${filename} under ${module}/${dir}/ (found: ${names.join(", ") || "nothing"})`,
  };
}
```

- [ ] **Step 3: Add the assertion + judge criterion to the scenario**

In `eval/scenarios/ingest/into-existing-module.yaml`, add the `source-retained` assertion after the
existing `okf-valid` assertion, and add a `retained-source` judge criterion. The assert block
becomes:

```yaml
      assert:
        - type: javascript
          value: file://assertions/tools-called.ts
          config: { expect: [inspect, run] }
        - type: javascript
          value: file://assertions/okf-valid.ts
          config: { module: health, requireChanged: true }
        - type: javascript
          value: file://assertions/source-retained.ts
          config: { module: health, filename: lab-results.txt }
        - type: javascript
          value: file://assertions/judge.ts
          config:
            criteria:
              - id: resolved-module
                text: The agent located the existing Health knowledge module (in health-hub) to ingest into.
              - id: read-scope-contract
                text: The agent read or acknowledged the module's existing scope contract before writing, rather than treating the module as uninitialized.
              - id: no-reinitialize
                text: The agent did NOT run the initialize skill on the already-scoped module.
              - id: retained-source
                text: The agent kept a copy of the ingested file under the module's sources folder, per the module's retention policy.
```

- [ ] **Step 4: Update the scenario header comment**

In `eval/scenarios/ingest/into-existing-module.yaml`, update the top comment to mention retention:

```yaml
# ingest flow — a path source into an EXISTING, already-scoped knowledge module that
# retains sources. Captures: resolve the module, read its scope contract, author a
# concept (okf-valid), retain the source under sources/<YYYY-MM>/ (source-retained),
# without re-initializing.
```

- [ ] **Step 5: Eval structure checks**

Run: `npm run typecheck:eval` — Expected: exit 0 (the new assertion compiles).
Run: `npm run test:eval` — Expected: PASS (no counted totals changed; assertion files aren't counted).
Run: `npm run eval:validate` — Expected: "Configuration is valid."

- [ ] **Step 6: Commit**

```bash
git add eval/assertions/source-retained.ts eval/fixtures/health-hub/health/index.md eval/scenarios/ingest/into-existing-module.yaml
git commit -m "test(eval): verify ingest retains the source under sources/<YYYY-MM>/

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck + full unit suite**

Run: `npm run typecheck && npm test`
Expected: exit 0; all tests pass (no `src/` change; resources still parse).

- [ ] **Step 2: Eval structure checks**

Run: `npm run typecheck:eval && npm run test:eval && npm run eval:validate`
Expected: typecheck exit 0; eval unit tests pass; validate prints "Configuration is valid."

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 4: Run the ingest scenario end-to-end**

Run: `node --import tsx node_modules/promptfoo/dist/src/entrypoint.js eval -c eval/promptfooconfig.yaml --no-cache --filter-pattern "existing scoped module"`
Expected: 1 passed. Confirm via `~/.promptfoo/promptfoo.db` that the `source-retained` component
passed (a copy of `lab-results.txt` was written under `health/sources/<YYYY-MM>/`) and the agent
did not re-initialize.

- [ ] **Step 5: Full e2e eval (regression sweep)**

Run: `npm run eval`
Expected: no new failures versus the 21/21 baseline; the ingest scenario now also asserts retention.
Treat a lone flaky judge failure as flaky only after a green single-scenario re-run.

---

## Self-Review notes

- **Spec coverage:** policy shape §2 (T1 skeleton + initialize), initialize §3 (T1), ingest honoring
  §4 (T2), skeleton §5 (T1), docs §6 (T3), eval §7 (T4), verification §8 (T5).
- **No placeholders:** every skill edit shows the exact replacement text; the assertion is complete
  code; the scenario YAML is shown in full for the changed block.
- **Type consistency:** `source-retained.ts` reads `providerResponse.metadata.containerPath` (the
  same field `okf-valid.ts`/`memory-append.ts` use) and takes `config: { module, dir?, filename }`,
  matched by the scenario's `config: { module: health, filename: lab-results.txt }`.
- **Binary-safe:** the assertion walks names only (no content read), so it works even when a
  retained source is a binary PDF (the fixture uses a `.txt`, but the check is general).
