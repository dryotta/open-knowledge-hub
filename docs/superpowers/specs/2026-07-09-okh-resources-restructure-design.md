# OKH — `resources/` Restructure (prompts + module-type + shared skills)

> **Partially superseded historical design:** The standalone skill model described
> below was removed. Every runnable skill now belongs to a module; common guidance is
> exposed through `okh://instructions/`.

**Status:** Superseded
**Date:** 2026-07-09
**Relates to:** `2026-07-07-okh-module-system-redesign-design.md` (completes the skill migration it began)

---

## 1. Summary

The module-system redesign migrated `learn`/`remember`/`reflect` into per-type
skills but left four OKF discipline docs orphaned in `resources/okf/` (declared in
the `OkfDoc` union yet never loaded), and split flow discipline across
`resources/okf/` + `resources/discipline/`. This restructure:

- Unifies the tree into three clear roots: `prompts/` (flow bodies), `shared/skills/`
  (runnable-standalone skills), `module-types/` (per-type skills).
- Reclaims the orphaned OKF content: `okf-writer` + `OKF-FORMAT` become a shared
  skill + its resource; `okf-new-from-repo` becomes the knowledge `initialize`
  skill; `okf-ask` becomes `prompts/ask.md`.
- Adds **runnable-standalone shared skills** (`grilling`, `okf-writer`) invoked via
  `run { skill }` with no module, and lets other skills reference them by name.
- Preserves the one genuinely-dead file (`okf-learn.md`, superseded by
  `learn/SKILL.md`) under a repo-root `delete/` folder for reference.

Core principles unchanged: no server-side LLM, deterministic tools + vendored
discipline text, the client agent does all reasoning.

### Goals

1. Every `resources/` file is either loaded at runtime or intentionally archived —
   no silently-dead files or dead type members.
2. One consistent layout keyed by role (prompt vs shared skill vs module-type skill).
3. The OKF authoring rules (`OKF-FORMAT`, `okf-writer`) and repo→pack bootstrap
   (`initialize`) have a real runtime home.
4. Shared disciplines (grilling) are reusable across skills instead of dangling
   client-specific slash-command references.

### Non-goals

- No change to `add`/`sync`/`config`/`inspect` behavior beyond result-text pointers.
- No new built-in module types. `skills`/`tools`/`project` keep zero vendored skills.
- No auto-execution of `initialize` — the agent runs it after `add` creates a module.

---

## 2. Target layout

```
resources/
  prompts/                       # hub-global flow bodies (returned as prompt-tool + MCP prompt)
    ask.md                       # ← okf/okf-ask.md (frontmatter stripped)
    context.md                   # ← discipline/context.md
    onboard.md                   # ← discipline/onboard.md
  shared/skills/                 # runnable-standalone skills; no module required
    grilling/SKILL.md            # NEW (adapted from mattpocock/skills, attributed)
    okf-writer/SKILL.md          # ← okf/okf-writer.md
    okf-writer/OKF-FORMAT.md     # ← okf/OKF-FORMAT.md (resource of the okf-writer skill)
  module-types/                  # per-module-type vendored skills (was resources/types/)
    knowledge/skills/
      learn/SKILL.md             # existing (updated to reference shared skills)
      initialize/SKILL.md        # ← okf/okf-new-from-repo.md (renamed + repurposed)
    memory/skills/
      remember/SKILL.md          # unchanged
      reflect/SKILL.md           # unchanged
delete/                          # repo root; kept for reference, NOT in npm `files`
  resources/okf/okf-learn.md     # dead; superseded by module-types/knowledge/skills/learn
```

### File disposition

| Original | Becomes | Method |
|---|---|---|
| `resources/okf/okf-ask.md` | `resources/prompts/ask.md` | git mv + strip frontmatter |
| `resources/discipline/context.md` | `resources/prompts/context.md` | git mv |
| `resources/discipline/onboard.md` | `resources/prompts/onboard.md` | git mv |
| `resources/okf/okf-writer.md` | `resources/shared/skills/okf-writer/SKILL.md` | git mv + rewrite refs |
| `resources/okf/OKF-FORMAT.md` | `resources/shared/skills/okf-writer/OKF-FORMAT.md` | git mv |
| `resources/okf/okf-new-from-repo.md` | `resources/module-types/knowledge/skills/initialize/SKILL.md` | git mv + rewrite |
| `resources/okf/okf-learn.md` | `delete/resources/okf/okf-learn.md` | git mv (dead) |
| existing `resources/types/**` | `resources/module-types/**` | git mv |

Repurposed files are `git mv`'d so history follows them; only the dead
`okf-learn.md` is archived under `delete/`. `resources/okf/` and
`resources/discipline/` are removed once emptied.

---

## 3. Code changes

### 3.1 Prompt loader (`src/prompts/discipline.ts` → `src/prompts/prompts.ts`)

- Replace `OKF_ROOT` + `DISCIPLINE_ROOT` with one `PROMPTS_ROOT = resources/prompts/`.
- Replace `OkfDoc` / `DisciplineDoc` / `loadOkf` / `loadDiscipline` / `combineOkf`
  with `PromptDoc = "ask" | "context" | "onboard"` and `loadPrompt(doc)`.
- `src/prompts/index.ts`: `buildAsk` / `buildContext` / `buildOnboard` each wrap
  `loadPrompt(name)` in `<discipline name="{name}">`. `ask` now uses the same
  wrapper as the others (drops the `combineOkf`-specific wrapping).

### 3.2 Shared skills (`src/modules/shared.ts`, new)

- `SHARED_ROOT = resources/shared/skills/`.
- `sharedSkills(): Promise<Skill[]>` and `resolveSharedSkill(name): Promise<Skill>`
  reuse `discoverVendoredSkills` / `readSkill` from `src/modules/skills.ts`.
- `Skill` gains optional `dir` (absolute skill-folder path). `readSkill` populates
  it. A run surfaces sibling resource files (any non-`SKILL.md` file in `dir`, e.g.
  `OKF-FORMAT.md`) by **absolute path** so the agent can open them on demand.

### 3.3 `module-types` root (`src/modules/vendored.ts`)

- `TYPES_ROOT` → `MODULE_TYPES_ROOT = resources/module-types/`. Comment updated.
  No signature changes; `isBuiltinType` gating unchanged.

### 3.4 `run` tool (`src/prompts/meta.ts`, `src/server/tools.ts`, `src/prompts/index.ts`)

- `flowArgShapes.run`: `container` and `module` become **optional**. Resolution rule:
  - both present → module skill (`resolveSkill(container, module, skill)`), current path;
  - both absent → shared skill (`resolveSharedSkill(skill)`);
  - exactly one present → validation error ("provide both container and module, or neither").
- New `service.resolveSharedSkill(name)`; NOT_FOUND lists available shared skills.
- New `buildSharedRun(skill, input)` in `prompts/index.ts`: renders skill
  name/description/body + a "Skill resources (open as needed): `<abspath>`" list
  when the skill has sibling resource files. It does **not** emit the container
  write-policy block (module-less); okf-writer's own body carries its write/where-it-goes
  guidance. `buildRun` (module path) is unchanged.
- `run` handler branches on the presence of container+module.

### 3.5 Result-text pointers

- After `add` creates a **knowledge** module, the add result text names the
  follow-up: `run { container, module, skill: "initialize" }`.
- `onboard.md` Stage 2 mentions `initialize` as the next step after adding a
  knowledge module.

---

## 4. Content rewrites

### 4.1 `shared/skills/grilling/SKILL.md` (new)

Adapted from `github.com/mattpocock/skills` `productivity/grilling` (attributed in a
trailing note). Frontmatter `name: grilling`, one-line description. Body: interview
relentlessly one question at a time, look up facts in the codebase, put decisions to
the user, don't act until shared understanding is confirmed.

### 4.2 `shared/skills/okf-writer/SKILL.md`

Body preserved; the `[OKF-FORMAT.md](OKF-FORMAT.md)` links stay valid (co-located
resource, surfaced by absolute path at run time). Neutralize the dangling
`domain-modeling`-skill reference (no such skill in OKH) to plain guidance.

### 4.3 `module-types/knowledge/skills/initialize/SKILL.md`

Reframed from "survey an existing repo" to **"initialize a newly-created knowledge
module."** Replace client-specific slash refs:
- `/grilling` → run the shared `grilling` skill (`run { skill: "grilling" }`).
- `/okf-writer` → run the shared `okf-writer` skill (`run { skill: "okf-writer" }`).
- `/explore-repo` → plain-language "explore the repository" guidance (no such shared skill).
Keeps the scope-contract → explore → gap-grill → write → reader-test stages.

### 4.4 `module-types/knowledge/skills/learn/SKILL.md`

- Stage 2 borderline path → "run the shared `grilling` skill" for scope negotiation.
- Stage 4 → reference the shared `okf-writer` skill for authoring.

---

## 5. Comment / doc fixes

- Header comments in the moved loaders (`resources/...` path notes, `resources/okf`
  wording) updated to the new roots.
- `src/prompts/meta.ts` module comment: note `run` also resolves module-less shared skills.
- Remove now-false `OkfDoc` references anywhere.
- User-facing docs (`README.md`, `USAGE.md`, `CONTEXT.md`) that describe the
  `resources/okf/` + `resources/discipline/` layout or the flow/skill surface are
  updated to the new `prompts/` + `shared/skills/` + `module-types/` structure and
  the module-less shared-skill run.

---

## 6. Tests & eval

**Unit (`npm test`, `npm run typecheck`):**
- Update `test/prompts.test.ts`: `loadOkf`/`combineOkf`/`<discipline name="okf-ask">`
  → `loadPrompt`/`<discipline name="ask">`.
- New: shared-skill resolution + `sharedSkills`; `run` with no module renders the
  shared skill; `run` with exactly one of container/module errors; `initialize`
  present in `knowledge` effective skills; `okf-writer` run surfaces the
  `OKF-FORMAT.md` absolute path.

**Eval (`npm run typecheck:eval`, `npm run test:eval`, `npm run eval:validate`):**
- Reword eval mentions of the "okf-learn gate" → "learn gate" (behavioral asserts
  unchanged — the gate now lives in `learn/SKILL.md`).
- Add scenario(s): a module-less shared-skill run (`grilling`), and `initialize` as
  the post-add step for a new knowledge module.

**Full e2e (`npm run build` then `npm run eval`):** run as part of completion
criteria (larger change; the harness launches the built `dist/index.js`).

---

## 7. Risks & mitigations

- **Broken loader paths after moves** → the `../../resources/...` `import.meta.url`
  resolution is unchanged in shape; only leaf folder names change. Covered by unit
  tests that load each prompt/skill.
- **`run` schema now permits partial args** → explicit "both or neither" validation
  with a clear error prevents ambiguous calls.
- **Agent can't open a skill's resource file** → run output surfaces sibling
  resources by absolute path (the MCP server and agent share a filesystem).
- **`delete/` shipped to npm** → excluded automatically; package `files` allowlists
  only `dist` + `resources`.

---

## 8. Out of scope / deferred

- Listing shared skills via `inspect` (discoverable through referencing skills'
  bodies + `run` NOT_FOUND listing for now).
- A shared `explore-repo` skill.
- Vendored skills for `skills`/`tools`/`project` types.
