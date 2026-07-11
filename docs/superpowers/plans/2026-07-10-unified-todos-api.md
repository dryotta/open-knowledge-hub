# Unified Todos API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `todos` plus `update_todo` with one preview-by-default `todos` API for listing, creating, and updating memory todos.

**Architecture:** Keep `TodoService` as the deterministic parser, validator, locator, serializer, and writer. Add a mutation preparation path that produces the same normalized proposed todo for preview and apply, but writes only when `apply: true`. The single MCP tool dispatches `list`, `create`, and `update`; skills preview, confirm, apply, and sync, while the MCP App applies status changes directly because a checkbox click is explicit authorization.

**Tech Stack:** TypeScript, Zod 4, MCP SDK, MCP Apps, Vitest, promptfoo eval harness.

---

## File map

- `src/todos/types.ts` — unified mutation inputs, previews, and discriminated results.
- `src/todos/service.ts` — prepare create/update once; optionally persist the prepared write.
- `src/server/toolSchemas.ts` — one conditional `todos` input surface; remove `update_todo`.
- `src/server/todoTools.ts` — one registration and operation dispatcher.
- `resources/tool-meta/todos.md` — unified API documentation.
- `resources/tool-meta/update_todo.md` — delete.
- `resources/module-types/memory/skills/{remember,todo}/SKILL.md` — preview/confirm/apply/sync discipline.
- `resources/prompts/instructions.md` — route all todo API calls through `todos`.
- `app/todos/main.ts` — invoke `todos` update with `apply: true`.
- `eval/copilot.ts` and `eval/provider/copilotProvider.ts` — retain ordered structured tool events with turn and success.
- `eval/assertions/{checks,judge}.ts` — deterministic preview/confirmation/apply/sync assertion.
- `eval/scenarios/{remember/todo,todo/complete}.yaml` — behavior-focused mutation scenarios.
- `README.md`, `CONTEXT.md` — one-tool documentation.
- Existing todo, server, app, prompt, skill, and eval tests — update in place.

### Task 1: Add preview-by-default service mutations

**Files:**
- Modify: `src/todos/types.ts:85-130`
- Modify: `src/todos/service.ts:260-539`
- Test: `test/todo-service.test.ts:149-end`

- [ ] **Step 1: Write failing service tests for preview and apply**

Add tests proving a preview returns the proposed task without changing disk, and the same input with `apply: true` writes:

```ts
it("previews create without writing and applies the same proposed todo", async () => {
  const { service, containerRoot } = await setupTodoServiceFixture();
  const input = {
    operation: "create" as const,
    container: "alpha",
    module: "memory",
    text: "Preview me",
    labels: ["work"],
  };

  const preview = await service.mutate(input);
  expect(preview).toMatchObject({
    operation: "create",
    applied: false,
    needsConfirmation: true,
    preview: {
      line: "- [ ] Preview me #todo #work ➕ 2026-07-10",
      todo: { text: "Preview me", labels: ["work"], status: "open" },
      source: { container: "alpha", module: "memory", path: "2026-07-10.md", line: 3 },
    },
  });
  await expect(readFile(join(containerRoot, "memory", "2026-07-10.md"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

  const applied = await service.mutate({ ...input, apply: true });
  expect(applied).toMatchObject({
    operation: "create",
    applied: true,
    todo: { text: "Preview me", labels: ["work"], status: "open" },
    dirtyContainer: "alpha",
  });
});

it("previews update without writing and revalidates the ref when applying", async () => {
  const { service, containerRoot } = await setupTodoServiceFixture();
  const original = (await service.list()).tasks.find((task) => task.text === "Buy milk")!;
  const target = join(containerRoot, "memory", "notes.md");
  const before = await readFile(target, "utf8");

  const preview = await service.mutate({
    operation: "update",
    ref: original.ref,
    completed: true,
  });
  expect(preview).toMatchObject({
    operation: "update",
    applied: false,
    needsConfirmation: true,
    preview: {
      line: expect.stringContaining("- [x] Buy milk"),
      source: { path: "notes.md", line: 2 },
      todo: { status: "completed", completed: "2026-07-10" },
    },
  });
  expect(await readFile(target, "utf8")).toBe(before);

  const applied = await service.mutate({
    operation: "update",
    ref: original.ref,
    completed: true,
    apply: true,
  });
  expect(applied).toMatchObject({ operation: "update", applied: true, todo: { status: "completed" } });
});
```

- [ ] **Step 2: Run the targeted service tests and verify RED**

Run:

```powershell
npx vitest run test/todo-service.test.ts
```

Expected: FAIL because `TodoService.mutate`, `operation: "update"`, previews, and `apply` do not exist.

- [ ] **Step 3: Replace update-only types with unified mutation types**

In `src/todos/types.ts`, replace `TodoUpdateInput`/`TodoUpdateResult` with:

```ts
export type TodoMutationInput =
  | {
      operation: "create";
      container: string;
      module: string;
      text: string;
      entrySummary?: string;
      observation?: string;
      labels?: string[];
      due?: string;
      priority?: TodoPriority;
      apply?: boolean;
    }
  | {
      operation: "update";
      ref: string;
      completed?: boolean;
      labels?: string[];
      due?: string | null;
      priority?: TodoPriority | null;
      apply?: boolean;
    };

export interface TodoMutationPreview {
  line: string;
  source: TodoSource;
  todo: TodoRecord;
}

export type TodoMutationResult =
  | {
      operation: TodoMutationInput["operation"];
      applied: false;
      preview: TodoMutationPreview;
      needsConfirmation: true;
    }
  | {
      operation: TodoMutationInput["operation"];
      applied: true;
      todo: TodoRecord;
      dirtyContainer: string;
    };
```

- [ ] **Step 4: Refactor service create/update into prepare-then-apply**

Add:

```ts
interface PreparedTodoMutation {
  operation: "create" | "update";
  preview: TodoMutationPreview;
  apply: () => Promise<{ todo: TodoRecord; dirtyContainer: string }>;
}

async mutate(input: TodoMutationInput): Promise<TodoMutationResult> {
  return this.mutex.run(async () => {
    const prepared = input.operation === "create"
      ? await this.prepareCreate(input)
      : await this.prepareUpdate(input);
    if (input.apply !== true) {
      return {
        operation: prepared.operation,
        applied: false,
        preview: prepared.preview,
        needsConfirmation: true,
      };
    }
    const result = await prepared.apply();
    return { operation: prepared.operation, applied: true, ...result };
  });
}
```

Move existing create/update validation and serialization into `prepareCreate` and `prepareUpdate`. Each method must calculate the final line, source, and normalized todo before returning. Put only `mkdir`/`atomicWrite` inside the returned `apply` closure. Preserve locator revalidation by rebuilding the preparation on every `mutate` call; never persist preview state.

- [ ] **Step 5: Update existing service mutation tests**

Replace helper calls:

```ts
await updateTodo(service, { operation: "create", ... })
```

with:

```ts
await service.mutate({ operation: "create", apply: true, ... })
```

Rename `"patch"` operations to `"update"` and add `apply: true` wherever the test expects disk changes. Keep invalid-input tests preview-only unless they specifically test writing.

- [ ] **Step 6: Run service tests and typecheck**

Run:

```powershell
npx vitest run test/todo-service.test.ts test/todo-serializer.test.ts
npm run typecheck:server
```

Expected: all targeted tests pass and TypeScript reports no errors.

- [ ] **Step 7: Commit**

```powershell
git add src\todos\types.ts src\todos\service.ts test\todo-service.test.ts
git commit -m "refactor: add previewable todo mutations"
```

### Task 2: Expose one unified `todos` MCP tool

**Files:**
- Modify: `src/server/toolSchemas.ts:32-56`
- Modify: `src/server/todoTools.ts`
- Modify: `resources/tool-meta/todos.md`
- Delete: `resources/tool-meta/update_todo.md`
- Modify: `test/server.test.ts:187-380`
- Modify: `test/toolMeta.test.ts`

- [ ] **Step 1: Write failing server-surface tests**

Change the expected tool count and names so `update_todo` is absent, then add a round-trip test:

```ts
it("exposes one unified todos tool with preview and apply results", async () => {
  const { client } = await connect();
  const tools = (await client.listTools()).tools;
  expect(tools.map((tool) => tool.name)).toContain("todos");
  expect(tools.map((tool) => tool.name)).not.toContain("update_todo");
  expect(tools.find((tool) => tool.name === "todos")?.annotations).toMatchObject({
    readOnlyHint: false,
    openWorldHint: false,
  });

  // Set up hub/mem as in the existing round-trip test.
  const preview = await client.callTool({
    name: "todos",
    arguments: {
      operation: "create",
      container: "hub",
      module: "mem",
      text: "Ship unified todos",
      labels: ["release"],
    },
  });
  expect(structuredOf(preview)).toMatchObject({
    operation: "create",
    applied: false,
    needsConfirmation: true,
    preview: { todo: { text: "Ship unified todos" } },
  });

  const applied = await client.callTool({
    name: "todos",
    arguments: {
      operation: "create",
      container: "hub",
      module: "mem",
      text: "Ship unified todos",
      labels: ["release"],
      apply: true,
    },
  });
  expect(structuredOf(applied)).toMatchObject({
    operation: "create",
    applied: true,
    todo: { text: "Ship unified todos" },
    dirtyContainer: "hub",
  });
});
```

- [ ] **Step 2: Run server tests and verify RED**

Run:

```powershell
npx vitest run test/server.test.ts test/toolMeta.test.ts
```

Expected: FAIL because `update_todo` remains registered and `todos` only lists.

- [ ] **Step 3: Merge schemas under `todos`**

Use one top-level shape compatible with the existing metadata helper:

```ts
todos: {
  operation: z.enum(["list", "create", "update"]).optional(),
  container,
  module: moduleArg,
  status: z.enum(["open", "completed", "custom", "all"]).optional(),
  labels: z.array(z.string()).optional(),
  labelMode: z.enum(["any", "all"]).optional(),
  priorities: z.array(todoPriority).optional(),
  dueAfter: z.string().optional(),
  dueBefore: z.string().optional(),
  overdue: z.boolean().optional(),
  query: z.string().optional(),
  text: z.string().optional(),
  entrySummary: z.string().optional(),
  observation: z.string().optional(),
  ref: z.string().optional(),
  completed: z.boolean().optional(),
  due: z.string().nullable().optional(),
  priority: todoPriority.nullable().optional(),
  apply: z.boolean().optional(),
},
```

Delete the `update_todo` shape. Conditional validation stays in the dispatcher/service and returns the repository's existing `INVALID_ARGUMENT` errors.

- [ ] **Step 4: Replace two registrations with one dispatcher**

Define a local union `TodosArgs` and dispatch:

```ts
const operation = args.operation ?? "list";
if (operation === "list") {
  const result = await todos.list(toTodoQuery(args));
  return ok(formatTodos(result.tasks, result.counts), {
    operation: "list",
    tasks: result.tasks,
    warnings: result.warnings,
    counts: result.counts,
  });
}

const result = await todos.mutate(
  operation === "create" ? toCreateInput(args) : toUpdateInput(args),
);
if (!result.applied) {
  return ok(`Proposed todo ${operation}: ${result.preview.line}`, result);
}
return ok(describeAppliedMutation(result), result);
```

Register only `todos`, with:

```ts
annotations: { readOnlyHint: false, openWorldHint: false },
_meta: { ui: { resourceUri: TODO_APP_URI, visibility: ["model", "app"] } },
```

- [ ] **Step 5: Rewrite tool metadata and remove the obsolete resource**

Document `operation`, mutation fields, and `apply`. State:

```markdown
List, preview, create, or update Markdown todos in memory modules. `operation`
defaults to `list`. Create and update return a preview without writing unless
`apply: true` is supplied. Agent-driven requests present that preview and obtain
confirmation before applying; MCP App checkbox clicks may apply directly.
```

Delete `resources/tool-meta/update_todo.md`.

- [ ] **Step 6: Update server and metadata tests**

Remove all `update_todo` title, annotation, visibility, metadata, and conditional-error expectations. Move equivalent conditional cases to `todos` operations. Assert previews do not create files and applied calls do.

- [ ] **Step 7: Run targeted tests**

Run:

```powershell
npx vitest run test/server.test.ts test/toolMeta.test.ts test/todo-service.test.ts
npm run typecheck:server
```

Expected: all targeted tests pass.

- [ ] **Step 8: Commit**

```powershell
git add src\server\toolSchemas.ts src\server\todoTools.ts resources\tool-meta\todos.md test\server.test.ts test\toolMeta.test.ts
git rm resources\tool-meta\update_todo.md
git commit -m "refactor: unify todo MCP operations"
```

### Task 3: Update skills, routing, MCP App, and documentation

**Files:**
- Modify: `resources/module-types/memory/skills/todo/SKILL.md`
- Modify: `resources/module-types/memory/skills/remember/SKILL.md`
- Modify: `resources/prompts/instructions.md`
- Modify: `app/todos/main.ts`
- Modify: `test/run.test.ts`
- Modify: `test/prompts.test.ts`
- Modify: `test/todo-app.test.ts`
- Modify: `README.md`
- Modify: `CONTEXT.md`

- [ ] **Step 1: Write failing skill and prompt tests**

Assert both skills contain:

```ts
expect(todo.body).toContain('todos { operation: "update"');
expect(todo.body).toContain("without `apply`");
expect(todo.body).toContain("needsConfirmation");
expect(todo.body).toContain("apply: true");
expect(todo.body).not.toContain("update_todo");
```

For `remember`, assert `operation: "create"`, preview, confirmation, apply, and sync. Update prompt tests to assert all todo API operations use `todos` and remove exact mandatory `run(todo)` gateway wording.

- [ ] **Step 2: Run skill/prompt tests and verify RED**

Run:

```powershell
npx vitest run test/run.test.ts test/prompts.test.ts
```

Expected: FAIL on old `update_todo` instructions.

- [ ] **Step 3: Rewrite the `todo` skill**

Its mutation sequence must be:

```markdown
1. Call scoped `todos { operation: "list", container, module }`.
2. Resolve exactly one task ref, or clarify.
3. Call `todos` with `operation: "create"` or `"update"` and omit `apply`.
4. Present the returned preview exactly and require confirmation.
5. After confirmation, repeat the same mutation with `apply: true`.
6. Call `sync` for the affected container.
```

Keep deletion, task-text renaming, recurrence, dependencies, and custom-status mutation out of scope.

- [ ] **Step 4: Rewrite the todo-bearing `remember` branch**

After label/date/priority inference, call:

```json
{
  "operation": "create",
  "container": "...",
  "module": "...",
  "text": "...",
  "entrySummary": "...",
  "observation": "...",
  "labels": ["..."]
}
```

Present the preview, confirm, repeat with `"apply": true`, then sync.

- [ ] **Step 5: Simplify global routing**

Keep:

- list/filter/check requests call `todos`;
- explicit “remember” requests use `remember`;
- other natural-language todo management uses the `todo` skill;
- every deterministic todo operation is performed through `todos`.

Remove references to `update_todo` and wording that treats skill invocation as tool authorization.

- [ ] **Step 6: Update the MCP App call**

Replace:

```ts
app.callServerTool({
  name: "update_todo",
  arguments: { operation: "patch", ref, completed },
});
```

with:

```ts
app.callServerTool({
  name: "todos",
  arguments: { operation: "update", ref, completed, apply: true },
});
```

Refresh with `{ operation: "list" }`. Update `TodoUpdateResult` guards to the new applied result union.

- [ ] **Step 7: Update app tests and docs**

Add a source-level bundled-app assertion that the emitted HTML contains `"operation":"update"`/`apply:true` behavior and does not contain `update_todo`. Update README and CONTEXT tool tables, examples, tool count, preview/apply semantics, and app-local sync behavior.

- [ ] **Step 8: Run targeted tests and build**

Run:

```powershell
npx vitest run test/run.test.ts test/prompts.test.ts test/todo-app.test.ts test/server.test.ts
npm run build:app
npm run typecheck
```

Expected: all targeted tests pass and the app bundle builds.

- [ ] **Step 9: Commit**

```powershell
git add resources\module-types\memory\skills\todo\SKILL.md resources\module-types\memory\skills\remember\SKILL.md resources\prompts\instructions.md app\todos\main.ts test\run.test.ts test\prompts.test.ts test\todo-app.test.ts README.md CONTEXT.md
git commit -m "feat: route todo workflows through unified API"
```

### Task 4: Replace skill-gateway evals with preview-confirm-apply evals

**Files:**
- Modify: `eval/copilot.ts`
- Modify: `eval/provider/copilotProvider.ts`
- Modify: `eval/assertions/checks.ts`
- Modify: `eval/assertions/judge.ts`
- Modify: `eval/scenarios/todo/complete.yaml`
- Modify: `eval/scenarios/remember/todo.yaml`
- Modify: `eval-test/copilot.test.ts`
- Modify: `eval-test/provider.test.ts`
- Modify: `eval-test/checks.test.ts`
- Modify: `eval-test/judge-assertion.test.ts`

- [ ] **Step 1: Write failing structured-event tests**

Extend the event fixture with matching start/complete events and assert:

```ts
expect(parsed.toolEvents).toEqual([{
  server: "open-knowledge-hub",
  name: "todos",
  arguments: { operation: "update", ref: "r1", completed: true },
  success: true,
}]);
```

Add a resumed-conversation test asserting aggregated events include `turn: 1` for preview and `turn: 2` for apply/sync.

- [ ] **Step 2: Write failing `todo-preview-apply` check tests**

The authoritative check should pass:

```ts
[
  { turn: 1, name: "todos", arguments: { operation: "update", ref: "r1", completed: true }, success: true },
  { turn: 2, name: "todos", arguments: { operation: "update", ref: "r1", completed: true, apply: true }, success: true },
  { turn: 2, name: "sync", arguments: { container: "kb-hub" }, success: true },
]
```

It must fail when:

- `apply: true` occurs on turn 1;
- preview is missing;
- preview and apply mutation fields differ;
- preview or apply failed;
- sync is missing, failed, or precedes apply.

- [ ] **Step 3: Run focused eval tests and verify RED**

Run:

```powershell
npx vitest run --config vitest.eval.config.ts eval-test/copilot.test.ts eval-test/provider.test.ts eval-test/checks.test.ts eval-test/judge-assertion.test.ts
```

Expected: FAIL because tool events lack completion success/turn and the check does not exist.

- [ ] **Step 4: Preserve structured event success and turn**

Use `toolCallId` to update the corresponding start event on `tool.execution_complete`:

```ts
export interface ToolEvent {
  server: string;
  name: string;
  arguments: unknown;
  success?: boolean;
  turn?: number;
}
```

When aggregating conversation turns:

```ts
toolEvents.push(...r.toolEvents.map((event) => ({ ...event, turn: turns.length })));
```

Pass these untruncated events through provider metadata.

- [ ] **Step 5: Replace `todo-workflow` with `todo-preview-apply`**

Define:

```ts
| { kind: "todo-preview-apply"; operation: "create" | "update" }
```

Filter successful `todos` mutation events and compare preview/apply arguments after removing `apply`. Require preview on an earlier turn, applied mutation on a later turn, and successful `sync` after apply. Use `isDeepStrictEqual` for argument comparison. Make this deterministic check authoritative in `judge.ts`; remove the current `todo-workflow` authorization logic and its tests.

- [ ] **Step 6: Rewrite live scenarios**

For completion:

```yaml
config: { expect: [todos, sync] }
```

and:

```yaml
- id: previewed-confirmed-applied
  text: The agent previews the exact completion without writing, waits for confirmation, applies the same update, and then syncs.
  check: { kind: todo-preview-apply, operation: update }
```

Keep the final `todo-markdown` assertion. Make `run(todo)` advisory at most; do not gate success on it.

For remembered todo creation, require the `remember` skill separately because it carries observation/entry-summary behavior, then use `{ kind: todo-preview-apply, operation: create }` for mutation safety.

- [ ] **Step 7: Run eval unit validation, not live e2e**

Run:

```powershell
npm run typecheck:eval
npm run test:eval
npm run eval:validate
```

Expected: all eval unit tests and structural validation pass. Do **not** run `npm run eval` during development.

- [ ] **Step 8: Commit**

```powershell
git add eval\copilot.ts eval\provider\copilotProvider.ts eval\assertions\checks.ts eval\assertions\judge.ts eval\scenarios\todo\complete.yaml eval\scenarios\remember\todo.yaml eval-test\copilot.test.ts eval-test\provider.test.ts eval-test\checks.test.ts eval-test\judge-assertion.test.ts
git commit -m "test(eval): verify todo preview and apply workflow"
```

### Task 5: Remove obsolete references and validate the complete feature

**Files:**
- Modify as found: repository files still containing `update_todo`
- Verify: package contents and git diff

- [ ] **Step 1: Search for obsolete references**

Run:

```powershell
rg -n "update_todo|operation:\s*\"patch\"" --glob "!node_modules/**"
```

Expected: only historical design/plan references explicitly describing removal are allowed. Remove runtime, test, docs, resource, and eval references.

- [ ] **Step 2: Run the complete non-e2e validation suite**

Run:

```powershell
npm test
npm run build
npm run typecheck
npm run typecheck:eval
npm run test:eval
npm run eval:validate
```

Expected: core and eval suites pass, builds/typechecks are clean, and promptfoo reports `Configuration is valid.`

- [ ] **Step 3: Request final code review**

Review the complete diff against:

```text
docs/superpowers/specs/2026-07-10-memory-todo-design.md
```

Fix every Critical and Important issue, then rerun the smallest affected validation commands.

- [ ] **Step 4: Run the one PR-readiness e2e evaluation**

Only after implementation and review are complete:

```powershell
npm run build
npm run eval
```

Expected: all live scenarios pass. Ignore unrelated scenario failures only if the user explicitly accepts them; the two todo mutation scenarios must pass their deterministic preview/apply and on-disk assertions.

- [ ] **Step 5: Verify package and diff**

Run:

```powershell
npm pack --dry-run
git --no-pager diff --check
git --no-pager status --short
```

Expected: the package includes the bundled Todo App, server output, resources, and memory skills; no whitespace errors; only intentional changes remain.

- [ ] **Step 6: Commit final cleanup**

```powershell
git add -A
git commit -m "chore: finish unified todos API"
```

