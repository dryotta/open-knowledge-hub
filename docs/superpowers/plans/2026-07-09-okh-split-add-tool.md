# Split `add` into `add_container` + `add_module` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the overloaded `add` MCP tool with two focused tools, `add_container` and `add_module`, with tightened schemas.

**Architecture:** Only the tool layer changes: split `toolShapes.add` into two shapes, split `resources/tool-meta/add.md` into two files, and split the single `add` registration/handler in `tools.ts` into two. The `ContainerService.addContainer`/`addModule` methods (and their tests) are untouched. Ripple: `server.test.ts`, onboard/instructions prompts, docs, and four eval scenarios.

**Tech Stack:** TypeScript (ESM), Zod, Vitest v4, MCP SDK, promptfoo eval harness.

**Spec:** `docs/superpowers/specs/2026-07-09-okh-split-add-tool-design.md`

---

## File Structure

**Modify:** `src/server/toolSchemas.ts`, `src/server/tools.ts`, `test/server.test.ts`, `resources/prompts/onboard.md`, `resources/prompts/instructions.md`, `README.md`, `USAGE.md`, `CONTEXT.md`, `eval/scenarios/onboard/{existing-folder,github-repo,new-hub,cold-start-conversation}.yaml`.
**Create:** `resources/tool-meta/add_container.md`, `resources/tool-meta/add_module.md`.
**Delete:** `resources/tool-meta/add.md`.
**Unchanged:** `src/container/service.ts`, `test/service.test.ts`, `test/add-confirm.test.ts` (service layer).

**Verification:** `npm run build`, `npm run typecheck`, `npm test`, `npm run typecheck:eval`, `npm run test:eval`, `npm run eval:validate`, `npm run build && npm run eval`.

---

## Task 1: Core split (schemas + metadata + registration + server tests)

These change together to keep the build/tests green.

**Files:**
- Modify: `src/server/toolSchemas.ts`, `src/server/tools.ts`, `test/server.test.ts`
- Create: `resources/tool-meta/add_container.md`, `resources/tool-meta/add_module.md`
- Delete: `resources/tool-meta/add.md`

- [ ] **Step 1: Split `toolShapes` in `src/server/toolSchemas.ts`**

Replace the `add: { … }` entry with these two entries (keep all other entries):
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
(`ToolName = keyof typeof toolShapes` now includes `add_container`/`add_module`, not `add`.)

- [ ] **Step 2: Create the two metadata files, delete `add.md`**

Create `resources/tool-meta/add_container.md`:
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
Create `resources/tool-meta/add_module.md`:
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
Delete the old file:
```bash
git rm resources/tool-meta/add.md
```

- [ ] **Step 3: Replace the `add` registration in `src/server/tools.ts` with two**

Delete the entire `server.registerTool("add", …)` block (its options object and combined handler) and replace it with these two blocks:
```ts
  server.registerTool(
    "add_container",
    { ...(await toolReg("add_container")), annotations: { openWorldHint: true } },
    handler(async (args: { source: string; name?: string; sync?: "auto" | "pr"; backend?: "local" | "onedrive"; create?: boolean }) => {
      if (isBlank(args.source)) return fail("source cannot be empty.");
      const outcome = await service.addContainer({
        source: args.source,
        ...(args.name ? { name: args.name } : {}),
        ...(args.sync ? { sync: args.sync } : {}),
        ...(args.backend ? { backend: args.backend } : {}),
        ...(args.create ? { create: true } : {}),
      });
      if (outcome.kind === "plan") {
        return ok(formatContainerPlan(outcome.plan), { plan: outcome.plan, needsConfirmation: true });
      }
      return ok(`Registered container "${outcome.entry.name}" [${outcome.entry.backend}] at ${outcome.entry.localPath}.`, { entry: outcome.entry });
    }),
  );

  server.registerTool(
    "add_module",
    { ...(await toolReg("add_module")), annotations: { openWorldHint: true } },
    handler(async (args: { container: string; path: string; type: string; name: string; description?: string; config?: Record<string, unknown>; create?: boolean }) => {
      if (isBlank(args.container)) return fail("container cannot be empty.");
      if (isBlank(args.path)) return fail("path cannot be empty.");
      if (isBlank(args.name)) return fail("name cannot be empty.");
      const outcome = await service.addModule({
        container: args.container,
        path: args.path,
        type: args.type,
        name: args.name,
        ...(args.description !== undefined ? { description: args.description } : {}),
        ...(args.config ? { config: args.config } : {}),
        ...(args.create ? { create: true } : {}),
      });
      if (outcome.kind === "plan") {
        return ok(formatModulePlan(outcome.plan), { plan: outcome.plan, needsConfirmation: true });
      }
      const added = `Added ${outcome.entry.type} module "${outcome.entry.name}" at "${outcome.entry.path}" to "${args.container}" at ${outcome.moduleRoot}.`;
      const next =
        outcome.entry.type === "knowledge"
          ? ` Next, populate it by running the initialize skill: run { container: "${args.container}", module: "${outcome.entry.path}", skill: "initialize" }.`
          : "";
      return ok(added + next, { entry: outcome.entry });
    }),
  );
```
The `registerTools` doc comment at the top ("Register the four operational tools (`inspect`, `add`, `sync`, `config`) …") should read "… (`inspect`, `add_container`, `add_module`, `sync`, `config`) …".

- [ ] **Step 4: Update `test/server.test.ts`**

(a) Tool-list assertion — change the expected array to 9 sorted names:
```ts
    expect(tools).toEqual(["add_container", "add_module", "ask", "config", "context", "inspect", "onboard", "run", "sync"]);
```
(b) "tool titles/descriptions load from resources" test — target `add_container`:
```ts
    const add = tools.find((t) => t.name === "add_container")!;
    expect(add.description).toContain("returns a plan and makes no changes");
```
(c) Every container-add `callTool({ name: "add", arguments: { source, … } })` → `name: "add_container"`; every module-add `callTool({ name: "add", arguments: { container, path, type, name, … } })` → `name: "add_module"`. Specifically:
- the "adding a knowledge module points at the initialize skill" test: first call → `add_container`, second call → `add_module`.
- the inspect-setup test (adds hub + kb): → `add_container`, then `add_module`.
- the "add preview then applied container" test (`{ source: dir, name: "hub" }` / `… create: true`): both → `add_container`.
- the module-preview test (adds hub, previews kb): container → `add_container`, module preview → `add_module`.
- the "ask tool returns discipline text" test (adds hub + kb): → `add_container`, `add_module`.
- the run-setup test (adds hub + mem): → `add_container`, then `add_module` (`type: "memory"`).
(d) **Delete** the test `it("rejects add requests that mix container and module modes", …)` and the test `it("rejects add requests that mix source with empty module fields", …)` entirely (both assert the removed mutual-exclusion message).
(e) Split the empty-field test `it("rejects add requests with empty source/path fields", …)` to:
```ts
  it("rejects add requests with empty source/path fields", async () => {
    const { client } = await connect();
    const emptySource = await client.callTool({ name: "add_container", arguments: { source: "" } });
    expect(isErrorResult(emptySource)).toBe(true);
    expect(textOf(emptySource)).toContain("source cannot be empty");

    const emptyPath = await client.callTool({
      name: "add_module",
      arguments: { container: "hub", path: "", type: "knowledge", name: "KB" },
    });
    expect(isErrorResult(emptyPath)).toBe(true);
    expect(textOf(emptyPath)).toContain("path cannot be empty");
  });
```

- [ ] **Step 5: Build, typecheck, run tests**

Run: `npm run build && npm run typecheck && npx vitest run test/server.test.ts test/toolMeta.test.ts`
Expected: clean build/typecheck; PASS. The `toolMeta` consistency loop now covers `add_container`/`add_module` (arg↔schema parity), and `server.test.ts` shows 9 tools.

- [ ] **Step 6: Commit**

```bash
git add -A src/server/toolSchemas.ts src/server/tools.ts resources/tool-meta test/server.test.ts
git commit -m "feat(tools): split add into add_container and add_module"
```

---

## Task 2: Prompt + documentation ripple

**Files:** `resources/prompts/onboard.md`, `resources/prompts/instructions.md`, `README.md`, `USAGE.md`, `CONTEXT.md`

- [ ] **Step 1: `resources/prompts/onboard.md`** — replace the passage:
```markdown
Call `add`. Remember: `add` returns a *plan* and makes no changes by default. Show
the plan, get an explicit "yes", then call `add` again with `create: true`. After
the container exists, offer to add a `knowledge` module (and others as needed) the
same way.
```
with:
```markdown
Call `add_container`. Remember: it returns a *plan* and makes no changes by default.
Show the plan, get an explicit "yes", then call `add_container` again with
`create: true`. After the container exists, offer to add a `knowledge` module (and
others as needed) with `add_module` the same way (plan first, then `create: true`).
```

- [ ] **Step 2: `resources/prompts/instructions.md`** — in the single paragraph, change `use inspect/add/sync to manage containers` to `use inspect/add_container/add_module/sync to manage containers`.

- [ ] **Step 3: `README.md`**
  - Line ~7: `**Operational tools** (`inspect`, `add`, `sync`,` → `(`inspect`, `add_container`, `add_module`, `sync`,`.
  - Line ~39: `entry** at `add`-time` → `entry** at `add_container`-time`.
  - Replace the `| `add` | … |` table row with two rows:
```markdown
| `add_container` | `source`, `name?`, `sync?`, `backend?`, `create?` | Register a container. Returns a plan unless `create:true`. |
| `add_module` | `container`, `path`, `type`, `name`, `description?`, `config?`, `create?` | Add a typed module to a container. Returns a plan unless `create:true`. |
```
  - Replace the two examples:
```markdown
- `add_container { source: "https://github.com/me/my-notes.git", name: "my-notes" }` → clone + register a container.
- `add_module { container: "my-notes", path: "kb", type: "knowledge", name: "kb" }` → add a module.
```

- [ ] **Step 4: `USAGE.md`**
  - The operational-tools line: `(`inspect`, `add`, `sync`, `config`)` → `(`inspect`, `add_container`, `add_module`, `sync`, `config`)`.
  - The confirmation-step paragraph: replace `` `add` never changes anything on disk on its own. It first replies with a **plan** … your agent then re-runs `add` to apply. This is why the first `add` shows a plan …`` with `` `add_container` and `add_module` never change anything on disk on their own. Each first replies with a **plan** …; your agent then re-runs the same tool with `create:true` to apply. This is why the first call shows a plan …`` (keep the surrounding sentence structure; only the tool names/prose change).
  - Leave the natural-language examples ("`hub, add my folder …`", "`hub, add a knowledge module …`") unchanged — they're how the user speaks, not tool names.

- [ ] **Step 5: `CONTEXT.md`**
  - `and `sync` are set at `add`-time` → `at `add_container`-time`.
  - `- Operational tools (act on state): `inspect`, `add`, `sync`, `config`.` → `… `inspect`, `add_container`, `add_module`, `sync`, `config`.`

- [ ] **Step 6: Sanity build + prompt render**

Run: `npm run build && node --import tsx -e "import('./src/prompts/index.ts').then(async m => { const t = await m.buildOnboard([], { wakePhrase: 'sam' }); console.log(t.includes('add_container') && t.includes('add_module') ? 'OK' : 'BAD'); })"`
Expected: prints `OK`.

- [ ] **Step 7: Commit**

```bash
git add resources/prompts/onboard.md resources/prompts/instructions.md README.md USAGE.md CONTEXT.md
git commit -m "docs(tools): reference add_container/add_module in prompts and docs"
```

---

## Task 3: Eval scenario updates

**Files:** `eval/scenarios/onboard/{existing-folder,github-repo,new-hub,cold-start-conversation}.yaml`

- [ ] **Step 1: Update the four scenarios' tool expectations** (all are container adds)
  - `existing-folder.yaml`: `config: { expect: [add] }` → `config: { expect: [add_container] }`.
  - `github-repo.yaml`: `config: { expect: [add, inspect] }` → `config: { expect: [add_container, inspect] }`.
  - `new-hub.yaml`: `config: { expect: [add] }` → `config: { expect: [add_container] }`; and the judge check `check: { kind: tool, name: add }` → `check: { kind: tool, name: add_container }`; if that criterion's `text` says "The agent used the add tool." change it to "The agent used the add_container tool."
  - `cold-start-conversation.yaml`: `config: { expect: [onboard, config, add] }` → `config: { expect: [onboard, config, add_container] }`.

- [ ] **Step 2: Validate the eval subsystem**

Run: `npm run typecheck:eval && npm run test:eval && npm run eval:validate`
Expected: typecheck 0 errors; eval unit tests pass (they use `"add"` as a generic mock name, unaffected); `eval:validate` prints "Configuration is valid."

- [ ] **Step 3: Commit**

```bash
git add eval/scenarios/onboard
git commit -m "test(eval): expect add_container in onboard scenarios"
```

---

## Task 4: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Build + typecheck + unit tests**

Run: `npm run build && npm run typecheck && npm test`
Expected: clean build, 0 type errors, all unit tests pass (server test shows 9 tools).

- [ ] **Step 2: Stale-reference sweep**

Run:
```bash
rg -n "\"add\"|name: \"add\"|toolReg\(\"add\"\)|expect: \[add\]|\badd\b-time|inspect/add/sync|`add`" src test resources README.md USAGE.md CONTEXT.md eval/scenarios
```
Expected: no remaining references to the combined `add` tool in `src`, `test`, `resources`, docs, or `eval/scenarios` (natural-language "add" in USAGE examples and the generic `"add"` mock in `eval-test/*` are acceptable and out of this path). Use the `grep` tool if `rg` is unavailable.

- [ ] **Step 3: Eval subsystem checks**

Run: `npm run typecheck:eval && npm run test:eval && npm run eval:validate`
Expected: all green; "Configuration is valid."

- [ ] **Step 4: Full e2e eval (larger-change gate)**

Run: `npm run build && npm run eval`
Expected: scenarios pass (or only the known soft-criterion flakes). Confirm the onboard scenarios show the agent routing to `add_container`/`add_module`. Investigate any NEW failure via `~/.promptfoo/promptfoo.db` (latest `evals.id` → `eval_results` where `success=0`); a routing regression would show the agent still calling a nonexistent `add`.

- [ ] **Step 5: Final commit if fixups were needed**

```bash
git add -A
git commit -m "chore: post add-split fixups"
```

---

## Self-Review Notes (author)

- **Spec coverage:** §2 schemas → Task 1 Step 1; §3 metadata → Task 1 Step 2; §4 handlers → Task 1 Step 3; §5 ripple → Task 1 Step 4 (tests) + Task 2 (prompts/docs) + Task 3 (eval); §6 verification → Task 4.
- **Green-per-task:** Task 1 is one cohesive unit (schemas+meta+registration+tests must land together); Tasks 2–3 are independent text/config that don't affect the build.
- **Type consistency:** `add_container`/`add_module` names, `toolShapes` keys, `toolReg(name)`, and the handler arg types are consistent across schema, metadata, registration, and tests. Required args (`source`; `container`/`path`/`type`/`name`) are required in Zod; `isBlank` guards remain for empty strings.
- **Service layer untouched:** `service.test.ts`/`add-confirm.test.ts` use `service.addContainer`/`addModule` directly and need no changes.
