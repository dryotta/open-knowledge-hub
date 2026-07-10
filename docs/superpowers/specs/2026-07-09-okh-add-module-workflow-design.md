# OKH — `add_module` returns a workflow; general-purpose `initialize`

**Status:** Approved design (pre-implementation)
**Date:** 2026-07-09
**Branch:** `main`
**Relates to:** `2026-07-09-okh-split-add-tool-design.md`

---

## 1. Summary

Refactor `add_module` so that, by default (`create` falsy), it returns a **step-by-step
workflow prompt** guiding the agent through adding, creating, and initializing a module —
instead of the current "Plan (no changes made)" preview. Only `create:true` mutates.

Also rewrite the `knowledge` type's `initialize` skill to be **fully domain-agnostic**:
it no longer assumes the module documents a code repository. Per-domain rules (including
code-repo specifics, when relevant) are decided through a grilling session and stored in
the module's `index.md`.

Only the **tool layer** and **resources** change. `service.addModule` and its service-level
tests are untouched (the service still supports the plan/apply split; the tool just stops
using the plan branch).

### Goals

1. A bare `add_module` call returns a workflow that walks the agent through: understand the
   need → propose container/type/name/description → apply with `create:true` → run the
   type's `initialize` skill if it ships one.
2. Confirmation becomes conversational (driven by the prompt), replacing the plan-preview +
   `needsConfirmation` handshake for modules.
3. The `create:true` "run initialize" pointer generalizes to **any type that ships an
   `initialize` skill**, not just `knowledge`.
4. `initialize` is domain-agnostic; the module's sourcing/grounding rules are grilled and
   written to `index.md`, not hardcoded to code repositories.

### Non-goals

- No change to `service.addModule`/`planAddModule`/`applyAddModule` or their tests.
- No change to `add_container`, other tools, or the `learn`/`okf-writer` skills (they remain
  code-centric; aligning them is deferred).
- No back-compat shim for the old plan-preview module behavior (pre-1.0).

---

## 2. Schema — `src/server/toolSchemas.ts`

Make the module-identity args optional so a bare call can return the workflow:

```ts
add_module: {
  container: z.string().optional(),
  path: z.string().optional(),
  type: z.string().min(1).optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  create: z.boolean().optional(),
},
```

Arg keys are unchanged, so `resources/tool-meta/add_module.md` (and the `describeShape`
consistency check in `toolMeta.test.ts`) stay valid.

---

## 3. Handler — `src/server/tools.ts`

Replace the current `add_module` handler body:

- **`create` falsy** → `const targets = await service.resolveTargets();` then
  `return ok(await buildAddModule(targets, BUILTIN_MODULE_TYPES));`. No service mutation,
  no plan, no `needsConfirmation`.
- **`create:true`** →
  - Guard: `isBlank(container)`, `isBlank(path)`, `isBlank(name)`, and `isBlank(type)` →
    `fail("… cannot be empty. (required when create:true)")`.
  - `const outcome = await service.addModule({ …, create: true });` (always `kind:"applied"`).
  - Applied message as today, plus a generalized initialize pointer:
    ```ts
    const hasInit = (await vendoredSkills(outcome.entry.type)).some((s) => s.name === "initialize");
    const next = hasInit
      ? ` Next, initialize it: run { container: "${container}", module: "${outcome.entry.path}", skill: "initialize" }.`
      : "";
    ```
  - `return ok(added + next, { entry: outcome.entry });`

Remove the now-dead `formatModulePlan` helper (only `add_module` used it). Import
`vendoredSkills` from `../modules/vendored.js` and `BUILTIN_MODULE_TYPES` from
`../modules/types.js`.

---

## 4. New prompt — `resources/prompts/add_module.md`

A rendered template (like `onboard`) with injected live context and a discipline block:

```markdown
# OKH: add_module

**Registered containers:**
{{var:targets}}

**Built-in module types:** {{var:moduleTypes}}

<discipline name="add_module">
… 4-stage workflow …
</discipline>
```

Stages (concise, token-efficient prose):

1. **Understand the need** — what should this module capture, for whom, and to what end?
   One or two sentences. Ask; don't assume.
2. **Propose the module** — pick/confirm the container (from the list above, or add one
   first via `add_container`), the type (from the built-ins above, or a custom type name),
   a short `name`, a folder `path`, and a one-line `description`. Present the proposal and
   get the user's **explicit agreement** before creating anything.
3. **Create it** — call `add_module { container, path, type, name, description, create: true }`.
4. **Initialize** — if the type ships an `initialize` skill (the create response says so),
   run it: `run { container, module, skill: "initialize" }`. Otherwise stop.

Add `buildAddModule(targets, moduleTypes)` to `src/prompts/index.ts`
(`renderTemplate("add_module", { vars: { targets: renderTargets(targets), moduleTypes: moduleTypes.join(", ") } })`)
and add `"add_module"` to `TemplateName` in `src/prompts/templates.ts`.

---

## 5. Rewrite — `resources/module-types/knowledge/skills/initialize/SKILL.md`

Fully domain-agnostic. The skill runs **after** the module already exists (add_module did the
naming/typing). Remove all hardcoded code-repository assumptions (repo survey, git-origin SHA
citations, repo-path grounding as the only mode). Those become per-module rules the grilling
establishes.

Stages:

1. **Grill the requirements** (`run { skill: "grilling" }`) → produce a written **scope
   contract** and write it to `index.md`:
   - **Goals** — what this module is for; who reads it; what they need to accomplish.
   - **Requirements / target questions** — the concrete things the module must let a reader
     answer or do. Drive a decision for candidate pieces of information: *should this module
     manage it or not?* Every in-scope item traces to a goal; list what is explicitly
     out-of-scope and why.
   - **Sourcing & grounding rules** — where this module's knowledge comes from (e.g. a code
     repo, docs, the user's own expertise) and how claims are grounded/cited/verified **for
     this module**. This is decided here, not assumed. (If the module documents code, the
     rules can say "cite repo paths / pin a commit SHA" — but that's a per-module choice.)
2. **Gather** — collect only what the requirements demand, from the agreed sources. Stop once
   every requirement is satisfiable.
3. **Grill the gaps** (`run { skill: "grilling" }`) — a short second pass only for claims you
   can't ground from the agreed sources (usually "why" rationale). Resolve or flag as
   unverified per the module's grounding rules.
4. **Write** — populate the module (use `run { skill: "okf-writer" }` when authoring an OKF
   bundle), applying the module's own grounding rules.
5. **Verify (the scope gate)** — spawn a fresh sub-agent given only the module's content and
   confirm it can satisfy every requirement/target question. Prune anything not needed by an
   answer. Done only when every requirement is met and nothing unused remains.

Completion criterion: a written scope contract (goals + requirements + out-of-scope +
sourcing/grounding rules) exists in `index.md`; content is grounded per those rules; a fresh
reader satisfies every requirement; nothing unused remains.

---

## 6. Ripple updates

- **`resources/tool-meta/add_module.md`** — body now describes the workflow behavior:
  "By default returns a step-by-step workflow to add, create, and initialize a module; call
  again with create:true (after proposing to the user) to apply." Arg descriptions note the
  identity args are required only when `create:true`.
- **`resources/prompts/onboard.md`** — the "call `add_module` (plan first, then create:true)"
  passage → "call `add_module`; it returns a short workflow — follow it (it proposes the
  module, applies with create:true, then runs `initialize`)."
- **`resources/prompts/instructions.md`** — the "`add_container`/`add_module` preview changes
  and need create:true" clause → distinguish: `add_container` previews; `add_module` returns a
  guided workflow and applies on create:true.
- **Docs:** `README.md`, `USAGE.md`, `CONTEXT.md` — update the `add_module` row/description and
  any `add_module {…}` example to reflect workflow-by-default.
- **`test/server.test.ts`:**
  - The add_module create:false "previews… `needsConfirmation`" test → assert the response is
    the workflow (e.g. contains the discipline / a stage cue like "propose" and
    `create: true`) and has no `needsConfirmation`.
  - The empty-`path` guard test → call with `create: true` so the guard still fires.
  - The "adding a knowledge module points at the initialize skill" (create:true) test stays.
- **`test/prompts.test.ts`** — add a `buildAddModule` test (injects containers + module types,
  contains the add_module discipline).
- **Eval scenarios** — sweep `eval/scenarios/**` for any `add_module` expectation and confirm
  the onboard flow still routes correctly (agent may now call `add_module` once for the
  workflow, then again with `create:true`).

`test/add-confirm.test.ts` (`addModule preview/confirm`) targets the **service** and is
unchanged.

---

## 7. Tests & verification

- **Unit:** `npm run typecheck` and `npm test` (server + prompts + toolMeta updates above).
- **Eval structure:** `npm run typecheck:eval`, `npm run test:eval`, `npm run eval:validate`.
- **Full e2e eval:** `npm run build && npm run eval` — required (changes the `add_module`
  tool surface and the onboard flow exercises module creation). Confirm the agent follows the
  workflow, applies with `create:true`, and runs `initialize`.

---

## 8. Risks & mitigations

- **Agent doesn't re-call with `create:true`** → the workflow prompt states the create step
  explicitly and the applied message confirms; the full e2e eval validates real routing.
- **Optional identity args mask mistakes** → `create:true` branch guards each required arg.
- **`initialize` too abstract after removing code specifics** → the grilling stage forces a
  concrete, written scope contract (incl. sourcing/grounding) before any gathering, and the
  fresh-reader gate is the completion criterion.

## 9. Out of scope / deferred

- Aligning `learn` / `okf-writer` with the domain-agnostic `initialize` (still code-centric).
- Any change to `add_container` or the other tools/flows.
