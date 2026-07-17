# OKH — Ingest source retention (per-module `./sources/<YYYY-MM>/`)

> **Historical note:** Early standalone ingest APIs in this record were superseded by
> common MCP instruction resources and module-scoped skills.

**Status:** Approved design (pre-implementation)
**Date:** 2026-07-09
**Branch:** `feat/ingest-source-retention`
**Relates to:** the `ingest`/`initialize` skills, `index-skeleton.md`, the
`2026-07-09-okh-ingest-skill-design.md` and `…-inspect-ingest-efficiency-design.md` designs.

---

## 1. Summary

Let a knowledge module optionally **keep a copy of the documents it ingests**, in a per-module,
date-bucketed folder (`./sources/<YYYY-MM>/`). The user decides the policy **when initializing the
module**; the `ingest` skill **honors it** on every run. When retention is on, an ingested source
is copied into the module and each derived concept cites that **stable in-module copy** instead of
the ephemeral input path.

This is **pure discipline** — no schema, tool, or `src/` change. The policy lives in the module's
`index.md` scope contract (a `## Sources` section), consistent with how `learn` reads the contract
and how `initialize` already authors it. OKH runs no model and never copies files; the agent does,
following the skill.

### Goals

1. A module can declare a **source-retention policy** (keep copies on/off, folder, bucketing),
   decided during `initialize` and recorded in `index.md`.
2. `ingest` **reads and honors** that policy: when on, it copies each successfully-extracted source
   into `<module>/sources/<YYYY-MM>/` and cites the retained copy.
3. Default is **opt-in / off** — nothing is retained unless the module's policy enables it.
4. The default folder/bucketing (`./sources/`, by-month `<YYYY-MM>/`) is a documented convention the
   user can override in `index.md`.

### Non-goals

- Manifest schema or module-config-tool changes (policy lives in `index.md`, not `.okh/module.yaml`).
- Auto-`.gitignore` for the `sources/` folder (retained copies are committed on `sync`; that is the
  user's explicit choice when enabling retention — noted as a consideration).
- Deduplication, renaming, or content-hashing of retained files (use the original filename;
  overwrite on collision).
- Retaining sources for non-knowledge modules (memory/`remember` is out of scope here).

---

## 2. Policy shape (recorded in `index.md`)

A new `## Sources` section in the module's `index.md`. When retention is **off** (default) the
section may be omitted or state `Retain copies: no`. When **on**:

```markdown
## Sources

- **Retain copies:** yes
- **Folder:** `./sources/`
- **Bucketing:** by month — `<YYYY-MM>/` (the ingest date)
```

- **Retain copies** — `yes` / `no` (default `no`).
- **Folder** — module-relative directory for kept copies (default `./sources/`).
- **Bucketing** — how copies are grouped: default by ingest month (`<YYYY-MM>/`); the user may
  choose flat (no bucket) or another scheme, recorded here in prose.

The section is human-readable and agent-parsed (the same way the scope contract is), not validated
by any tool.

---

## 3. `initialize` skill — record the policy

`resources/module-types/knowledge/skills/initialize/SKILL.md`, Stage 1 (Grill the requirements and
structure). Add **source retention** to what the grilling decides and what gets written to
`index.md`:

- Ask whether ingested source documents should be **kept in the module** (default **no**).
- If yes, confirm the **folder** (default `./sources/`) and **bucketing** (default by-month
  `<YYYY-MM>/`, the ingest date), and write the `## Sources` section shown in §2.
- If no, retention stays off; note it briefly or omit the section.

Keep it one decision in the existing grilling flow — do not add a separate stage.

---

## 4. `ingest` skill — honor the policy

`resources/shared/skills/ingest/SKILL.md`. Insert a new stage between **Extract** and
**Normalize**, and adjust provenance:

### New Stage 3 — Retain sources (if the module's policy says so)

Read the target module's `index.md` `## Sources` policy (via `inspect { container, module }`, whose
overview includes `index.md`, or by reading `index.md` directly). Then:

- If **Retain copies: yes** — for each source you **successfully extracted**, copy the original file
  into `<module>/<folder>/<bucket>/<original-filename>` (default `<module>/sources/<YYYY-MM>/`, the
  ingest date). Create folders as needed; on a name collision, overwrite. Never retain a source you
  could **not** read.
- If **no** (or no `## Sources` section) — retain nothing.

Retained copies are committed on the next `sync` — flag this for large, binary, or sensitive
documents so the user can opt out.

### Provenance (updated Normalize stage)

Each candidate carries a **source citation**:
- retention **on** → cite the **retained in-module path** (`sources/<YYYY-MM>/<file>`) — stable,
  versioned, and synced with the module.
- retention **off** → cite the original file path or URL as today (may be ephemeral).

Renumber the subsequent stages (Route → Stage 4, Report → Stage 5) accordingly, and update the
completion criterion to add: "If the module retains sources, each successfully-ingested source was
copied into the configured folder and its concepts cite the retained copy."

---

## 5. `index-skeleton.md` — seed the policy placeholder

`resources/module-types/knowledge/index-skeleton.md`. Add an optional, commented `## Sources`
section (before `## Concepts`) documenting the fields and the off-by-default, so a freshly created
module shows the option:

```markdown
## Sources

<!-- Optional — document ingestion retention policy. Default: do not keep copies.
To keep a copy of each ingested source in this module, set:
- **Retain copies:** yes
- **Folder:** `./sources/`
- **Bucketing:** by month — `<YYYY-MM>/` (the ingest date)
-->

Retain copies: no
```

---

## 6. Docs

- **README.md** — one line in the knowledge/ingest description: a knowledge module can opt in to
  keeping copies of ingested sources under `./sources/<YYYY-MM>/`.
- **USAGE.md** — extend the ingest entry: "A module can opt in (during `initialize`) to keep a copy
  of each ingested document under `./sources/<YYYY-MM>/`; `ingest` honors that policy."

---

## 7. Eval

Exercise retention end-to-end and verify it deterministically.

- **Fixture:** update `eval/fixtures/health-hub/health/index.md` to include a `## Sources` section
  with **Retain copies: yes**, `./sources/`, by-month bucketing. (The existing scenario already
  ingests `./lab-results.txt` into this module.)
- **New assertion:** `eval/assertions/source-retained.ts` — deterministic. Given
  `config: { module, dir?: "sources", filename?: "lab-results.txt" }`, read the container path from
  metadata and assert a copy of the source exists somewhere under `<containerPath>/<module>/<dir>/`
  (recursively; match the filename). Pass iff found.
- **Scenario:** `eval/scenarios/ingest/into-existing-module.yaml` — add the `source-retained`
  assertion (`config: { module: health, filename: lab-results.txt }`) alongside the existing
  `tools-called`, `okf-valid`, and judge criteria. Add a judge criterion
  `retained-source` ("the agent kept a copy of the ingested file under the module's sources folder,
  per the module's policy").
- **eval-test:** if a new assertion file changes any counted totals, none are asserted by count for
  assertions; only scenario/env counts are (unchanged here). No eval-test edit expected beyond
  confirming `test:eval` still passes.

---

## 8. Verification

- **Unit:** `npm run typecheck` + `npm test` — no `src/` change; suite must stay green (skills still
  parse; frontmatter unchanged).
- **Eval structure:** `npm run typecheck:eval` (new assertion compiles), `npm run test:eval`,
  `npm run eval:validate`.
- **Full e2e eval:** `npm run build && npm run eval` — the ingest scenario now also asserts the
  source was retained under `sources/<YYYY-MM>/` and cited. Confirm 21/21 (or the current scenario
  count) with the retention behavior exercised.

---

## 9. Risks & mitigations

- **Agent doesn't read the policy** → `ingest` Stage 3 explicitly says to read `index.md`'s
  `## Sources`; the eval's deterministic `source-retained` assertion catches a miss.
- **Binary/large/sensitive files committed via sync** → the skill flags this and retention is
  opt-in; the user chooses per module.
- **Path/bucket ambiguity** → the default (`./sources/<YYYY-MM>/`, ingest date, original filename,
  overwrite on collision) is stated precisely in both skills and the skeleton.
- **Ephemeral-citation regression** → when retention is on, concepts cite the retained in-module
  copy (stable), improving provenance over the previous ephemeral-path citation.

## 10. Out of scope / deferred

- A structured manifest/config field + a module-config-update tool.
- Automatic `.gitignore` / LFS handling for `sources/`.
- Retention for memory or other module types.
