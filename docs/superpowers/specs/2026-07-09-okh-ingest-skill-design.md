# OKH — `ingest` shared skill (document ingestion playbook)

**Status:** Approved design (pre-implementation)
**Date:** 2026-07-09
**Branch:** `main`
**Relates to:** `docs/adr/0001-mcp-as-tools-plus-client-intelligence-over-okf.md`, the `learn` and
`remember` module skills.

---

## 1. Summary

Add a vendored **shared skill** `ingest` (`run { skill: "ingest" }`) that gives the client agent
a reliable playbook for turning **source documents** (PDFs, docs, images, URLs, or content already
in the conversation) into cited candidate knowledge, then routing each candidate into the target
module's own skill (`learn` for knowledge, `remember` for memory) — which owns the scope gate and
the actual writing.

The skill is **discipline text only**. OKH runs no LLM and never reads files or parses binaries;
the agent does extraction and reasoning. The skill exists because the current flows have no
guidance for "scan these documents and store what matters," so agents improvise badly (the
motivating failure: an agent crawled `Downloads`/`Documents`, missed one of six attached PDFs, and
stalled).

### Motivating failure (what this fixes)

A user attached six lab-result PDFs and said "scan and remember all the lab results." The agent:
could not access the attachments through OKH, **crawled the filesystem guessing**, found only 5 of
6, and stalled — with no OKH playbook to follow, no provenance discipline, and a target module
whose scope contract actually **excluded** the material (metrics were out of scope).

### Goals

1. A repeatable ingestion playbook: **locate → extract → normalize (with citations) → route →
   report**.
2. Kill the filesystem-crawling behavior: sources must be **explicit**; if absent, **ask**.
3. Preserve OKH's architecture: no server-side file/PDF parsing; delegate scope + writing to the
   target module's existing skill.
4. Preserve provenance: every candidate carries a source citation; scope conflicts are surfaced,
   never silently resolved.

### Non-goals

- Server-side file access or PDF/OCR parsing (violates the no-LLM/no-file architecture).
- Fixing the client's attachment→file plumbing (outside OKH; documented as a limitation).
- A staging/`inbox/` folder convention (YAGNI for now).
- Any change to `learn`/`remember`/`initialize` logic (ingest delegates to them as-is).

---

## 2. Architecture & placement

`ingest` is a **module-less shared skill**, discovered automatically by `sharedSkills()` from
`resources/shared/skills/` (`src/modules/shared.ts:8-13`) and resolved by
`resolveSharedSkill("ingest")`. It is invoked via the `run` tool with **no** container/module
(`src/server/tools.ts` `run` handler → `buildRun(skill, input)`; `src/prompts/index.ts`).

**No `src/` change is required** — adding the resource directory registers the skill. All other
work is the skill body, docs, and tests.

New file: `resources/shared/skills/ingest/SKILL.md` (frontmatter `name: ingest` + a
one-line `description`, then the discipline body). Frontmatter values must contain no unquoted
`": "` (a colon+space silently breaks discovery — see the frontmatter memory).

---

## 3. Skill body — stages

### Stage 1 — Locate the sources (explicitly)

Work **only** from:
- content already visible to you in this conversation (e.g. the client pasted/attached text you
  can read), or
- explicit **paths or URLs** the user provides.

You **cannot see chat attachments** through OKH, and you must **never crawl the filesystem
guessing** (no scanning `Downloads`, `Documents`, etc.). If you have neither readable content nor
explicit locations, **ask the user for them**. Restate the full list of sources back to the user
and confirm it's complete before extracting — so nothing is silently missed.

### Stage 2 — Extract

For each source, obtain its **text** using your own tools (PDF/doc/image → text; use OCR or
table extraction when the document is scanned or tabular). OKH does not read files or parse
binaries — extraction is your job. If a source **can't be read or extracted**, do not fabricate
its contents: list it as a failure and ask how to proceed.

### Stage 3 — Normalize into candidates (with provenance)

Turn the extracted material into **discrete candidate facts/concepts**. Each candidate carries a
**source citation** — the file name/path or URL, plus page/section/row where available — so the
target skill can ground and cite it. Group candidates by their likely target module and (for a
knowledge module) by its declared structure.

### Stage 4 — Route to the target (delegate scope + writing)

Identify the **target module**; if it isn't clear from the request, ask. Then hand candidates to
the target's own skill, which **owns the scope gate and writing** — do not write module files
yourself:
- **knowledge** → `run { container, module, skill: "learn" }`
- **memory** → `run { container, module, skill: "remember" }`

Before bulk-writing, present a short **routing plan**: what goes to which module, and which
candidates look **out of scope**. Get the user's confirmation. Respect the target's scope
contract — if material falls outside it (e.g. a Health module whose contract excludes
metrics/vitals vs. attached lab panels), **surface the conflict** and either propose a scope
change through the target's grilling or suggest a different/new module. Never silently drop a
candidate and never silently expand scope.

### Stage 5 — Report

Summarize the run: sources ingested; candidates written, grouped by target module; out-of-scope or
deferred candidates; and any sources that failed extraction.

## Completion criterion

- Every provided source is **accounted for** — ingested, deferred, or reported as unreadable.
- Every **written** candidate carries a source citation and passed the target skill's scope gate.
- Scope conflicts were **surfaced** to the user, not silently resolved.
- No filesystem crawling occurred; missing sources were requested from the user.

---

## 4. Ripple updates

- **`README.md`** — add `ingest` to the shared-skills / `run` surface, described as "Turn source
  documents into cited candidate knowledge and route them to `learn`/`remember`."
- **`USAGE.md`** — add an `ingest` usage line and a one-line limitation note: "OKH can't see chat
  attachments — give the agent file paths/URLs or paste the content."
- **Tests** — `test/run.test.ts` (or the shared-skills test): assert `resolveSharedSkill("ingest")`
  returns a skill named `ingest`, and that the module-less shared-skill listing includes it
  alongside `grilling`/`okf-writer`. `test/toolMeta.test.ts`/`templates.test.ts` unaffected.

## 5. Verification

- **Unit:** `npm run typecheck` (no src change, still run it) and `npm test` — the new shared-skill
  discovery assertion passes; nothing else regresses.
- **Eval (deferred):** a live ingest scenario needs source-document fixtures and a client with PDF
  extraction; out of scope for this change. Existing eval structure checks
  (`typecheck:eval`/`test:eval`/`eval:validate`) must stay green.

## 6. Risks & mitigations

- **Agent still can't get the files** (client attachment plumbing) → the skill makes this explicit:
  ask for paths/paste content; the limitation is documented in USAGE. OKH cannot fix the client.
- **Extraction quality on tabular/scanned PDFs** → the skill instructs OCR/table extraction and
  requires flagging unreadable sources rather than guessing.
- **Bulk dump into the wrong scope** → the routing plan + delegation to `learn`'s gate + explicit
  scope-conflict surfacing prevent silent over/under-capture.

## 7. Out of scope / deferred

- A per-container `inbox/` staging convention.
- Changes to `learn`/`remember`/`initialize`.
- A live ingest eval scenario.
