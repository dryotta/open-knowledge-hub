# OKH v2 — Module System Redesign (self-contained modules + type skills)

**Status:** Approved design (pre-implementation)
**Date:** 2026-07-07
**Relates to:** `2026-07-02-okh-v2-design.md` (evolves the module/manifest/flow model)

---

## 1. Summary

This redesign makes **modules self-contained and portable**, replaces the
per-container module list with **auto-discovery**, and moves most hub-wide verbs
into **per-type skills** invoked through a single generic runner. It also adds a
**custom module type** so users can drop in a folder plus their own skills, and
lays the groundwork to add new built-in types (e.g. `llmwiki`) later with no
architectural change.

Core principles are unchanged from OKH v2: **no server-side LLM**, **deterministic
tools + vendored discipline text**, **discovery over interpretation**, **the
client agent does all reasoning and never runs arbitrary scripts**.

### Goals

1. Each module folder carries its own manifest and is self-contained, so a
   container full of existing modules loads directly when added, and a module
   keeps its metadata when moved.
2. A module has a `name` and `description` so the hub can identify which module to
   work on; `inspect` surfaces them.
3. Support adding a `llmwiki` module type (Karpathy "LLM Wiki" pattern) later —
   **design only, not implemented now**.
4. Each module type has a set of skills (ordered) to add/modify content and to run
   maintenance / health checks.
5. Move hub-wide verbs into module-type skills (e.g. `remember` → a `memory`
   skill; `learn` → a `knowledge` skill, later also `llmwiki`).

Additional capability agreed during design:

6. A **custom module type** whose skills are provided by the module itself, with
   discovery of common skill-folder conventions (`.claude/skills/`, …).

## 2. What changes at a glance

| Area | v2 (today) | This redesign |
|------|------------|---------------|
| Container manifest | `.okh/okh.yaml` lists modules + holds `name`/`sync` | **Removed.** Container = folder of self-describing modules |
| Module metadata | only in the container manifest (`path`,`type`,`config`) | **`<module>/.okh/module.yaml`** (`type`,`name`,`description`,`config`) |
| Module discovery | read from container manifest | **Auto-discovered** by scanning for `.okh/module.yaml` |
| Container settings | in `.okh/okh.yaml` | in per-machine `registry.json` (`sync`, `name`), set at `add`-time |
| `learn`/`remember`/`reflect` | dedicated flow tools | **vendored type skills**, invoked via `run` |
| `ask`/`context`/`onboard` | flow tools | **kept** (hub-wide) |
| Skill types | built-ins only | built-ins **+ custom type** with module-provided skills |

## 3. Container model

- A container is a folder with a `git`, `local`, or `onedrive` backend. **There is
  no container manifest.**
- Container-level settings live in the per-machine `registry.json` entry, set at
  `add`-time:

```jsonc
{
  "name": "my-hub",
  "backend": "git",                 // "git" | "local" | "onedrive"
  "origin": "https://github.com/me/my-hub.git",  // git only
  "localPath": "/home/me/.open-knowledge-hub/containers/my-hub",
  "sync": "auto",                   // "auto" | "pr"  (git write model)
  "addedAt": "2026-07-07T00:00:00Z"
}
```

- **Discovery rule:** a folder is a module **iff** it contains `.okh/module.yaml`.
  On any read, the hub scans the container (recursively, skipping `.git`; it does
  not descend below a discovered module) and builds the module list from the
  manifests it finds. Nesting is allowed but a module is not scanned for
  sub-modules.

## 4. Per-module manifest — `<module>/.okh/module.yaml`

```yaml
type: knowledge          # built-in type name, or "custom"
name: Engineering KB     # identity used by the hub to pick the right module
description: Team engineering knowledge, ADRs, runbooks.
config: {}               # optional, type-specific loader settings
```

Rules:
- `type`, `name`, `description` required; `config` optional.
- `type` is a string. If it matches a built-in type it uses that type's loader +
  vendored skills; **any unrecognized value is treated as `custom`** (§5).
- `.okh/` remains reserved per-module OKH state (manifest today; room for a
  per-module cache/index later). Loaders already skip `.okh` during enumeration.

## 5. Types, loaders, and skills

### 5.1 Built-in types and the custom type

- **Built-in types** each ship a deterministic **loader** (`enumerate`,
  `overview`) and a **vendored skill set**: `knowledge`, `skills`, `tools`,
  `memory`, `project`.
- **`custom`** (or any unrecognized `type`): uses the generic **file-listing
  loader** (the same minimal loader `memory`/`project` use today). It has **no
  vendored skills** — all of its intelligence comes from module-provided skills
  (§5.3). The hub never runs custom code; a custom module is deterministically
  enumerated and its skills are discipline text.
- A small **type registry** maps `type → { loader, vendoredSkillsDir? }`. Adding a
  new built-in type later (e.g. `llmwiki`) is **one registry entry + a vendored
  skill folder** — no other code changes (§9).

### 5.2 Skill format — standard `SKILL.md` only

Every skill, vendored or module-local, is a `<name>/SKILL.md` folder using the
**industry-standard SKILL.md frontmatter only** (`name`, `description`, plus any
fields the SKILL.md standard itself defines). **OKH introduces no custom
frontmatter fields** (no `kind`, no `order`). The body is the discipline text.

- **Ordering** (goal 4's "run in order") comes from folder name, alphabetical.
  Vendored skills that must run in sequence use a numeric prefix (`01-…`, `02-…`)
  — a filesystem naming convention, not a schema change.
- There is **no `kind` concept.** "Maintenance"/"health-check" skills are ordinary
  skills whose `name`/`description` say so; the runnable set is a flat list.

### 5.3 Effective skill set (resolution + merge)

A module's **effective skill set** = merge of:

1. **Vendored type skills** — shipped in the package for the module's built-in
   type, e.g. `resources/types/<type>/skills/<name>/SKILL.md`. Initial mapping:
   - `knowledge` → `learn` (later `ask` variants if needed)
   - `memory` → `remember`, `reflect`
   - `skills` / `tools` / `project` → maintenance/health skills as authored
2. **Module-local skills** — discovered inside the module folder from a set of
   **known skill-root conventions**: `.okh/skills/` (native) and common external
   ones such as `.claude/skills/`. The list is small and extensible. Each is a
   `<name>/SKILL.md` folder.

Merge rules:
- A module-local skill **overrides** a vendored skill of the same `name`
  (customization).
- Skill roots are scanned in a defined order; within a root, ordering is by folder
  name. External skills interoperate as-is (standard `name`/`description`).

## 6. Tool surface

**Hub-wide verb tools (kept, dedicated):** `ask`, `context`, `onboard`.
**Operational tools (kept):** `inspect`, `add`, `sync`, `config`.
**Removed as dedicated tools:** `learn`, `remember`, `reflect` — now vendored type
skills invoked through the runner.

### 6.1 Generic runner — `run { container, module, skill, input? }`

- Resolves the target module, computes its effective skill set (§5.3), finds
  `skill` by name, and returns that skill's **discipline text** with resolved
  filesystem paths and `input` injected, followed by the existing `## Write
  policy` for write skills.
- `input` is a single freeform string interpreted by the skill's discipline
  (uniform with how current verbs inject one string).
- Unknown `skill` → a clean tool error listing the module's available skills.
- Like all flows it returns **instructions only**; the client agent reads, reasons,
  writes, and then calls `sync`.

### 6.2 `inspect` enrichment (goal 2)

- **container view:** each module shows `type · name — description (N items)`.
- **module view:** `name`, `description`, `type`, item list, **and the effective
  skill set** as `name — description`, so the agent knows what it can `run`.

## 7. Deterministic validation & no-execution

- `sync` validation is extended (structural only): every discovered
  `.okh/module.yaml` parses; `type` is a built-in or `custom`; declared/discovered
  skill folders contain a readable `SKILL.md`. No content interpretation, no script
  execution.
- Maintenance/health-check **skills** are **agent-run discipline**; the hub's only
  deterministic checking is the structural validation above.

## 8. Migration from the container manifest

OKH is pre-release, but we auto-migrate to avoid breaking existing local
containers:

- On load, if a legacy `.okh/okh.yaml` is present: for each listed module write a
  `<module>/.okh/module.yaml` (`type` and `config` carried over; `name` defaulted
  to the folder basename, `description` empty), copy `sync` into the registry
  entry, then delete `.okh/okh.yaml`. Idempotent; runs once.
- Existing v1 knowledge-pack repos still map cleanly: one `knowledge` module with a
  scaffolded `.okh/module.yaml`.

## 9. Extensibility: adding `llmwiki` later (design only)

No architectural change required — the future work is purely additive:

1. Add `llmwiki` to the type registry with a loader (index + one file per topic,
   `[[wiki-links]]`, dated append sections) and a `vendoredSkillsDir`.
2. Author `resources/types/llmwiki/skills/{learn,ask,maintain,healthcheck}/SKILL.md`.
3. Modules opt in via `type: llmwiki` in their manifest.

The custom type already exercises the "type with module-provided skills + generic
loader" path, so `llmwiki` is just a curated built-in instance of the same shape.

## 10. Implementation sketch (codebase)

- `src/registry/schema.ts` — add `sync` to the container entry; drop reliance on
  the container manifest for it.
- **Delete** `src/container/manifest.ts` (container manifest) and its schema use;
  add `src/modules/manifest.ts` (per-module `.okh/module.yaml` parse/validate).
- `src/container/service.ts` — replace manifest-driven module listing with a
  **scan** (`discoverModules(containerRoot)`); add the legacy-manifest migration;
  update `add`/`inspect`/`sync` accordingly. `addModule` scaffolds
  `<module>/.okh/module.yaml` (+ type skeleton via loader `scaffold`).
- `src/modules/types.ts` — `ModuleType` becomes "built-in name | custom"; add a
  `skills` discovery utility.
- `src/modules/registry.ts` — type → `{ loader, vendoredSkillsDir? }`; unknown
  type → file-listing loader.
- `src/modules/skills.ts` (new) — discover + merge skills from vendored dir and
  known module skill-roots (`.okh/skills`, `.claude/skills`, extensible), parsing
  standard `SKILL.md` frontmatter.
- `src/prompts/meta.ts` + `src/prompts/index.ts` — keep `ask`/`context`/`onboard`;
  remove `learn`/`remember`/`reflect` flow entries; add `run` builder that loads a
  resolved skill's `SKILL.md` body as discipline.
- `src/server/tools.ts` — register `run`; remove `learn`/`remember`/`reflect`
  tools; enrich `inspect` output with module name/description + skill set.
- `resources/types/<type>/skills/**/SKILL.md` (new) — vendored skills, migrating
  `resources/discipline/{remember,reflect}.md` and `resources/okf/okf-learn`(+writer/format)
  content into `memory`/`knowledge` skill bodies.

## 11. Testing

- **Unit:** module auto-discovery scan (finds `.okh/module.yaml`, skips `.git`,
  doesn't descend into a found module); per-module manifest parse/validate (valid,
  missing fields, unknown type → custom); skill discovery + merge (vendored ∪
  `.okh/skills` ∪ `.claude/skills`, override-by-name, folder-name ordering);
  custom-type file-listing loader; `run` resolution + unknown-skill error; enriched
  `inspect`; legacy-manifest migration (idempotent).
- **Integration:** add a folder that already has modules and a `.claude/skills`
  dir → `inspect` lists modules + merged skills → `run` returns the right
  discipline → agent writes → `sync` validates/commits; legacy `.okh/okh.yaml`
  container auto-migrates on first load.
- **Build + e2e:** `npm run build`, then the full `npm run eval` harness
  (scenarios updated so `learn`/`remember`/`reflect` route through `run`).

## 12. Non-goals / deferred

- **`llmwiki` implementation** — designed for (§9), not built now.
- **Unified graph / real search / OKH-side execution** — unchanged from
  `2026-07-02-okh-v2-design.md` §9.
- **Concrete `memory`/`project` content formats** — still thin file-listing.

## 13. Open questions (non-blocking)

- Exact default set of external skill-roots beyond `.claude/skills/` (e.g.
  `.cursor/`, `.github/`) — start with `.okh/skills` + `.claude/skills`; make the
  list a constant that is easy to extend.
- Whether `ask`/`context` should eventually consult type skills for
  type-specialized reads — deferred; they remain hub-wide for now.
