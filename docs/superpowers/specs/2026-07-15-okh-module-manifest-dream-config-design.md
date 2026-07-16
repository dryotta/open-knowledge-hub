# Module Manifest Refactor + Dream & Config

**Status:** Approved design
**Date:** 2026-07-15

## 1. Summary

Tighten the module manifest so a module's identity is unambiguous and its
`description` is trustworthy enough to route work, then add a deterministic way to
keep that description accurate as content grows.

Five coupled changes:

1. **Drop `name` from `.okh/module.yaml`.** A module's identity is its folder name.
   The single-segment `path` used at `add_module`-time is that folder name.
2. **Modules are top-level folders only.** Discovery scans a container's direct
   children; a manifest nested deeper is reported as a misplaced-manifest error
   rather than silently loaded or dropped.
3. **`description` is required at creation and flagged when empty.** Reads stay
   tolerant — a module with a blank description still loads — but `validate`/`sync`
   flag it, and `inspect` marks it, so the gap is visible.
4. **A consolidation pass keeps descriptions fresh.** A new `dream` flow tool defines
   the discipline (read the module's `index.md`, draft a routing-quality description,
   persist it) as a pure prompt template with the target modules injected.
5. **`config` becomes a scoped key/value editor.** It views and edits both **global**
   settings (`preferences.json`, currently just `wakePhrase`) and **module** settings
   (the manifest), using `set` as the edit verb for both. Both stores accept arbitrary
   keys for future extension; a module's `description` is the recognized key `dream`
   persists, while `type` stays protected.

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
- A scheduler — `dream` is invoked on demand.

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
  dream to consolidate one)."*
- **Inspection:** `formatInspect` shows each module's `path`, `type`, and
  `description`, and marks a blank description so an agent routing an issue sees the
  gap.
- **Deterministic set:** `service.setModuleDescription(container, module, description)`
  trims and writes the manifest description under the service mutex; blank →
  `INVALID_ARGUMENT`, unknown module → `NOT_FOUND`. It also drops any legacy `name`
  (a normal consequence of rewriting through the schema).

## 6. Dream consolidation flow

- **`dream` flow tool** (`{ container?, module? }`): a cognitive flow built from a **pure
  prompt template** (`resources/prompts/dream.md`), exactly like `add_module`/`ask` — no
  shared skill. It resolves the target modules via `resolveTargets(container, module)`,
  injects them into the template (each module's path, type, container, `index.md` path,
  and current description), and returns the consolidation discipline. Guard: a `module`
  without a `container` fails with a clear message ("dream needs a container when a
  module is given"). With no arguments it targets all modules across registered
  containers.
- **The discipline** (inlined in the template) has five stages: (1) read the target
  module's `index.md`; (2) draft a concise, routing-quality description of what the
  module holds; (3) confirm with the user before any scope-shifting change; (4) persist
  via `config { container, module, set: { description } }`; (5) report what changed.
- **Separation of concerns:** `dream` decides *what* the description should be; `config`
  set-description is the *only* thing that writes it. The tool never edits files itself.
- **Why a template, not a shared skill:** an earlier iteration split this into a `sleep`
  flow tool plus a `dream` shared skill. A shared skill under `resources/shared/skills/`
  is auto-enumerated into the hub map's `globalSkills` and separately runnable via
  `run { skill }`, giving `dream` a duplicate second entrypoint. Folding the discipline
  into a pure prompt template (the pattern every other flow uses) keeps a single
  entrypoint and matches `add_module`.

## 7. Surface changes

- **`add_module`** shape: `{ container, path, type, description, config?, create? }`
  (no `name`). `description` required at `create:true`.
- **`config`** becomes a scoped key/value tool over two stores, chosen by whether
  `container`/`module` are supplied; `set` is the edit verb for both:
  - **Global** (no container/module) — `preferences.json`. `config {}` views all keys;
    `config { set: { k: v } }` edits. The preferences schema is `.passthrough()`: known
    keys (e.g. `wakePhrase`) are validated, unknown keys are accepted for future
    extension. A `null` value deletes a key.
  - **Module** (`{ container, module }`) — the module manifest. `config { container,
    module }` views `type`/`description`/`config` map; `config { container, module,
    set: { k: v } }` edits. `description` maps to the top-level field (validated
    non-blank); `type` is rejected (it selects the loader); every other key is written to
    the manifest's arbitrary `config` map, and `null` deletes a custom key. Backed by
    `service.setModuleConfig`.
- **`dream`** shape: `{ container?, module? }`. Registered as a flow tool and MCP prompt
  like the other flows. Tool count stays 12.
- Tool-meta (`resources/tool-meta/{add_module,config,dream}.md`) and prompt templates
  (`resources/prompts/{add_module,dream}.md`) updated; tool-meta `args:` keys must match
  the tool shapes exactly (enforced by `describeShape`).

## 8. Migration and compatibility

- Existing manifests with `name:` load unchanged — the key is stripped on read and
  disappears the next time the manifest is rewritten (e.g. via a `config` set).
- Existing modules with empty descriptions keep loading but are flagged; `dream`
  gives users a one-step way to fill them.
- Already-nested modules (if any) are reported as misplaced so the user can move them
  to the top level; the tool does not move them automatically.
- `migrate.ts` no longer writes `name`.

## 9. Testing

- **Manifest:** legacy `name` stripped; other unknown keys rejected; missing `type`
  rejected; `description` defaults to `""`.
- **Discovery:** top-level module found; nested manifest reported as misplaced error.
- **Service:** `setModuleDescription`/`setModuleConfig` happy paths (write, drop legacy
  name), blank/`null` description → `INVALID_ARGUMENT`, `type` change rejected, empty
  patch rejected, custom keys stored in the config map and deleted with `null`, unknown
  module → `NOT_FOUND`; `add_module` rejects a multi-segment path; `validate` flags an
  empty description.
- **Preferences:** `.passthrough()` keeps unknown keys while still validating known ones.
- **Tools:** module `config { set: { description } }` sets and is visible via `inspect`;
  a module `set` with a custom key stores it and `null` deletes it; changing `type`
  errors; a blank description errors; global `set` accepts an unknown key and `null`
  deletes it, with known-key validation still applied; `dream` returns the consolidation
  discipline pointing at resolved modules; `dream` with a module but no container errors.
- **Server:** the registered tool set is exactly the 12 tools including `dream`.

## 10. Validation

`npm run typecheck && npm test`.
