# OKH — Split `add` into `add_container` + `add_module`

**Status:** Approved design (pre-implementation)
**Date:** 2026-07-09
**Branch:** `feat/resources-restructure`
**Relates to:** `2026-07-09-okh-tool-metadata-resources-design.md`

---

## 1. Summary

Replace the single overloaded `add` MCP tool (which branches on `source` vs.
`container/path/type` args) with two focused tools: **`add_container`** and
**`add_module`**. Each has a precise, tightened schema (required args are required),
so the "either source or module fields, not both" ambiguity — and its validation —
disappears. The MCP surface goes from 8 tools to 9.

Only the **tool layer** changes. The service methods `addContainer`/`addModule`
(and their tests) are untouched.

### Goals

1. Two single-purpose tools with clear, non-overlapping argument schemas.
2. Required args (`add_container.source`; `add_module.container/path/type/name`) are
   required in the Zod schema, so the agent sees an accurate contract.
3. No overloaded-tool ambiguity; delete the mutual-exclusion validation.
4. Metadata stays in `resources/tool-meta/` (per the tool-metadata design), text
   ported from the current `add.md`.

### Non-goals

- No change to `service.addContainer`/`addModule`, their outcomes, or their tests.
- No back-compat `add` alias — clean replacement (pre-1.0).
- No change to other tools.

---

## 2. Schemas — `src/server/toolSchemas.ts`

Remove the `add` entry; add:

```ts
add_container: {
  source: z.string(),
  name: z.string().optional(),
  sync: z.enum(["auto", "pr"]).optional(),
  backend: z.enum(["local", "onedrive"]).optional(),
  create: z.boolean().optional(),
},
add_module: {
  container: z.string(),
  path: z.string(),
  type: z.string().min(1),
  name: z.string(),
  description: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  create: z.boolean().optional(),
},
```

`ToolName = keyof typeof toolShapes` now includes `"add_container" | "add_module"`
and no longer includes `"add"`.

---

## 3. Metadata — `resources/tool-meta/`

Delete `add.md`; create two files (text ported from the current `add.md`).

`add_container.md`:
```markdown
---
title: Add a container
args:
  source: Git URL or local/OneDrive path for the new container.
  name: Container name (defaults to the source basename).
  sync: Git write mode for the container.
  backend: Label a path source as local or onedrive.
  create: Apply the change. Omit to preview a plan (no changes).
---
Register a container from { source, name?, sync?, backend? } — source is a git URL or a local/OneDrive path. By default this returns a plan and makes no changes; show it to the user, get confirmation, then re-call with create:true.
```

`add_module.md`:
```markdown
---
title: Add a module
args:
  container: Target container.
  path: Module folder path within the container.
  type: "Module type: a built-in (knowledge, skills, tools, memory, project) or a custom type name."
  name: Module display name.
  description: One-line module description.
  config: Optional module config.
  create: Apply the change. Omit to preview a plan (no changes).
---
Add a typed module to a container with { container, path, type, name }. By default this returns a plan and makes no changes; show it to the user, get confirmation, then re-call with create:true.
```

The all-tools consistency test in `test/toolMeta.test.ts` automatically validates
that each file's `args` keys exactly match its `toolShapes` entry.

---

## 4. Registration + handlers — `src/server/tools.ts`

Replace the single `add` `registerTool` (and its combined handler) with two, using
the existing `toolReg` helper and keeping `annotations: { openWorldHint: true }`:

- **`add_container`** handler: `isBlank(source)` guard, then `service.addContainer({ source, name?, sync?, backend?, create? })`; return the plan (`formatContainerPlan`, `needsConfirmation`) or the `Registered container "…"` applied message. (Same as the current source branch.)
- **`add_module`** handler: `isBlank` guards for `container`/`path`/`name`, then `service.addModule({ container, path, type, name, description?, config?, create? })`; return the plan (`formatModulePlan`) or the `Added … module …` applied message **including the knowledge→`initialize` follow-up pointer**. (Same as the current module branch.)

The `add requires either { source } or …, not both.` mutual-exclusion check and the
combined arg-type block are deleted (each tool's schema is disjoint). `formatContainerPlan`/`formatModulePlan` are unchanged.

---

## 5. Ripple updates

- **`test/server.test.ts`:**
  - Tool-list assertion → 9 names: `["add_container","add_module","ask","config","context","inspect","onboard","run","sync"]`.
  - Every `callTool({ name: "add", … })`: container-adds → `add_container`; module-adds → `add_module` (lines ~87–91, 171–172, 186/190, 199–203, 274–275, 295–296).
  - **Remove** the two mutual-exclusion tests ("rejects add requests that mix container and module modes" and "…mix source with empty module fields") — impossible by construction now.
  - The empty-field test splits: `add_container { source: "" }` → "source cannot be empty"; `add_module { container: "hub", path: "", type, name }` → "path cannot be empty".
  - The "titles/descriptions load from resources" assertion targets `add_container` (its description contains "returns a plan and makes no changes"; `not.toContain("{{")` unchanged, on `config`).
- **`resources/prompts/onboard.md`:** the "Call `add`… re-call with create:true… offer to add a `knowledge` module" passage → `add_container` for the container and `add_module` for modules.
- **`resources/prompts/instructions.md`:** "use inspect/add/sync to manage containers" → "inspect/add_container/add_module/sync".
- **Docs:** `README.md` (the `add` tool-table row → two rows; the two `add {…}` examples → `add_container {…}` / `add_module {…}`; the operational-tools list), `USAGE.md` (operational-tools list + the "Add a module" example), `CONTEXT.md` (operational-tools bullet; the `add`-time phrasing can stay generic or read "add_container-time").
- **Eval scenarios** (all container-adds → `add_container`):
  - `onboard/existing-folder.yaml`: `expect: [add]` → `[add_container]`.
  - `onboard/github-repo.yaml`: `expect: [add, inspect]` → `[add_container, inspect]`.
  - `onboard/new-hub.yaml`: `expect: [add]` → `[add_container]`; `check: { kind: tool, name: add }` → `name: add_container`.
  - `onboard/cold-start-conversation.yaml`: `expect: [onboard, config, add]` → `[onboard, config, add_container]`.
  - Eval **unit** tests (`eval-test/*`) use `"add"` as a generic mock tool name to exercise assertion mechanics — **left unchanged**.

---

## 6. Tests & verification

- **Unit (`npm test`, `npm run typecheck`):** `server.test.ts` updates above; the
  `toolMeta.test.ts` consistency loop covers the two new resources; `service.test.ts`
  and `add-confirm.test.ts` are unchanged (service layer untouched).
- **Eval (`typecheck:eval`, `test:eval`, `eval:validate`):** the four scenario edits;
  validate config still parses.
- **Full e2e eval (`npm run build && npm run eval`):** required — this changes the
  tool surface and the onboard scenarios exercise container/module creation. Confirm
  the agent routes to `add_container`/`add_module` and the onboard flow still passes.

---

## 7. Risks & mitigations

- **Agent routing to the new tool names** → descriptions ported verbatim + clear
  titles; the onboard prompt and instructions name the new tools; the full e2e eval
  validates real routing.
- **Missed `add` reference** → a stale-ref sweep (`\badd\b` tool usages in src/test/
  eval scenarios/docs) at the end.
- **Required-arg schema change** → `add_container.source` etc. now required; the
  handler `isBlank` checks still catch empty strings; server tests cover both.
- **`resources/tool-meta/` shipping** → already covered by `package.json` `files`.

---

## 8. Out of scope / deferred

- Any change to `run`/`ask`/`context`/`onboard`/`inspect`/`sync`/`config`.
- A deprecated `add` alias.
