# Folder Module + `enter` Tool: An Agent-Ready Space for Unstructured Work

**Status:** Approved
**Date:** 2026-07-22

## 1. Decision

This spec covers two related additions:

1. A built-in module type named `folder` — a space for **unstructured work**.
2. A new top-level tool named `enter` — a **generic** way to declare any module
   as the working folder and load its `AGENTS.md` (when present) and skills into
   the client's context. `enter` is not folder-specific; it works for every
   module type.

### 1a. The `folder` type

- One module is a space for **unstructured work** — freeform files and subfolders
  at the top level, with no OKF/wiki/memory schema imposed.
- It is **agent-ready**: an **optional** `AGENTS.md` at the module root is its
  entry-point instructions (the [agents.md](https://agents.md) open standard —
  a "README for agents"), and the module supports cross-agent **skills**.
- This serves two consumption modes:
  1. An external coding agent (Claude Code, GitHub Copilot) works **directly in
     the folder on disk**, reading its `AGENTS.md` and skills from the standard
     locations those tools already scan.
  2. An MCP client **loads the folder's information into context** via the `enter`
     tool (see §6), which declares the working folder and inlines `AGENTS.md` and
     the skill list. `inspect` and `run` remain available for browsing and running
     individual skills.

### 1b. The `enter` tool

- `enter { container, module }` is read-only and works for **all** module types.
- It returns a working-folder contract (the module's absolute path), inlines the
  module's `AGENTS.md` **if one exists** at the module root, lists the module's
  effective skills, and appends the standard write policy.
- It is a top-level tool (beside `inspect`/`ask`/`context`/`dream`) rather than a
  vendored skill, because a skill would have to be duplicated into every type;
  a generic tool covers custom types too.

```mermaid
flowchart LR
    M["folder module<br/>AGENTS.md? + skills"] --> H["OKH MCP server"]
    H --> E["enter<br/>working folder<br/>+ AGENTS.md (if any)<br/>+ skills"]
    H --> R["run(&lt;skill&gt;)<br/>skill body"]
    H --> N["run(initialize)<br/>author AGENTS.md"]
    N --> M
    E --> C["MCP client<br/>works in the folder"]
    M -->|on disk| X["Claude Code / Copilot<br/>working in the folder"]
```

`folder` is distinct from the existing `agents` module type and the two coexist:

| | `folder` type | `agents` type |
| --- | --- | --- |
| Purpose | Unstructured work space + instructions | Catalog of reusable agent personas |
| Root file | `AGENTS.md` (optional instructions) | — |
| Agent files | — | `.github/agents/*.agent.md` (personas) |
| Skills | `.agents/skills`, `.claude/skills`, `.github/skills` | `.okh/skills`, `.claude/skills` |

## 2. Module format

```text
my-folder/
  .okh/
    module.yaml            # type: folder
  AGENTS.md                # OPTIONAL — entry-point instructions (loaded by `enter`)
  .agents/
    skills/
      <name>/SKILL.md      # canonical skill location (scaffolded, wins collisions)
  .claude/
    skills/ …              # also discovered (Claude Code convention)
  .github/
    skills/ …              # also discovered (GitHub Copilot convention)
  <any unstructured work files and subfolders>
```

- The module's identity is its folder name, per the module system. `.okh/module.yaml`
  carries `type: folder` and the one-line routing `description`.
- Work product lives at the top level. Skills live in the conventional hidden
  roots so the top level stays clean and portable across agents.

## 3. Loader

A new `folderLoader` in `src/modules/loaders/folder.ts` implementing the `Loader`
interface:

- **`overview(moduleRoot)`** — returns `AGENTS.md` verbatim when present. This is
  what `inspect { container, module }`, `ask`, and `context` surface. If `AGENTS.md`
  is missing, return a short placeholder that points to the `initialize` skill
  (mirroring `workspaceLoader.overview`). `AGENTS.md` is optional, so its absence is
  **not** a validation error.
- **`enumerate(moduleRoot)`** — lists **top-level entries only** (immediate files
  and immediate subdirectories), keeping `inspect` readable for large folders.
  Excludes `AGENTS.md` and the reserved/hidden roots (`.okh`, `.agents`, `.claude`,
  `.github`) plus common noise (`node_modules`, `__pycache__`, `vendor`, `venv`).
  Each entry is an `Item` with `type: "file"` or `type: "folder"`. Skills are
  surfaced by the skill system, not as items.
- **`requiredFiles`** — none. A folder module is structurally valid with only its
  `.okh/module.yaml`; `AGENTS.md` is optional.
- **`validate(moduleRoot)`** — surfaces skill-tree issues discovered across the
  folder's configured skill roots (via the existing skill-scan machinery), so a
  malformed `SKILL.md` is reported through the normal validation path.
- **`scaffold(moduleRoot)`** — writes a starter `AGENTS.md` from
  `resources/module-types/folder/AGENTS-skeleton.md` (using the `wx` create flag,
  like `knowledgeLoader`) and creates an empty `.agents/skills/` directory.

Registered in `src/modules/registry.ts` under the `folder` key.

## 4. Skill discovery

Folder modules discover skills from the cross-agent standard roots — not OKH's
native `.okh/skills`. Add a `folder` case to `skillRootsForType()` in
`src/modules/skills.ts`:

```ts
export function skillRootsForType(moduleType: string): readonly string[] {
  if (moduleType === "skills") return [...MODULE_SKILL_ROOTS, MODULE_ROOT_SKILL_ROOT];
  if (moduleType === "folder") return FOLDER_SKILL_ROOTS; // [".agents/skills", ".claude/skills", ".github/skills"]
  return MODULE_SKILL_ROOTS;
}
```

- Precedence follows root order: `.agents/skills` (canonical default) wins over
  `.claude/skills`, which wins over `.github/skills`, on a name collision — the
  same "earlier root shadows later root" semantics used today.
- The vendored `initialize` skill merges in through the existing `vendoredSkills`
  path (built-in types resolve `resources/module-types/<type>/skills/`). A
  same-named local skill overrides the vendored one, per `mergeSkills`.
- Anything in the code that assumes module skill roots are exactly
  `MODULE_SKILL_ROOTS` must route through `skillRootsForType(type)` so folder's
  roots are honored end-to-end (discovery, `run` resolution, and validation).

## 5. Vendored `initialize` skill

`resources/module-types/folder/skills/initialize/SKILL.md` guides the client agent
to author or improve **this folder's** `AGENTS.md`. It references a new best-practices
resource doc via frontmatter, exactly as `agents/create` references
`okh://docs/agent-templates.md`:

```yaml
---
name: initialize
description: Author or improve this folder module's AGENTS.md so agents can work in it effectively.
resources:
  - okh://docs/agents-md.md
---
```

The skill instructs the agent to:

1. Inspect the module (`inspect { container, module }`) and read any existing
   `AGENTS.md` and files to learn the folder's actual purpose and conventions.
2. Write a concise, high-signal `AGENTS.md` grounded in the researched best
   practices, covering the six core areas where they apply to this folder:
   **commands, testing, project structure, code style, git workflow, and
   boundaries** — plus a clear statement of the folder's purpose/scope and a
   pointer to its own skills.
3. Prefer executable commands early, real examples over prose, and explicit
   "never touch" boundaries; never invent commands, paths, versions, or tools —
   discover them from the folder.
4. Persist only `AGENTS.md` (and skill files if authoring skills), re-inspect to
   confirm the module validates, and sync the container.

### Best-practices resource: `resources/docs/agents-md.md`

A new canonical doc (exposed at `okh://docs/agents-md.md`) capturing the AGENTS.md
best practices distilled from the [agents.md](https://agents.md) standard and
GitHub's analysis of 2,500+ real files:

- AGENTS.md is a "README for agents" — freeform Markdown, machine-focused, distinct
  from a human `README.md`.
- Six core areas: commands, testing, project structure, code style, git workflow,
  boundaries.
- Put executable commands (with flags) early; show one real code example over
  paragraphs; be specific about stack/versions; set explicit boundaries
  ("never commit secrets" is the most common helpful constraint).
- Keep it scoped and concise; iterate as agents make mistakes.
- Note the nesting rule: the nearest `AGENTS.md` to an edited file takes precedence
  (relevant when a folder module nests deeper structure).

## 6. The `enter` tool

`enter` is a new top-level, read-only tool that declares a module as the working
folder and loads its context. It is **generic across all module types**, not
folder-specific.

**Signature:** `enter { container, module }` — both required. Module names are not
unique across containers, so both are needed (same rule as `run` and `dream`).

**How it loads context** follows the established OKH pattern: `use_agent` reads an
agent profile and **inlines its content** into the tool result, and `run` inlines
the resolved `SKILL.md` body. `enter` likewise **reads and inlines** the module's
`AGENTS.md`. It does not use the `okh://` resource-embed machinery (reserved for
auxiliary shared docs and bundled sibling files).

**Result**, assembled by a new `buildEnter()` renderer and `resources/prompts/enter.md`:

1. **Working folder** — the module's absolute path (`ResolvedModule.absPath`),
   declared as the working directory: "Treat this as your working directory; create
   and modify files only within it unless the user directs otherwise."
2. **AGENTS.md** — reads `<moduleRoot>/AGENTS.md` and **inlines it when present**.
   When absent, states that none is present (and, for a `folder` module, suggests
   `run(initialize)` to author one). Reading uses the same path-safety guards used
   elsewhere (`lstat`/`realpath`/`isPathWithin`, no symlinks) and a size cap
   consistent with agent profiles (256 KiB).
3. **Skills** — lists the module's effective skills (`name — description`) via
   `service.effectiveSkills(container, module)`, instructing the client to `run`
   any skill for its full body. This reuses the same skill set `inspect` shows.
4. **Write policy** — appends the existing `partials/write-policy.md` (call `sync`
   after changes), exactly as `run` does.

**Honest framing** (mirrors `use_agent`): OKH *advises* the working folder and
*loads* context; the executing MCP client owns the working directory and does the
work. The result must not claim the Hub enforces the cwd or isolates writes.

**Why a top-level tool, not a skill.** To work for every module type — including
custom types that have no vendored skills — `enter` must be generic. A skill would
have to be duplicated into each type; a top-level tool sits cleanly beside the other
read-only assembly tools (`inspect`, `ask`, `context`, `dream`).

**Reused internals:** `service.resolveTargets(container, module)` (module `absPath`
+ container root) and `service.effectiveSkills(container, module)` (merged skill
set). Only the `AGENTS.md` reader and the prompt renderer are new.

## 7. Wiring and documentation

Adding the type and the tool touches these surfaces (following the
`llmwiki`/`workspace` and `use_agent` precedents):

Folder type:

- `src/modules/types.ts` — add `"folder"` to `BUILTIN_MODULE_TYPES`.
- `src/modules/registry.ts` — register `folderLoader`.
- `src/modules/skills.ts` — add the `folder` skill-roots case and `FOLDER_SKILL_ROOTS`.
- Resources:
  - `resources/module-types/folder/AGENTS-skeleton.md` (starter AGENTS.md)
  - `resources/module-types/folder/skills/initialize/SKILL.md`
  - `resources/docs/agents-md.md` (best-practices catalog, `okh://docs/agents-md.md`)

`enter` tool:

- `src/server/tools.ts` — register the `enter` tool (`readOnlyHint: true`).
- `resources/tool-meta/enter.md` — tool description and arg docs.
- `src/prompts/index.ts` + `resources/prompts/enter.md` — `buildEnter()` and its
  template (registered in `src/prompts/templates.ts` if templates are enumerated there).
- A small path-safe `AGENTS.md` reader (new helper, reusing `pathSafety`).

Docs/tool surfaces that enumerate built-in types or the routing gates:

- `resources/docs/concepts.md` (Module types list; add routing line: "To start
  working in a module, call `enter { container, module }`.")
- `resources/docs/reference.md`
- `resources/tool-meta/add_module.md` (the `type` arg examples)
- `resources/prompts/onboard.md`
- `src/server/tools.ts` (built-in-type enumerations in tool descriptions)
- The `okh://docs/agents-md.md` resource must be registered wherever `okh://docs/*`
  resources are declared/served (alongside `agent-templates.md`).

## 8. Tests

Folder loader/type (mirror existing loader tests):

- `test/loaders.test.ts` (or a new `test/folder.test.ts`) — `enumerate` lists only
  top-level entries and excludes reserved dirs and `AGENTS.md`; `overview` returns
  `AGENTS.md` when present and the placeholder when absent; `scaffold` writes the
  skeleton and `.agents/skills/`; the module is **valid without** `AGENTS.md`;
  `validate` reports malformed skill trees.
- Skill-roots coverage — a skill in `.agents/skills` is discovered and runnable;
  `.claude/skills` and `.github/skills` are discovered; `.agents/skills` shadows a
  same-named skill in a later root; the vendored `initialize` is present and
  overridable.
- `run(initialize)` returns the skill body with the `okh://docs/agents-md.md`
  dependency.

`enter` tool:

- Returns the working-folder path for a module and appends the write policy.
- Inlines `AGENTS.md` when present; omits it gracefully (with the initialize hint
  for folder modules) when absent.
- Lists the module's effective skills.
- Path-safety: a symlinked or escaping `AGENTS.md` is rejected, not read.
- Works across types — exercised on a `folder`, a `knowledge`, and a custom module
  (AGENTS.md loaded when the file exists regardless of type).

## 9. Non-goals (YAGNI)

- **No bare visible `skills/` directory.** Skills live only in the hidden
  cross-agent roots so the top level stays reserved for actual work.
- **No `.okh/skills` root for folder.** Folder is deliberately aligned with the
  cross-agent standard so the same files work when Claude Code or Copilot run in
  the folder directly.
- **No `module-context` opt-in flag.** `enter` always builds the module context;
  there is no per-skill toggle.
- **No cwd enforcement.** `enter` advises the working folder; the MCP client owns
  and enforces the actual working directory.
- **No agent persona management.** That remains the `agents` module type's job.
