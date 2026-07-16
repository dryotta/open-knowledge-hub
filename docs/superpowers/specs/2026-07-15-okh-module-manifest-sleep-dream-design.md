# Module Manifest Refactor + Sleep/Dream Consolidation

**Status:** Approved design
**Date:** 2026-07-15

## 1. Summary

Tighten the module manifest so a module's identity is unambiguous and its
`description` is trustworthy enough to route work, then add a deterministic way to
keep that description accurate as content grows.

Four coupled changes:

1. **Drop `name` from `.okh/module.yaml`.** A module's identity is its folder name.
   The single-segment `path` used at `add_module`-time is that folder name.
2. **Modules are top-level folders only.** Discovery scans a container's direct
   children; a manifest nested deeper is reported as a misplaced-manifest error
   rather than silently loaded or dropped.
3. **`description` is required at creation and flagged when empty.** Reads stay
   tolerant — a module with a blank description still loads — but `validate`/`sync`
   flag it, and `inspect` marks it, so the gap is visible.
4. **A consolidation pass keeps descriptions fresh.** A new `dream` shared skill
   defines the discipline (read the module's `index.md`, draft a routing-quality
   description, persist it); a new `sleep` flow tool surfaces that discipline with the
   target modules injected; and `config` gains a deterministic
   `config { container, module, description }` branch that writes the description the
   skill produces.

## 2. Goals and non-goals

### Goals

1. Make module identity a single source of truth (the folder name) with no
   duplicated, drift-prone `name` field.
2. Make module placement predictable (top-level only) and surface violations instead
   of hiding them.
3. Guarantee every newly created module has a description, and make missing/empty
   descriptions visible for existing modules.
4. Give clients a repeatable "run maintenance" workflow that improves description
   quality from the module's own `index.md`, so `inspect`-based routing stays
   accurate.
5. Keep the deterministic write (`config` set-description) separate from the agent
   discipline (`dream`) that decides what to write.

### Non-goals

- Auto-rewriting descriptions without agent involvement (the model drafts; the tool
  persists).
- Renaming/moving modules, or migrating already-nested modules automatically (they
  are flagged for the user to move).
- Changing any other manifest field or the container registry schema.
- A scheduler — `sleep` is invoked on demand.

## 3. Manifest schema

`.okh/module.yaml` body:

```yaml
type: knowledge          # built-in or any custom string (unchanged)
description: Project notes # required at creation; kept routing-quality
# config: {}             # optional, type-specific (unchanged)
```

- The Zod schema is `z.preprocess(strip legacy "name", strictBody)` where
  `strictBody` = `{ type: string, description: string default "", config?: object }`
  and is `.strict()` so any *other* unknown key is still rejected. Only `name` is
  tolerated-and-stripped for backward compatibility.
- `description` defaults to `""` on read (tolerant); it is required non-blank at
  creation and at `config` set-description time.
- `scaffoldModuleManifest(type, description)` writes only `type`, `description`, and
  optional `config` — never `name`.

## 4. Discovery and placement

- `discoverModules(root)` enumerates only the container's **direct children**. A
  direct child with `.okh/module.yaml` is a module (identity = its folder name).
- `findMisplacedManifests(root)` walks deeper and records any `.okh/module.yaml`
  found below the top level as an error: *"modules must be top-level folders; move it
  to the container root."* These surface through `validate`/`sync` and `inspect`.
- `add_module` enforces a **single-segment** `path` (`modulePathString` rejects any
  path containing a separator), so new modules cannot be created nested.

## 5. Description lifecycle

- **Creation:** `add_module` requires a non-blank `description`; the workflow prompt
  instructs the agent to propose one that says what the module holds.
- **Validation:** `service.validate()` (and therefore `sync`) flags any discovered
  module whose `description` is blank: *"module \"<path>\": missing description (run
  sleep to consolidate one)."*
- **Inspection:** `formatInspect` shows each module's `path`, `type`, and
  `description`, and marks a blank description so an agent routing an issue sees the
  gap.
- **Deterministic set:** `service.setModuleDescription(container, module, description)`
  trims and writes the manifest description under the service mutex; blank →
  `INVALID_ARGUMENT`, unknown module → `NOT_FOUND`. It also drops any legacy `name`
  (a normal consequence of rewriting through the schema).

## 6. Sleep flow + dream skill

- **`dream` shared skill** (`resources/shared/skills/dream/SKILL.md`): module-less
  consolidation discipline. Stages: (1) read the target module's `index.md`; (2) draft
  a concise, routing-quality description of what the module holds; (3) confirm with the
  user before any scope-shifting change; (4) persist via
  `config { container, module, description }`; (5) report what changed. Auto-discovered
  from `resources/shared/skills/` — no registration needed.
- **`sleep` flow tool** (`{ container?, module? }`): resolves the `dream` skill via
  `resolveSharedSkill("dream")` and the target modules via
  `resolveTargets(container, module)`, then returns the discipline text with the
  targets injected (same flow-tool pattern as `run`/`ask`). Guard: a `module` without a
  `container` fails with a clear message ("sleep needs a container when a module is
  given"). With no arguments it targets all modules across registered containers.
- **Separation of concerns:** `sleep`/`dream` decide *what* the description should be;
  `config` set-description is the *only* thing that writes it. The tool never edits
  files itself.

## 7. Surface changes

- **`add_module`** shape: `{ container, path, type, description, config?, create? }`
  (no `name`). `description` required at `create:true`.
- **`config`** shape gains `{ container?, module?, description? }`. Precedence: if any
  of container/module/description is present → set-description branch (all three
  required non-blank; error if `set` is also supplied); else if `set` → preferences;
  else → show config.
- **`sleep`** shape: `{ container?, module? }`. Registered as a flow tool and MCP
  prompt like the other flows. Tool count becomes 12.
- Tool-meta (`resources/tool-meta/{add_module,config,sleep}.md`) and prompt templates
  (`resources/prompts/{add_module,sleep}.md`) updated; tool-meta `args:` keys must
  match the tool shapes exactly (enforced by `describeShape`).

## 8. Migration and compatibility

- Existing manifests with `name:` load unchanged — the key is stripped on read and
  disappears the next time the manifest is rewritten (e.g. via set-description).
- Existing modules with empty descriptions keep loading but are flagged; `sleep`
  gives users a one-step way to fill them.
- Already-nested modules (if any) are reported as misplaced so the user can move them
  to the top level; the tool does not move them automatically.
- `migrate.ts` no longer writes `name`.

## 9. Testing

- **Manifest:** legacy `name` stripped; other unknown keys rejected; missing `type`
  rejected; `description` defaults to `""`.
- **Discovery:** top-level module found; nested manifest reported as misplaced error.
- **Service:** `setModuleDescription` happy path (writes, drops legacy name), blank →
  `INVALID_ARGUMENT`, unknown module → `NOT_FOUND`; `add_module` rejects a
  multi-segment path; `validate` flags an empty description.
- **Tools:** `config { container, module, description }` sets and is visible via
  `inspect`; mixing `set` with set-description errors; blank description errors;
  `sleep` returns the `dream` discipline pointing at resolved modules; `sleep` with a
  module but no container errors.
- **Server:** the registered tool set is exactly the 12 tools including `sleep`.

## 10. Validation

`npm run typecheck && npm test`.
