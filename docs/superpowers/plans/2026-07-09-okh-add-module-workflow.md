# add_module Workflow + Domain-Agnostic initialize — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `add_module` return a step-by-step workflow prompt by default (`create` falsy) and apply only on `create:true`, and rewrite the `knowledge` `initialize` skill to be domain-agnostic.

**Architecture:** Tool-layer + resources change only; `service.addModule` is untouched. A new rendered prompt (`resources/prompts/add_module.md`) is returned when `create` is falsy; `create:true` calls the unchanged service and points at the type's `initialize` skill if it ships one. `initialize` becomes a general grill→gather→write→verify skill whose per-domain rules live in `index.md`.

**Tech Stack:** TypeScript (Node ESM), Zod, Vitest, MCP SDK, markdown resources.

**Spec:** `docs/superpowers/specs/2026-07-09-okh-add-module-workflow-design.md`

---

## File Structure

- `src/prompts/templates.ts` — add `"add_module"` to the `TemplateName` union.
- `src/prompts/index.ts` — new `buildAddModule(targets, moduleTypes)` builder.
- `resources/prompts/add_module.md` — new workflow prompt (injected containers + types).
- `src/server/toolSchemas.ts` — make `add_module` identity args optional.
- `src/server/tools.ts` — new `add_module` handler; remove dead `formatModulePlan`.
- `resources/module-types/knowledge/skills/initialize/SKILL.md` — domain-agnostic rewrite.
- `resources/tool-meta/add_module.md` — description reflects workflow behavior.
- `resources/prompts/onboard.md`, `resources/prompts/instructions.md` — wording.
- `README.md`, `USAGE.md`, `CONTEXT.md` — wording.
- `test/prompts.test.ts`, `test/server.test.ts` — tests.

---

## Task 1: `add_module` workflow prompt template + builder

**Files:**
- Modify: `src/prompts/templates.ts` (the `TemplateName` union, line 8)
- Modify: `src/prompts/index.ts`
- Create: `resources/prompts/add_module.md`
- Test: `test/prompts.test.ts`

- [ ] **Step 1: Write the failing test**

Add to the `describe("prompt builders", …)` block in `test/prompts.test.ts` (import
`buildAddModule` on line 6 alongside the existing builders):

```ts
  it("buildAddModule injects containers + module types and the workflow discipline", async () => {
    const text = await buildAddModule(targets, ["knowledge", "skills", "memory"]);
    expect(text).toContain("/c/hub/kb");            // injected container/module path
    expect(text).toContain("knowledge, skills, memory"); // injected module types
    expect(text).toContain('<discipline name="add_module">');
    expect(text).toContain("create: true");          // step 3 names the apply call
    expect(text).toMatch(/initialize/);              // step 4 names initialize
  });
```

Update the import line 6 to:

```ts
import { buildAddModule, buildAsk, buildContext, buildOnboard, buildRun } from "../src/prompts/index.js";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/prompts.test.ts -t "buildAddModule"`
Expected: FAIL — `buildAddModule` is not exported / not a function.

- [ ] **Step 3: Add `"add_module"` to the template union**

In `src/prompts/templates.ts`, change line 8:

```ts
export type TemplateName = "ask" | "context" | "onboard" | "run" | "instructions" | "add_module";
```

- [ ] **Step 4: Add the `buildAddModule` builder**

In `src/prompts/index.ts`, add after `buildOnboard` (around line 42):

```ts
export function buildAddModule(targets: ResolvedContainer[], moduleTypes: readonly string[]): Promise<string> {
  return renderTemplate("add_module", {
    vars: { targets: renderTargets(targets), moduleTypes: moduleTypes.join(", ") },
  });
}
```

- [ ] **Step 5: Create the prompt file**

Create `resources/prompts/add_module.md`:

```markdown
# OKH: add_module

**Registered containers:**
{{var:targets}}

**Built-in module types:** {{var:moduleTypes}}

<discipline name="add_module">

# Add a module

Guide the user through adding a typed module. Do the stages in order; do ONE proposal
per turn and wait for the user. Do not create anything until they explicitly agree.

## Stage 1 — Understand the need

In one or two sentences, establish what this module should capture, who reads it, and
what they need to accomplish. Ask; don't assume. This goal is the yardstick for every
later choice.

## Stage 2 — Propose the module

Propose, and get the user's explicit agreement on:
- **container** — an existing one from the list above, or add one first with `add_container`.
- **type** — a built-in from the list above, or a custom type name if none fit.
- **name** — a short display name.
- **path** — the module folder path within the container.
- **description** — a one-line description.

Present the proposal and wait for a clear "yes" before creating anything.

## Stage 3 — Create it

Once agreed, apply the change:
`add_module { container, path, type, name, description, create: true }`.

## Stage 4 — Initialize

If the create response says the type ships an `initialize` skill, run it to populate the
module: `run { container, module, skill: "initialize" }`. Otherwise you're done — tell the
user the module is ready.

</discipline>
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run test/prompts.test.ts -t "buildAddModule"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/prompts/templates.ts src/prompts/index.ts resources/prompts/add_module.md test/prompts.test.ts
git commit -m "feat: add_module workflow prompt template + builder

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 2: `add_module` handler returns the workflow by default; applies on create:true

**Files:**
- Modify: `src/server/toolSchemas.ts:16-24`
- Modify: `src/server/tools.ts` (imports; `add_module` handler lines 177-203; remove `formatModulePlan` lines 103-109)
- Test: `test/server.test.ts` (lines 83-93, 199-210, 232-236)

- [ ] **Step 1: Update the failing/changed tests first**

In `test/server.test.ts`, **replace** the existing add_module preview test (the
`it("previews (no side effects) without create"…)` block around lines 199-210 — the one
asserting `"Plan (no changes made)"` and `needsConfirmation` for `add_module`) with:

```ts
  it("add_module without create returns the workflow (no mutation)", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);

    await client.callTool({ name: "add_container", arguments: { source: dir, name: "hub", create: true } });
    const res = await client.callTool({ name: "add_module", arguments: {} });

    const text = textOf(res);
    expect(text).toContain('<discipline name="add_module">');
    expect(text).toContain("create: true");
    expect(structuredOf(res).needsConfirmation).toBeUndefined();
  });
```

Update the empty-`path` guard test (around lines 232-236) to pass `create: true` so the
guard still fires:

```ts
    const emptyPath = await client.callTool({
      name: "add_module",
      arguments: { container: "hub", path: "", type: "knowledge", name: "KB", create: true },
    });
    expect(isErrorResult(emptyPath)).toBe(true);
```

Add a negative initialize-pointer test right after the existing
`"adding a knowledge module points at the initialize skill"` test (after line 93):

```ts
  it("adding a non-initialize type omits the initialize pointer", async () => {
    const { client } = await connect();
    const source = await makeTempDir();
    cleanups.push(source);
    await client.callTool({ name: "add_container", arguments: { source, name: "hub", create: true } });
    const res = await client.callTool({
      name: "add_module",
      arguments: { container: "hub", path: "sk", type: "skills", name: "SK", create: true },
    });
    expect(textOf(res)).not.toContain('skill: "initialize"');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/server.test.ts -t "add_module"`
Expected: FAIL — bare `add_module {}` currently errors (`container cannot be empty`) instead
of returning the workflow; skills-type add still succeeds but pointer logic not yet general.

- [ ] **Step 3: Make the schema identity args optional**

In `src/server/toolSchemas.ts`, replace the `add_module` shape (lines 16-24):

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

- [ ] **Step 4: Update imports in `tools.ts`**

In `src/server/tools.ts`, extend the prompts import (line 21) and add two module imports:

```ts
import { buildAddModule, buildAsk, buildContext, buildOnboard, buildRun } from "../prompts/index.js";
import { BUILTIN_MODULE_TYPES } from "../modules/types.js";
import { vendoredSkills } from "../modules/vendored.js";
```

Remove the now-unused `AddModulePlan` from the type import block (lines 4-10) — it is only
used by `formatModulePlan`, which this task deletes. Keep `AddContainerPlan`, `ContainerService`,
`InspectResult`, `SyncResult`.

- [ ] **Step 5: Delete the dead `formatModulePlan` helper**

In `src/server/tools.ts`, delete lines 103-109 (the entire `function formatModulePlan(…) { … }`).

- [ ] **Step 6: Rewrite the `add_module` handler**

In `src/server/tools.ts`, replace the whole `server.registerTool("add_module", …)` block
(lines 177-203) with:

```ts
  server.registerTool(
    "add_module",
    { ...(await toolReg("add_module")), annotations: { openWorldHint: true } },
    handler(async (args: { container?: string; path?: string; type?: string; name?: string; description?: string; config?: Record<string, unknown>; create?: boolean }) => {
      if (!args.create) {
        const targets = await service.resolveTargets();
        return ok(await buildAddModule(targets, BUILTIN_MODULE_TYPES));
      }
      if (isBlank(args.container ?? "")) return fail("container cannot be empty. (required when create:true)");
      if (isBlank(args.path ?? "")) return fail("path cannot be empty. (required when create:true)");
      if (isBlank(args.type ?? "")) return fail("type cannot be empty. (required when create:true)");
      if (isBlank(args.name ?? "")) return fail("name cannot be empty. (required when create:true)");
      const outcome = await service.addModule({
        container: args.container!,
        path: args.path!,
        type: args.type!,
        name: args.name!,
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.config ? { config: args.config } : {}),
        create: true,
      });
      if (outcome.kind !== "applied") return fail("add_module create:true did not apply.");
      const added = `Added ${outcome.entry.type} module "${outcome.entry.name}" at "${outcome.entry.path}" to "${args.container}" at ${outcome.moduleRoot}.`;
      const hasInit = (await vendoredSkills(outcome.entry.type)).some((s) => s.name === "initialize");
      const next = hasInit
        ? ` Next, initialize it: run { container: "${args.container}", module: "${outcome.entry.path}", skill: "initialize" }.`
        : "";
      return ok(added + next, { entry: outcome.entry });
    }),
  );
```

- [ ] **Step 7: Run the add_module tests**

Run: `npx vitest run test/server.test.ts -t "add_module"`
Expected: PASS (workflow-by-default, empty-path guard on create:true, initialize pointer for
knowledge, no pointer for skills).

- [ ] **Step 8: Typecheck (catches the removed `AddModulePlan` import / unused symbols)**

Run: `npm run typecheck`
Expected: exit 0. If it flags an unused import, remove it.

- [ ] **Step 9: Run the full server + prompts suites**

Run: `npx vitest run test/server.test.ts test/prompts.test.ts`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/server/toolSchemas.ts src/server/tools.ts test/server.test.ts
git commit -m "feat: add_module returns workflow by default, applies on create:true

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 3: Rewrite the `knowledge` `initialize` skill (domain-agnostic)

**Files:**
- Modify: `resources/module-types/knowledge/skills/initialize/SKILL.md`

- [ ] **Step 1: Replace the file contents**

Overwrite `resources/module-types/knowledge/skills/initialize/SKILL.md` with:

```markdown
---
name: initialize
description: Populate a newly-created knowledge module by grilling out its requirements and sourcing rules, then gathering and writing only what those requirements demand.
---

# Initialize a knowledge module

The module already exists (name, type, and one-line description were set when it was added).
Your job is to turn it from an empty shell into a **scope-bounded knowledge pack**: it exists
to satisfy a specific, agreed set of requirements — nothing more. Anything that doesn't help
satisfy a requirement does not belong.

The whole point is restraint. A sprawling auto-generated wiki is the failure mode. Resist it.
This skill makes **no assumptions about the subject domain** — a codebase, a product area,
research, personal or organizational know-how. The module's own rules are decided in Stage 1
and written into `index.md`.

## Workflow

Run these stages in order. Each hands off to the next.

### Stage 1 — Grill the requirements

Run the shared **grilling** skill (`run { skill: "grilling" }`) to produce a written **scope
contract**, then write it to the module's `index.md`. The contract has three parts:

- **Goals** — what this module is *for*: who reads it and what they need to accomplish. One to
  three sentences. Goals are the yardstick for every later decision.
- **Requirements** — the concrete things a reader must be able to answer or do from the module.
  For each candidate piece of information, make an explicit decision: **should this module
  manage it, or not?** Every in-scope requirement traces to a goal. List what is explicitly
  **out-of-scope**, and briefly why it doesn't serve the goals.
- **Sourcing & grounding rules** — decided here, not assumed: where this module's knowledge
  comes from (e.g. a code repository, documents, the user's own expertise) and how a claim is
  grounded, cited, and verified **for this module**. If the module documents code, the rules
  might say "cite repository paths and pin a commit SHA" — but that is a per-module choice, not
  a default.

Grill until goals, requirements, out-of-scope, and sourcing rules are sharp and mutually
consistent. Push back on vague or unbounded requirements ("capture everything" is not a
requirement). Iterate with the user to tighten and trim. Do not start gathering in earnest
until the contract is agreed and written to `index.md`.

### Stage 2 — Gather (requirement-guided)

Collect only what the requirements demand, from the sources the contract named. Follow the
threads each requirement opens and **stop once every requirement is satisfiable**. Do not
exhaustively survey the source.

If authoritative prior artifacts exist in the agreed sources, read them as input rather than
re-deriving what they already settle.

### Stage 3 — Grill the gaps

A short second grilling pass (`run { skill: "grilling" }`) — only for claims you found evidence
of but **cannot ground** from the agreed sources (usually "why" / rationale). Resolve each with
the user before it is written, or mark it per the module's grounding rules (e.g. a `⚠️ UNVERIFIED`
flag).

### Stage 4 — Write

Populate the module, applying the module's own grounding rules from the contract. When authoring
an [OKF](https://github.com/GoogleCloudPlatform/knowledge-catalog/tree/main/okf) bundle of concept
docs, use the shared **okf-writer** skill (`run { skill: "okf-writer" }`). Every non-trivial claim
is grounded or flagged per the contract; name the requirement each piece serves.

### Stage 5 — Verify (the scope gate)

This is the completion criterion. Spawn a **fresh sub-agent given ONLY the module's content** (no
access to the sources or this conversation) and check it against every requirement.

- If it cannot satisfy a requirement → the module has a gap. Fix it (gather more, or grill the
  user), then re-test.
- **Prune ruthlessly:** anything not needed to satisfy a requirement is out of scope. Cut it.

The module is done only when the fresh reader satisfies **every** requirement and nothing in the
module is unused by those answers.

## Completion criterion

- A written scope contract (goals + requirements + out-of-scope + sourcing/grounding rules)
  exists in the module's `index.md`, with goals justifying every requirement.
- Content is grounded per the module's own rules (cited, flagged, or sourced from grilling).
- A fresh reader sub-agent, given only the module, satisfies every requirement.
- Nothing survives that isn't needed to satisfy a requirement.
```

- [ ] **Step 2: Verify the skill still parses/loads (frontmatter + discovery)**

Run: `npx vitest run test/inspect.test.ts test/server.test.ts`
Expected: PASS (skill discovery reads the frontmatter `name`/`description`; the create:true
initialize-pointer test still finds a skill named `initialize`).

- [ ] **Step 3: Commit**

```bash
git add resources/module-types/knowledge/skills/initialize/SKILL.md
git commit -m "refactor: make knowledge initialize skill domain-agnostic

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 4: Ripple — tool-meta, prompts, and docs wording

**Files:**
- Modify: `resources/tool-meta/add_module.md`
- Modify: `resources/prompts/onboard.md:50-57`
- Modify: `resources/prompts/instructions.md:1`
- Modify: `README.md`, `USAGE.md`, `CONTEXT.md`

- [ ] **Step 1: Update the tool-meta description**

Overwrite `resources/tool-meta/add_module.md` with:

```markdown
---
title: Add a module
args:
  container: Target container (required when create:true).
  path: Module folder path within the container (required when create:true).
  type: "Module type: a built-in (knowledge, skills, tools, memory, project) or a custom type name (required when create:true)."
  name: Module display name (required when create:true).
  description: One-line module description.
  config: Optional module config.
  create: Apply the change. Omit to get a step-by-step workflow (no changes).
---
By default this returns a step-by-step workflow for adding, creating, and initializing a module — follow it: understand the need, propose { container, path, type, name, description } and get the user's agreement, then re-call with create:true to apply, and run the type's initialize skill if it has one.
```

- [ ] **Step 2: Update the onboard prompt's add-module passage**

In `resources/prompts/onboard.md`, replace the paragraph that currently reads (lines ~50-57,
starting "Call `add_container`." through the `initialize` sentence) so the module part reads:

```markdown
Call `add_container`. Remember: it returns a *plan* and makes no changes by default.
Show the plan, get an explicit "yes", then call `add_container` again with
`create: true`. After the container exists, offer to add a `knowledge` module (and
others as needed): call `add_module` — it returns a short step-by-step workflow. Follow
it: it has you understand the need, propose the module and confirm with the user, apply
with `create: true`, then run the type's `initialize` skill to populate it.
```

Delete the now-redundant standalone paragraph "When a `knowledge` module is created, run its
`initialize` skill (`run { container, module, skill: "initialize" }`) to survey the target repo
into a scope-bounded pack." (lines ~55-57) — the workflow reference above covers it.

- [ ] **Step 3: Update instructions.md**

In `resources/prompts/instructions.md`, change the clause
"`add_container`/`add_module` preview changes and need create:true to apply after user
confirmation." to:

```
`add_container` previews changes and needs create:true to apply; `add_module` returns a guided workflow and applies on create:true after you propose the module to the user.
```

- [ ] **Step 4: Update README.md**

Find the `add_module` row/description and any `add_module {…}` example (search
`grep -n "add_module" README.md`). Change the tool-table description for `add_module` to:
"Returns a step-by-step workflow to add/create/initialize a module; applies on `create:true`."
For any example that shows `add_module { … create:true }` add a preceding note that a bare
`add_module` call returns the workflow first.

- [ ] **Step 5: Update USAGE.md and CONTEXT.md**

`grep -n "add_module" USAGE.md CONTEXT.md`. In USAGE.md's "Add a module" example, note that
`add_module` (no args) returns the workflow and `create:true` applies. In CONTEXT.md, adjust
the operational-tools phrasing so `add_module` is described as returning a workflow (not a
plan preview).

- [ ] **Step 6: Verify tool-meta consistency + description loading**

Run: `npx vitest run test/toolMeta.test.ts test/server.test.ts`
Expected: PASS (arg keys still match the schema; `add_container` description assertion is
unaffected).

- [ ] **Step 7: Commit**

```bash
git add resources/tool-meta/add_module.md resources/prompts/onboard.md resources/prompts/instructions.md README.md USAGE.md CONTEXT.md
git commit -m "docs: reflect add_module workflow behavior across meta, prompts, docs

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Task 5: Full verification (unit + eval structure + e2e eval)

**Files:** none (verification only)

- [ ] **Step 1: Typecheck + full unit suite**

Run: `npm run typecheck && npm test`
Expected: exit 0; all tests pass.

- [ ] **Step 2: Eval structure checks**

Run: `npm run typecheck:eval && npm run test:eval && npm run eval:validate`
Expected: typecheck exit 0; eval unit tests pass; validate prints "Configuration is valid."

- [ ] **Step 3: Build (the e2e harness launches dist/index.js)**

Run: `npm run build`
Expected: exit 0.

- [ ] **Step 4: Full e2e eval**

Run: `npm run eval`
Expected: onboard scenarios still pass — the agent routes to `add_container` for the container
and, for a module, calls `add_module` (workflow), then `add_module … create:true`, then
`run … skill: "initialize"`. If a scenario asserts a single `add_module` call, inspect the
transcript via `~/.promptfoo/promptfoo.db` and adjust the scenario expectation to the new
two-call flow (document any scenario edit in a follow-up commit).

- [ ] **Step 5: Final commit (only if Step 4 required scenario edits)**

```bash
git add eval/scenarios
git commit -m "test(eval): adjust onboard scenario for add_module two-call workflow

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

## Self-Review notes

- **Spec coverage:** schema (§2 → T2), handler + generalized pointer (§3 → T2), new prompt
  (§4 → T1), initialize rewrite (§5 → T3), ripple (§6 → T4), verification incl. e2e (§7 → T5).
- **Type consistency:** `buildAddModule(targets, moduleTypes)` defined in T1 and called in T2
  with `BUILTIN_MODULE_TYPES`; `vendoredSkills(type)` returns `Skill[]` with `.name`.
- **No placeholders:** all code/text shown inline; doc edits (T4 §4/§5) name the exact grep to
  locate the spot and the exact replacement wording.
