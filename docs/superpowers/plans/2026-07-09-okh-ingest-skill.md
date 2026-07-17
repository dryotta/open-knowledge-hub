# OKH `ingest` Shared Skill Implementation Plan

> **Superseded historical plan:** Do not implement this standalone-run design.
> Current ingest guidance is `okh://instructions/ingest.md`; it is applied before
> running a concrete target module's skill.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a vendored, module-less `ingest` shared skill that gives the client agent a reliable playbook to turn source documents into cited candidate knowledge and route them to `learn`/`remember`.

**Architecture:** `ingest` is discipline text only — a new `resources/shared/skills/ingest/SKILL.md`, auto-discovered by `sharedSkills()` (`src/modules/shared.ts`) and run via `run { skill: "ingest" }`. No `src/` change; the rest is a discovery test plus README/USAGE wording.

**Tech Stack:** Markdown resources (SKILL.md), TypeScript/Vitest for the discovery test.

**Spec:** `docs/superpowers/specs/2026-07-09-okh-ingest-skill-design.md`

---

## File Structure

- `resources/shared/skills/ingest/SKILL.md` — the ingest discipline (new; auto-registers).
- `test/run.test.ts` — add a shared-skill discovery assertion for `ingest`.
- `README.md:46` — list `ingest` among shared skills.
- `USAGE.md:57` — list `ingest` + a one-line "OKH can't see chat attachments" note.

---

## Task 1: Create the `ingest` shared skill (TDD via discovery test)

**Files:**
- Create: `resources/shared/skills/ingest/SKILL.md`
- Test: `test/run.test.ts` (the `describe("shared skills", …)` block, lines 53-60)

- [ ] **Step 1: Write the failing test**

In `test/run.test.ts`, inside the existing `describe("shared skills", () => { … })` block (after
the `resolveSharedSkill returns the grilling body` test, before the closing `});` on line 60), add:

```ts
  it("resolveSharedSkill returns the ingest body; ingest is listed among shared skills", async () => {
    const { svc } = await setup();
    const s = await svc.resolveSharedSkill("ingest");
    expect(s.name).toBe("ingest");
    expect(s.body).toMatch(/route/i);
    await expect(svc.resolveSharedSkill("nope")).rejects.toThrow(/ingest/);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/run.test.ts -t "ingest"`
Expected: FAIL — `resolveSharedSkill("ingest")` throws `No shared skill "ingest"` (the file
doesn't exist yet).

- [ ] **Step 3: Create the skill file**

Create `resources/shared/skills/ingest/SKILL.md` with this EXACT content (note: the frontmatter
`description` contains no unquoted `": "`, which would silently break skill discovery):

```markdown
---
name: ingest
description: Turn source documents (PDFs, docs, images, URLs, or pasted content) into cited candidate knowledge and route each to the target module's own skill for scope-gating and writing.
---

# Ingest source documents

Turn **source documents** — PDFs, docs, images, URLs, or content already pasted into the
conversation — into cited candidate knowledge, then route each candidate to the **target module's
own skill** (`learn` for knowledge, `remember` for memory), which owns the scope gate and the
actual writing. You extract and reason; the target skill decides what earns a place and writes it.

OKH runs no model and never reads files — extraction is **your** job, and OKH **cannot see chat
attachments**. Run these stages in order.

## Stage 1 — Locate the sources (explicitly)

Work only from:
- content already visible to you in this conversation (text the client pasted or attached that you
  can actually read), or
- explicit **file paths or URLs** the user gives you.

You **cannot see chat attachments** through OKH, and you must **never crawl the filesystem
guessing** — no scanning `Downloads`, `Documents`, `Desktop`, or similar. If you have neither
readable content nor explicit locations, **ask the user for them**. Restate the full list of
sources back and confirm it is complete before extracting, so nothing is silently missed.

## Stage 2 — Extract

For each source, obtain its **text** with your own tools: PDF/doc/image → text, using OCR or table
extraction when the document is scanned or tabular. If a source **can't be read or extracted**, do
not invent its contents — list it as a failure and ask how to proceed.

## Stage 3 — Normalize into candidates (with provenance)

Turn the extracted material into **discrete candidate facts or concepts**. Each candidate carries
a **source citation** — the file name/path or URL, plus page/section/row where available — so the
target skill can ground and cite it. Group candidates by their likely target module, and (for a
knowledge module) by its declared structure.

## Stage 4 — Route to the target (delegate scope and writing)

Identify the **target module**; if the request doesn't make it clear, ask. Then hand candidates to
the target's own skill — **do not write module files yourself**:

- **knowledge** → `run { container, module, skill: "learn" }`
- **memory** → `run { container, module, skill: "remember" }`

Before writing in bulk, present a short **routing plan**: what goes to which module, and which
candidates look **out of scope**. Get the user's confirmation. Respect the target's scope
contract — if material falls outside it (e.g. a Health module whose contract excludes
metrics/vitals versus attached lab panels), **surface the conflict**: propose a scope change
through the target's grilling, or a different or new module. Never silently drop a candidate, and
never silently expand scope.

## Stage 5 — Report

Summarize the run: sources ingested; candidates written, grouped by target module; out-of-scope or
deferred candidates; and any sources that failed extraction.

## Completion criterion

- Every provided source is **accounted for** — ingested, deferred, or reported as unreadable.
- Every **written** candidate carries a source citation and passed the target skill's scope gate.
- Scope conflicts were **surfaced** to the user, not silently resolved.
- No filesystem crawling occurred; missing sources were requested from the user.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/run.test.ts -t "ingest"`
Expected: PASS.

- [ ] **Step 5: Run the full run.test.ts + typecheck**

Run: `npx vitest run test/run.test.ts` — Expected: PASS (all shared/effective-skill tests).
Run: `npm run typecheck` — Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add resources/shared/skills/ingest/SKILL.md test/run.test.ts
git commit -m "feat: add ingest shared skill (source documents -> cited candidates -> learn/remember)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: Docs ripple — README + USAGE

**Files:**
- Modify: `README.md:46`
- Modify: `USAGE.md:57`

- [ ] **Step 1: Update README shared-skills list**

In `README.md`, replace:

```markdown
(`grilling`, `okf-writer`) live under `resources/shared/skills/` and run via
```

with:

```markdown
(`grilling`, `okf-writer`, `ingest`) live under `resources/shared/skills/` and run via
```

- [ ] **Step 2: Update USAGE shared-skill line + add ingest usage/limitation**

In `USAGE.md`, replace the single line:

```markdown
- **Shared skill (no module):** `hub, run the grilling skill to stress-test my plan.` — shared skills (`grilling`, `okf-writer`) run via `run { skill }` with no container/module.
```

with these two lines:

```markdown
- **Shared skill (no module):** `hub, run the grilling skill to stress-test my plan.` — shared skills (`grilling`, `okf-writer`, `ingest`) run via `run { skill }` with no container/module.
- **Ingest documents:** `hub, ingest these lab PDFs into my Health module.` — the `ingest` skill extracts source docs into cited candidates and routes them to `learn`/`remember`. OKH can't see chat attachments, so give file paths/URLs or paste the content.
```

- [ ] **Step 3: Sanity-check the docs render (no test needed)**

Run: `git diff --stat README.md USAGE.md`
Expected: both files show as modified with small insertions.

- [ ] **Step 4: Commit**

```bash
git add README.md USAGE.md
git commit -m "docs: list the ingest shared skill and note the chat-attachment limitation

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck + full unit suite**

Run: `npm run typecheck && npm test`
Expected: exit 0; all tests pass (including the new `ingest` discovery test).

- [ ] **Step 2: Eval structure checks (no regressions)**

Run: `npm run typecheck:eval && npm run test:eval && npm run eval:validate`
Expected: typecheck exit 0; eval unit tests pass; validate prints "Configuration is valid."

- [ ] **Step 3: Confirm the skill is discoverable end-to-end (optional manual check)**

Run: `node --import tsx -e "import('./src/modules/shared.js').then(m => m.sharedSkills()).then(s => console.log(s.map(x => x.name).sort()))"`
Expected: output includes `ingest` alongside `grilling` and `okf-writer`.

---

## Self-Review notes

- **Spec coverage:** shared-skill placement (§2 → T1 file + auto-discovery), the 5 discipline
  stages + completion criterion (§3 → T1 SKILL.md content verbatim), README/USAGE ripple (§4 → T2),
  verification incl. eval structure (§5 → T3). Eval scenario is explicitly deferred (§7), so no task.
- **No placeholders:** the full SKILL.md body and both doc edits are shown verbatim; the test code
  is complete.
- **Type consistency:** uses only the existing `svc.resolveSharedSkill(name)` API (returns a `Skill`
  with `.name`/`.body`), already exercised by the adjacent grilling test.
- **Frontmatter safety:** the `description` avoids an unquoted `": "` (the known discovery-breaking
  gotcha).
