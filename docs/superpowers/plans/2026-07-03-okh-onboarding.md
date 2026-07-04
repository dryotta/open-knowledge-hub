# OKH Onboarding Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make first-run onboarding smooth and safe — `add` previews any on-disk change and only applies with `create:true`; a customizable `hub` wake phrase and an `onboard` flow guide setup — and lock it in with unit tests, e2e scenarios, and a user-facing `USAGE.md`.

**Architecture:** OKH stays a deterministic MCP server (no LLM) that returns discipline text. `add` gains a plan/apply split gated by a `create` flag. A new `preferences.json` under `$OKH_HOME` stores a wake phrase that the server announces in its dynamic `instructions`. A dual `onboard` prompt+tool guides setup and persists the phrase. The e2e harness gains empty/unregistered provisioning modes and onboarding scenarios (including cloning a real private GitHub repo).

**Tech Stack:** TypeScript NodeNext ESM (relative imports use `.js`), `@modelcontextprotocol/sdk`, `zod` v4, `yaml`, Vitest (core: `vitest.config.ts`; eval: `vitest.eval.config.ts`), real `git`/`gh`.

Design spec: `docs/superpowers/specs/2026-07-03-okh-onboarding-design.md`

Verification commands used throughout:
- Core suite: `npm run typecheck` and `npm test`
- Single core file: `npx vitest run test/<file>.test.ts`
- Eval suite: `npm run typecheck:eval` and `npm run test:eval`
- Single eval file: `npx vitest run --config vitest.eval.config.ts eval-test/<file>.test.ts`

Commit after every task (`--no-verify` is unnecessary; there are no git hooks). Include the trailer:
`Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`

---

## File Structure

**Product (src/):**
- **Modify** `src/container/service.ts` — split `addContainer`/`addModule` into pure planners + appliers; add `create` to inputs; return discriminated `AddContainerOutcome`/`AddModuleOutcome`; create a non-existent local folder on apply.
- **Modify** `src/server/tools.ts` — `create` field + preview formatting for `add`; tool `annotations`; register the `onboard` tool; take `paths`.
- **Modify** `src/server/prompts.ts` — register the `onboard` prompt; take `paths`.
- **Modify** `src/server/index.ts` — dynamic `instructions` announcing the wake phrase; pass `paths` to registrars.
- **Modify** `src/prompts/index.ts` — `buildOnboard(targets, wakePhrase)`.
- **Modify** `src/prompts/discipline.ts` — add `"onboard"` to `DisciplineDoc`.
- **Create** `src/preferences.ts` — `Preferences` schema, `loadPreferences`/`loadPreferencesSync`/`savePreferences`, `DEFAULT_WAKE_PHRASE`, `wakePhraseSchema`.
- **Modify** `src/config.ts` — add `preferencesFile` to `OkhPaths` + `resolvePaths`.
- **Create** `resources/discipline/onboard.md` — onboarding discipline text.

**Product tests (test/):**
- **Create** `test/add-confirm.test.ts` — the full `add` preview/confirm matrix (service layer).
- **Create** `test/preferences.test.ts` — preferences load/save + defaults.
- **Modify** `test/service.test.ts` — update cases that assumed auto-scaffold / `NOT_FOUND` to the new outcome shape.
- **Modify** `test/inspect.test.ts` — pass `create:true` where cases actually register/create.
- **Modify** `test/server.test.ts` — surface = 9 tools + 6 prompts; `add` preview vs applied; annotations; `onboard`.

**Harness (eval/, eval-test/):**
- **Modify** `eval/provision.ts` — `mode` (`registered` | `empty` | `unregistered-local`) + optional `additional` local containers.
- **Modify** `eval/okh-eval.ts` — `ScenarioTest.vars.provision`; tolerant `runChecks`; register new side-effect assertions.
- **Modify** `eval/provider/copilotProvider.ts` — forward `vars.provision`.
- **Create** `eval/assertions/container-registered.ts`, `eval/assertions/manifest-initialized.ts`, `eval/assertions/wake-phrase-set.ts`.
- **Create** `eval/fixtures/plain-notes/` — a manifest-less local fixture.
- **Create** scenario dirs under `eval/scenarios/`: `onboard-create-local`, `onboard-add-existing-folder`, `onboard-add-github`, `onboard-explains`, `onboard-wake-phrase`, `ask-multi-container`.
- **Modify** `eval-test/provision.test.ts` — cover the new modes.

**Docs:**
- **Create** `USAGE.md`; **Modify** `README.md`, `eval/README.md`, `eval/MANUAL-TESTING.md`.

**Test GitHub repo:** private `dryotta/okh-eval-hub` created via `gh` (Phase F).

---

## Phase A — `add` preview/confirm (service layer)

### Task A1: Container plan/apply types + `create` field

**Files:**
- Modify: `src/container/service.ts`
- Test: `test/add-confirm.test.ts` (created here)

- [ ] **Step 1: Write the failing test**

Create `test/add-confirm.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { rm, stat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ContainerService } from "../src/container/service.js";
import { Git } from "../src/git/git.js";
import { Gh } from "../src/git/gh.js";
import { loadRegistry } from "../src/registry/registry.js";
import { manifestExists } from "../src/container/manifest.js";
import { makePaths, makeTempDir, makeOrigin, testRun } from "./helpers.js";

class FakeGh {
  async createRepo(): Promise<string> { return "x"; }
  async createPr(): Promise<string> { return "x"; }
}

const cleanups: string[] = [];
async function setup() {
  const home = await makeTempDir(); cleanups.push(home);
  const paths = makePaths(home);
  const service = new ContainerService(paths, new Git(testRun), new FakeGh() as unknown as Gh);
  return { paths, service };
}
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

describe("addContainer preview/confirm", () => {
  it("previews (no side effects) for a non-existent folder without create", async () => {
    const { service, paths } = await setup();
    const target = join(paths.home, "new-hub"); // does not exist
    const out = await service.addContainer({ source: target, name: "new-hub" });
    expect(out.kind).toBe("plan");
    if (out.kind === "plan") {
      expect(out.plan.actions).toContain("create-folder");
      expect(out.plan.actions).toContain("init-manifest");
    }
    await expect(stat(target)).rejects.toBeTruthy(); // folder NOT created
    expect((await loadRegistry(paths)).containers).toHaveLength(0); // NOT registered
  });

  it("creates the folder + manifest + registers with create:true", async () => {
    const { service, paths } = await setup();
    const target = join(paths.home, "new-hub");
    const out = await service.addContainer({ source: target, name: "new-hub", create: true });
    expect(out.kind).toBe("applied");
    expect((await stat(target)).isDirectory()).toBe(true);
    expect(await manifestExists(target)).toBe(true);
    expect((await loadRegistry(paths)).containers[0]!.name).toBe("new-hub");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/add-confirm.test.ts`
Expected: FAIL — `out.kind` is not `"plan"` (today `addContainer` returns a `ContainerEntry` and throws `NOT_FOUND` for a missing dir).

- [ ] **Step 3: Add the outcome types and split the container impl**

In `src/container/service.ts`, add these exports near the other interfaces (after `AddContainerInput`):

```ts
export type ContainerAction = "create-folder" | "clone" | "init-manifest";

export interface AddContainerPlan {
  kind: "container";
  actions: ContainerAction[];
  name: string;
  backend: Backend;
  source: string;
  /** Absolute local path to create / clone into / register. */
  target: string;
  /** Effective sync mode used when initializing a new manifest. */
  sync: SyncMode;
  /** Whether the caller explicitly set sync (controls overriding an existing manifest). */
  syncExplicit: boolean;
}

export type AddContainerOutcome =
  | { kind: "plan"; plan: AddContainerPlan }
  | { kind: "applied"; entry: ContainerEntry };
```

Add `create` to `AddContainerInput`:

```ts
export interface AddContainerInput {
  source: string;
  name?: string;
  sync?: "auto" | "pr";
  backend?: "local" | "onedrive";
  /** Authorize side-effectful creation/initialization. Default false => preview only. */
  create?: boolean;
}
```

Replace the existing `addContainer` + `addContainerImpl` with:

```ts
  addContainer(input: AddContainerInput): Promise<AddContainerOutcome> {
    return this.mutex.run(() => this.addContainerImpl(input));
  }

  /** Resolve what `add` would do, with no side effects. Throws on doomed actions. */
  async planAddContainer(input: AddContainerInput): Promise<AddContainerPlan> {
    const isGit = looksLikeGitUrl(input.source);
    const name = validate(containerNameSchema, input.name ?? deriveName(input.source), "name");
    const reg = await loadRegistry(this.paths);
    if (findContainer(reg, name)) {
      throw new OkhError("ALREADY_EXISTS", `A container named "${name}" already exists.`);
    }
    const sync: SyncMode = input.sync ?? "auto";
    const syncExplicit = input.sync !== undefined;
    if (isGit) {
      validate(repoUrlSchema, input.source, "source");
      return {
        kind: "container",
        actions: ["clone"],
        name,
        backend: "git",
        source: input.source,
        target: containerCloneDir(this.paths, name),
        sync,
        syncExplicit,
      };
    }
    const backend: Backend = input.backend ?? "local";
    const target = resolve(input.source);
    const s = await stat(target).catch(() => null);
    if (s && !s.isDirectory()) {
      throw new OkhError("INVALID_ARGUMENT", `Path "${input.source}" exists but is not a directory.`);
    }
    const exists = !!s;
    const actions: ContainerAction[] = [];
    if (!exists) actions.push("create-folder");
    if (!exists || !(await manifestExists(target))) actions.push("init-manifest");
    return { kind: "container", actions, name, backend, source: input.source, target, sync, syncExplicit };
  }

  private async addContainerImpl(input: AddContainerInput): Promise<AddContainerOutcome> {
    const plan = await this.planAddContainer(input);
    if (plan.actions.length > 0 && !input.create) return { kind: "plan", plan };
    return { kind: "applied", entry: await this.applyAddContainer(plan) };
  }

  private async applyAddContainer(plan: AddContainerPlan): Promise<ContainerEntry> {
    const reg = await loadRegistry(this.paths);
    if (findContainer(reg, plan.name)) {
      throw new OkhError("ALREADY_EXISTS", `A container named "${plan.name}" already exists.`);
    }
    let origin: string | undefined;
    if (plan.backend === "git") {
      origin = plan.source;
      await this.assertDirAvailable(plan.target);
      await mkdir(this.paths.containersDir, { recursive: true });
      try {
        await this.git.clone(plan.source, plan.target);
      } catch (err) {
        await rm(plan.target, { recursive: true, force: true });
        throw err;
      }
    } else {
      await mkdir(plan.target, { recursive: true });
    }
    if (!(await manifestExists(plan.target))) {
      await saveContainerManifest(plan.target, { ...scaffoldManifest(plan.name), sync: plan.sync });
    } else if (plan.syncExplicit) {
      const m = await loadContainerManifest(plan.target);
      await saveContainerManifest(plan.target, { ...m, sync: plan.sync });
    }
    const entry: ContainerEntry = {
      name: plan.name,
      backend: plan.backend,
      ...(origin ? { origin } : {}),
      localPath: plan.target,
      addedAt: new Date().toISOString(),
    };
    await saveRegistry(this.paths, withContainerAdded(reg, entry));
    return entry;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/add-confirm.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Commit**

```bash
git add src/container/service.ts test/add-confirm.test.ts
git commit -m "feat(add): preview/confirm container add with create flag"
```

### Task A2: Module plan/apply + `create`

**Files:**
- Modify: `src/container/service.ts`
- Test: `test/add-confirm.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/add-confirm.test.ts`:

```ts
describe("addModule preview/confirm", () => {
  it("previews (no side effects) without create", async () => {
    const { service, paths } = await setup();
    const dir = await makeTempDir(); cleanups.push(dir);
    await service.addContainer({ source: dir, name: "hub", create: true });
    const out = await service.addModule({ container: "hub", path: "kb", type: "knowledge" });
    expect(out.kind).toBe("plan");
    await expect(stat(join(dir, "kb"))).rejects.toBeTruthy(); // folder NOT created
  });

  it("creates folder + scaffold + manifest entry with create:true", async () => {
    const { service } = await setup();
    const dir = await makeTempDir(); cleanups.push(dir);
    await service.addContainer({ source: dir, name: "hub", create: true });
    const out = await service.addModule({ container: "hub", path: "kb", type: "knowledge", create: true });
    expect(out.kind).toBe("applied");
    if (out.kind === "applied") {
      expect((await stat(join(out.moduleRoot, "index.md"))).isFile()).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/add-confirm.test.ts -t "addModule preview"`
Expected: FAIL — `addModule` returns `{ entry, moduleRoot }`, not `{ kind: "plan" }`.

- [ ] **Step 3: Split the module impl**

In `src/container/service.ts`, add `create` to `AddModuleInput`:

```ts
export interface AddModuleInput {
  container: string;
  path: string;
  type: ModuleType;
  config?: Record<string, unknown>;
  create?: boolean;
}
```

Add module outcome types near `AddContainerOutcome`:

```ts
export type ModuleAction = "init-manifest" | "create-folder" | "scaffold";

export interface AddModulePlan {
  kind: "module";
  actions: ModuleAction[];
  container: string;
  path: string;
  type: ModuleType;
  moduleRoot: string;
  config?: Record<string, unknown>;
}

export type AddModuleOutcome =
  | { kind: "plan"; plan: AddModulePlan }
  | { kind: "applied"; entry: ModuleEntry; moduleRoot: string };
```

Add a read-only manifest helper next to `loadOrScaffold`:

```ts
  /** In-memory manifest for planning: never writes. Missing file => empty scaffold. */
  protected async loadManifestOrEmpty(root: string, name: string): Promise<ContainerManifest> {
    if (await manifestExists(root)) return loadContainerManifest(root);
    return scaffoldManifest(name);
  }
```

Replace `addModule` + `addModuleImpl` with:

```ts
  addModule(input: AddModuleInput): Promise<AddModuleOutcome> {
    return this.mutex.run(() => this.addModuleImpl(input));
  }

  async planAddModule(input: AddModuleInput): Promise<AddModulePlan> {
    validate(modulePathSchema, input.path, "module path");
    validate(moduleTypeSchema, input.type, "module type");
    const reg = await loadRegistry(this.paths);
    const container = requireContainer(reg, input.container);
    const root = container.localPath;
    const manifest = await this.loadManifestOrEmpty(root, container.name);
    if (manifest.modules.some((m) => m.path === input.path)) {
      throw new OkhError(
        "ALREADY_EXISTS",
        `Module path "${input.path}" already exists in container "${input.container}".`,
      );
    }
    const moduleRoot = this.moduleRoot(root, input.path);
    const actions: ModuleAction[] = [];
    if (!(await manifestExists(root))) actions.push("init-manifest");
    const modDir = await stat(moduleRoot).then((s) => s.isDirectory()).catch(() => false);
    if (!modDir) actions.push("create-folder");
    if (getLoader(input.type).scaffold) actions.push("scaffold");
    return {
      kind: "module",
      actions,
      container: input.container,
      path: input.path,
      type: input.type,
      moduleRoot,
      ...(input.config ? { config: input.config } : {}),
    };
  }

  private async addModuleImpl(input: AddModuleInput): Promise<AddModuleOutcome> {
    const plan = await this.planAddModule(input);
    if (plan.actions.length > 0 && !input.create) return { kind: "plan", plan };
    return { kind: "applied", ...(await this.applyAddModule(plan)) };
  }

  private async applyAddModule(plan: AddModulePlan): Promise<{ entry: ModuleEntry; moduleRoot: string }> {
    const reg = await loadRegistry(this.paths);
    const container = requireContainer(reg, plan.container);
    const root = container.localPath;
    const manifest = await this.loadOrScaffold(root, container.name);
    if (manifest.modules.some((m) => m.path === plan.path)) {
      throw new OkhError(
        "ALREADY_EXISTS",
        `Module path "${plan.path}" already exists in container "${plan.container}".`,
      );
    }
    await mkdir(plan.moduleRoot, { recursive: true });
    const loader = getLoader(plan.type);
    if (loader.scaffold) {
      try {
        await loader.scaffold(plan.moduleRoot);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
    }
    const entry: ModuleEntry = {
      path: plan.path,
      type: plan.type,
      ...(plan.config ? { config: plan.config } : {}),
    };
    await saveContainerManifest(root, { ...manifest, modules: [...manifest.modules, entry] });
    return { entry, moduleRoot: plan.moduleRoot };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/add-confirm.test.ts`
Expected: PASS (all four `add-confirm` groups).

- [ ] **Step 5: Commit**

```bash
git add src/container/service.ts test/add-confirm.test.ts
git commit -m "feat(add): preview/confirm module add with create flag"
```

### Task A3: Git preview + existing-hub fast path

**Files:**
- Test: `test/add-confirm.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `test/add-confirm.test.ts`:

```ts
describe("addContainer git + existing-hub", () => {
  it("previews a git url without cloning", async () => {
    const origin = await makeOrigin();
    const { service, paths } = await setup();
    const out = await service.addContainer({ source: origin, name: "gh" });
    expect(out.kind).toBe("plan");
    if (out.kind === "plan") expect(out.plan.actions).toEqual(["clone"]);
    await expect(stat(join(paths.containersDir, "gh"))).rejects.toBeTruthy(); // nothing cloned
    expect((await loadRegistry(paths)).containers).toHaveLength(0);
  });

  it("clones + registers a git url with create:true", async () => {
    const origin = await makeOrigin();
    const { service, paths } = await setup();
    const out = await service.addContainer({ source: origin, name: "gh", create: true });
    expect(out.kind).toBe("applied");
    if (out.kind === "applied") expect(out.entry.backend).toBe("git");
    expect((await loadRegistry(paths)).containers[0]!.name).toBe("gh");
  });

  it("registers an existing hub (manifest present) in one call, no create needed", async () => {
    const dir = await makeTempDir(); cleanups.push(dir);
    await mkdir(join(dir, ".okh"), { recursive: true });
    await writeFile(join(dir, ".okh", "okh.yaml"), "name: prebuilt\nsync: auto\nmodules: []\n", "utf8");
    const { service, paths } = await setup();
    const out = await service.addContainer({ source: dir, name: "prebuilt" });
    expect(out.kind).toBe("applied"); // actions empty => applied without create
    expect((await loadRegistry(paths)).containers[0]!.name).toBe("prebuilt");
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `npx vitest run test/add-confirm.test.ts`
Expected: PASS — the Task A1 logic already handles these (git => `["clone"]` gated by create; existing manifest => `actions` empty => applied). This task documents/locks those paths.

- [ ] **Step 3: Commit**

```bash
git add test/add-confirm.test.ts
git commit -m "test(add): cover git preview and existing-hub fast path"
```

### Task A4: Update existing service/inspect tests to the new outcome shape

**Files:**
- Modify: `test/service.test.ts`
- Modify: `test/inspect.test.ts`

- [ ] **Step 1: Run the suites to see the failures**

Run: `npx vitest run test/service.test.ts test/inspect.test.ts`
Expected: FAIL — many cases call `addContainer(...)`/`addModule(...)` and read `.backend`/`.origin`/`moduleRoot` directly, which now live under `.entry`; the "registers a local folder in place" and "rejects a local source that does not exist" cases assert old behavior.

- [ ] **Step 2: Update `test/service.test.ts`**

Every `addContainer`/`addModule` call that intends to actually create/register must pass `create: true`, and reads must go through the outcome. Apply these edits:

Replace the `addContainer` describe block body so each creating call asserts through `entry`. Concretely, change each call of the form:

```ts
const entry = await service.addContainer({ source: dir, name: "notes" });
```
to:
```ts
const out = await service.addContainer({ source: dir, name: "notes", create: true });
if (out.kind !== "applied") throw new Error("expected applied");
const entry = out.entry;
```

Do the same for the git clone case, the onedrive case, the derived-name case (`{ source: origin, create: true }`), and the sync-mode case.

Change the "rejects a local source that does not exist" test to assert the new create-folder behavior:

```ts
  it("creates a non-existent local folder when create:true", async () => {
    const { service } = await setup();
    const dir = join(await makeTempDir(), "fresh"); cleanups.push(dir);
    const out = await service.addContainer({ source: dir, name: "x", create: true });
    expect(out.kind).toBe("applied");
    expect((await stat(dir)).isDirectory()).toBe(true);
  });
```

Change the "rejects a duplicate container name" test so the first add uses `create: true`, and the duplicate is detected at plan time (no create needed):

```ts
    await service.addContainer({ source: dir, name: "dup", create: true });
    const dir2 = await makeTempDir(); cleanups.push(dir2);
    await expect(service.addContainer({ source: dir2, name: "dup" })).rejects.toBeInstanceOf(OkhError);
```

In the `addModule` describe block, make every creating call pass `create: true` and read via the outcome. Change:

```ts
const { moduleRoot } = await service.addModule({ container: "hub", path: "kb", type: "knowledge" });
```
to:
```ts
const out = await service.addModule({ container: "hub", path: "kb", type: "knowledge", create: true });
if (out.kind !== "applied") throw new Error("expected applied");
const { moduleRoot } = out;
```

Also update the `addContainer({ source: dir, name: "hub" })` setup lines inside `addModule` tests to include `create: true`. For the "rejects a duplicate module path" test, add the first module with `create: true`, then expect the duplicate to reject. For "rejects a module on an unknown container", no create needed (rejects at plan). For "treats an existing knowledge index as already scaffolded", pass `create: true` on the `addModule` call.

- [ ] **Step 3: Update `test/inspect.test.ts`**

Every `addContainer`/`addModule` in this file is setup for status/validate/inspect and must actually create. Add `create: true` to all of them, e.g.:

```ts
await service.addContainer({ source: origin, name: "hub", create: true });
await service.addModule({ container: "hub", path: "kb", type: "knowledge", create: true });
```

Apply to: the "reports git status" test, "omits git status for a local container", both `validate` tests, and all three `inspect` tests. These calls ignore the return value, so only the arguments change.

- [ ] **Step 4: Run to verify green**

Run: `npx vitest run test/service.test.ts test/inspect.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add test/service.test.ts test/inspect.test.ts
git commit -m "test(add): migrate service/inspect tests to preview/confirm outcomes"
```

---

## Phase B — `add` tool layer + annotations

### Task B1: `create` field, preview formatting, and `add` handler wiring

**Files:**
- Modify: `src/server/tools.ts`
- Test: `test/server.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/server.test.ts`, add these tests inside the `describe("MCP server surface", ...)` block. Add a helper to read `structuredContent` at the top of the file (after `promptText`):

```ts
function structuredOf(res: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  return ("structuredContent" in res ? (res as { structuredContent?: Record<string, unknown> }).structuredContent : undefined) ?? {};
}
```

Then the tests:

```ts
  it("add previews (no changes) without create, and applies with create", async () => {
    const { client } = await connect();
    const dir = await makeTempDir();
    cleanups.push(dir);

    const preview = await client.callTool({ name: "add", arguments: { source: dir, name: "hub" } });
    expect(textOf(preview)).toContain("Plan (no changes made)");
    expect(structuredOf(preview).needsConfirmation).toBe(true);

    const applied = await client.callTool({ name: "add", arguments: { source: dir, name: "hub", create: true } });
    expect(textOf(applied)).toContain('Registered container "hub"');
  });
```

Also update the existing round-trip test ("add -> inspect round-trips through the tool interface") to pass `create: true` on both `add` calls:

```ts
    await client.callTool({ name: "add", arguments: { source: dir, name: "hub", create: true } });
    await client.callTool({ name: "add", arguments: { container: "hub", path: "kb", type: "knowledge", create: true } });
```

And update the "the ask prompt returns discipline text" test the same way (add `create: true` to both `add` calls).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server.test.ts -t "add previews"`
Expected: FAIL — no `create` handling; `add` currently registers immediately.

- [ ] **Step 3: Implement the handler + formatters**

In `src/server/tools.ts`, update the type imports at the top to include the new plan types:

```ts
import type {
  ContainerService,
  InspectResult,
  SyncResult,
  AddContainerPlan,
  AddModulePlan,
} from "../container/service.js";
```

Add plan formatters next to `formatInspect`:

```ts
function formatContainerPlan(plan: AddContainerPlan): string {
  const lines = ["Plan (no changes made). Re-run add with create:true to apply:"];
  if (plan.actions.includes("create-folder")) lines.push(`- Create folder: ${plan.target}`);
  if (plan.actions.includes("clone"))
    lines.push(`- Clone ${plan.source} → ${plan.target} (initialize a manifest if the repo has none)`);
  if (plan.actions.includes("init-manifest")) lines.push(`- Initialize manifest: name=${plan.name} sync=${plan.sync}`);
  lines.push(`- Register container "${plan.name}" [${plan.backend}]`);
  return lines.join("\n");
}

function formatModulePlan(plan: AddModulePlan): string {
  const lines = ["Plan (no changes made). Re-run add with create:true to apply:"];
  if (plan.actions.includes("init-manifest")) lines.push(`- Initialize manifest for "${plan.container}"`);
  if (plan.actions.includes("create-folder")) lines.push(`- Create folder: ${plan.moduleRoot}`);
  if (plan.actions.includes("scaffold")) lines.push(`- Scaffold ${plan.type} module content`);
  lines.push(`- Add ${plan.type} module "${plan.path}" to "${plan.container}"`);
  return lines.join("\n");
}
```

In the `add` tool registration, add `create` to `inputSchema`:

```ts
        create: z.boolean().optional().describe("Apply the change. Omit to preview a plan (no changes)."),
```

Add `create` to the handler args type, then update the two branches to use the outcome. Replace the container branch:

```ts
        if (args.source !== undefined) {
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
        }
```

Replace the module branch:

```ts
        if (hasModuleFields) {
          if (args.container === undefined || args.path === undefined || args.type === undefined) {
            return fail("Adding a module requires { container, path, type }.");
          }
          if (isBlank(args.container)) return fail("container cannot be empty.");
          if (isBlank(args.path)) return fail("path cannot be empty.");
          const outcome = await service.addModule({
            container: args.container,
            path: args.path,
            type: args.type,
            ...(args.config ? { config: args.config } : {}),
            ...(args.create ? { create: true } : {}),
          });
          if (outcome.kind === "plan") {
            return ok(formatModulePlan(outcome.plan), { plan: outcome.plan, needsConfirmation: true });
          }
          return ok(`Added ${outcome.entry.type} module "${outcome.entry.path}" to "${args.container}" at ${outcome.moduleRoot}.`, { entry: outcome.entry });
        }
```

Add `create?: boolean;` to the handler's inline args type (the object type after `async (args: {`). Update the `add` tool `description` to append: `" By default add returns a plan and makes no changes; show it to the user, get confirmation, then re-call with create:true."`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/tools.ts test/server.test.ts
git commit -m "feat(add): tool-layer preview/confirm and structuredContent"
```

### Task B2: Tool annotations

**Files:**
- Modify: `src/server/tools.ts`
- Test: `test/server.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/server.test.ts`, add:

```ts
  it("declares accurate tool annotations", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations ?? {}]));
    expect(byName.inspect!.readOnlyHint).toBe(true);
    expect(byName.ask!.readOnlyHint).toBe(true);
    expect(byName.add!.openWorldHint).toBe(true);
    expect(byName.sync!.openWorldHint).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server.test.ts -t "annotations"`
Expected: FAIL — annotations undefined.

- [ ] **Step 3: Add `annotations` to each registration**

In `src/server/tools.ts`, add an `annotations` key to each tool's config object (2nd arg of `registerTool`):

- `inspect`: `annotations: { readOnlyHint: true },`
- `add`: `annotations: { openWorldHint: true },`
- `sync`: `annotations: { openWorldHint: true },`
- each of `ask`, `context`, `learn`, `remember`, `reflect` in `registerCognitiveTools`: `annotations: { readOnlyHint: true },`

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/server.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/tools.ts test/server.test.ts
git commit -m "feat(tools): add MCP annotations (readOnly/openWorld hints)"
```

---

## Phase C — Wake-phrase preferences + dynamic instructions

### Task C1: `preferences.ts` module

**Files:**
- Create: `src/preferences.ts`
- Modify: `src/config.ts`
- Modify: `test/helpers.ts`
- Test: `test/preferences.test.ts`

- [ ] **Step 1: Add `preferencesFile` to `OkhPaths`**

In `src/config.ts`, add to the `OkhPaths` interface:

```ts
  /** The per-machine preferences file: <home>/preferences.json. */
  readonly preferencesFile: string;
```

In `resolvePaths`'s returned object add:

```ts
    preferencesFile: join(root, "preferences.json"),
```

`OkhPaths` is constructed as an object literal in several places; adding a
required field breaks each until updated. Update all of them:

- `test/helpers.ts` `makePaths` — add `preferencesFile: join(home, "preferences.json"),`.
- `eval/provision.ts` — the `const paths: OkhPaths = { ... }` literal — add `preferencesFile: join(okhHome, "preferences.json"),`.
- `eval/okh-eval.ts` `runChecks` — the `loadRegistry({ home: okhHome, containersDir: ..., registryFile: ... })` inline object — add `preferencesFile: join(okhHome, "preferences.json"),`.

- [ ] **Step 2: Write the failing test**

Create `test/preferences.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { rm, writeFile } from "node:fs/promises";
import {
  loadPreferences,
  loadPreferencesSync,
  savePreferences,
  DEFAULT_WAKE_PHRASE,
} from "../src/preferences.js";
import { makePaths, makeTempDir } from "./helpers.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function paths() {
  const home = await makeTempDir(); cleanups.push(home);
  return makePaths(home);
}

describe("preferences", () => {
  it("defaults to 'hub' when absent (async + sync)", async () => {
    const p = await paths();
    expect((await loadPreferences(p)).wakePhrase).toBe(DEFAULT_WAKE_PHRASE);
    expect(loadPreferencesSync(p).wakePhrase).toBe(DEFAULT_WAKE_PHRASE);
    expect(DEFAULT_WAKE_PHRASE).toBe("hub");
  });

  it("round-trips a custom phrase", async () => {
    const p = await paths();
    await savePreferences(p, { wakePhrase: "brain" });
    expect((await loadPreferences(p)).wakePhrase).toBe("brain");
    expect(loadPreferencesSync(p).wakePhrase).toBe("brain");
  });

  it("rejects an invalid phrase on save", async () => {
    const p = await paths();
    await expect(savePreferences(p, { wakePhrase: "no spaces" })).rejects.toBeTruthy();
  });

  it("falls back to default on a malformed file", async () => {
    const p = await paths();
    await writeFile(p.preferencesFile, "{ not json", "utf8");
    expect((await loadPreferences(p)).wakePhrase).toBe(DEFAULT_WAKE_PHRASE);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run test/preferences.test.ts`
Expected: FAIL — `src/preferences.js` does not exist.

- [ ] **Step 4: Create `src/preferences.ts`**

```ts
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { OkhPaths } from "./config.js";
import { Mutex } from "./util/mutex.js";

export const DEFAULT_WAKE_PHRASE = "hub";

/** 1-32 chars: a letter, then letters, digits or dashes. */
export const wakePhraseSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{0,31}$/i, "wake phrase must be 1-32 chars: a letter then letters, digits or dashes");

export const preferencesSchema = z
  .object({ wakePhrase: wakePhraseSchema.default(DEFAULT_WAKE_PHRASE) })
  .strict();
export type Preferences = z.infer<typeof preferencesSchema>;

const mutex = new Mutex();

function parseOrDefault(raw: string): Preferences {
  try {
    const parsed = preferencesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : { wakePhrase: DEFAULT_WAKE_PHRASE };
  } catch {
    return { wakePhrase: DEFAULT_WAKE_PHRASE };
  }
}

export async function loadPreferences(paths: OkhPaths): Promise<Preferences> {
  try {
    return parseOrDefault(await readFile(paths.preferencesFile, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { wakePhrase: DEFAULT_WAKE_PHRASE };
    throw err;
  }
}

export function loadPreferencesSync(paths: OkhPaths): Preferences {
  try {
    return parseOrDefault(readFileSync(paths.preferencesFile, "utf8"));
  } catch {
    return { wakePhrase: DEFAULT_WAKE_PHRASE };
  }
}

export function savePreferences(paths: OkhPaths, prefs: Preferences): Promise<void> {
  return mutex.run(async () => {
    const validated = preferencesSchema.parse(prefs);
    await mkdir(dirname(paths.preferencesFile), { recursive: true });
    const tmp = `${paths.preferencesFile}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    await writeFile(tmp, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
    await rename(tmp, paths.preferencesFile);
  });
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run test/preferences.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/preferences.ts src/config.ts test/helpers.ts test/preferences.test.ts
git commit -m "feat(preferences): wake-phrase preferences store"
```

### Task C2: Dynamic server instructions

**Files:**
- Modify: `src/server/index.ts`
- Modify: `test/server.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/server.test.ts`, add an import at the top:

```ts
import { savePreferences } from "../src/preferences.js";
```

Change `connect()` to accept and pass explicit paths so instructions read an isolated preferences file:

```ts
async function connect(): Promise<{ client: Client; home: string }> {
  const home = await makeTempDir();
  cleanups.push(home);
  const paths = makePaths(home);
  const service = new ContainerService(paths, new Git(testRun), new FakeGh() as unknown as Gh);
  const server = buildServer({ service, paths });
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  servers.push(server);
  clients.push(client);
  await Promise.all([client.connect(clientT), server.connect(serverT)]);
  return { client, home };
}
```

(Existing tests that destructure `{ client }` keep working.) Add the test:

```ts
  it("announces the configured wake phrase in server instructions", async () => {
    const home = await makeTempDir();
    cleanups.push(home);
    const paths = makePaths(home);
    await savePreferences(paths, { wakePhrase: "brain" });
    const service = new ContainerService(paths, new Git(testRun), new FakeGh() as unknown as Gh);
    const server = buildServer({ service, paths });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" });
    servers.push(server);
    clients.push(client);
    await Promise.all([client.connect(clientT), server.connect(serverT)]);
    const instructions = client.getInstructions();
    expect(instructions).toContain("brain");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server.test.ts -t "wake phrase in server instructions"`
Expected: FAIL — instructions are static and never mention "brain".

- [ ] **Step 3: Make instructions dynamic**

Replace `src/server/index.ts` with:

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolvePaths, type OkhPaths } from "../config.js";
import { ContainerService } from "../container/service.js";
import { loadPreferencesSync } from "../preferences.js";
import { registerPrompts } from "./prompts.js";
import { registerTools } from "./tools.js";

export interface BuildServerOptions {
  paths?: OkhPaths;
  service?: ContainerService;
}

function buildInstructions(wakePhrase: string): string {
  return (
    "Open Knowledge Hub: organizes agent knowledge and capabilities into containers of typed modules " +
    "(knowledge, skills, tools, memory, project). Use inspect/add/sync to manage containers; use " +
    "ask/context/learn/remember/reflect (prompts or tools) to think with them. Start with the onboard " +
    "tool for first-run setup. `add` previews changes and needs create:true to apply after user confirmation. " +
    `You can address this hub as "${wakePhrase}": when a message begins with "${wakePhrase}" or mentions ` +
    '"the hub" / "knowledge hub", use these tools. Writes are synced via git (commit+push, or pull requests).'
  );
}

/** Construct the fully-wired MCP server. Dependencies are injectable for tests. */
export function buildServer(options: BuildServerOptions = {}): McpServer {
  const paths = options.paths ?? resolvePaths();
  const service = options.service ?? new ContainerService(paths);
  const { wakePhrase } = loadPreferencesSync(paths);
  const server = new McpServer(
    { name: "open-knowledge-hub", version: "0.2.0" },
    { instructions: buildInstructions(wakePhrase) },
  );
  registerTools(server, service, paths);
  registerPrompts(server, service, paths);
  return server;
}
```

Note: `registerTools`/`registerPrompts` now take `paths` (added in Phase D). Until Phase D lands, TypeScript will error on the extra argument — implement Task D2/D3 in the same session before running the full typecheck, or temporarily register without `paths`. Recommended order: do Task D1–D3 immediately after this step, then run typecheck once.

- [ ] **Step 4: Run test to verify it passes (after Phase D)**

Run: `npx vitest run test/server.test.ts` (run after Phase D so the `paths` params exist).
Expected: PASS including the new instructions test.

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts test/server.test.ts
git commit -m "feat(server): announce wake phrase in dynamic instructions"
```

---

## Phase D — `onboard` flow (prompt + tool)

### Task D1: Onboarding discipline + `buildOnboard`

**Files:**
- Create: `resources/discipline/onboard.md`
- Modify: `src/prompts/discipline.ts`
- Modify: `src/prompts/index.ts`

- [ ] **Step 1: Create the discipline text**

Create `resources/discipline/onboard.md`:

```markdown
# Onboarding a new user

You are helping someone who just installed Open Knowledge Hub (OKH). Be brief and
concrete. Do the following in order, one step at a time, checking in with the user.

1. **Explain OKH in two sentences.** It organizes knowledge and capabilities into
   *containers* (a local folder, an OS-synced folder, or a git repo) made of typed
   *modules* (`knowledge`, `skills`, `tools`, `memory`, `project`). You do the
   thinking; OKH stores, validates, and syncs.

2. **Show current state.** The container list above reflects what is registered.
   If none are registered, say so.

3. **Offer to set up the first hub.** Ask which the user wants:
   - an existing folder they already have,
   - a brand-new folder to create from scratch,
   - a git repository (GitHub) to clone.
   Then call `add`. Remember: `add` returns a *plan* and makes no changes by
   default. Show the plan to the user, get an explicit "yes", then call `add`
   again with `create: true`. After a container exists, offer to add a
   `knowledge` module (and others as needed) the same way.

4. **Set the wake phrase.** Tell the user they can address the hub by a short
   *wake phrase* (the current one is shown above; default `hub`). Naming the hub
   makes requests route reliably to these tools — especially `ask`, `learn`,
   `remember`, `context`, `reflect`, which otherwise look like ordinary requests.
   If they want a different phrase, call `onboard { wakePhrase: "<their choice>" }`
   to persist it. It takes effect on the next client restart.
   For the most reliable routing, they can also rename this server's key in their
   MCP client config to the same phrase (client-specific; offer to help).

5. **Point at everyday use.** Once set up, they can say things like
   "<wake phrase>, remember that …", "<wake phrase>, what do we know about …?",
   and "<wake phrase>, sync my hub". See USAGE.md for the full list.

Never create folders, initialize manifests, or sync without explicit confirmation.
```

- [ ] **Step 2: Extend the discipline loader type**

In `src/prompts/discipline.ts`, change:

```ts
export type DisciplineDoc = "context" | "remember" | "reflect" | "onboard";
```

- [ ] **Step 3: Add `buildOnboard`**

In `src/prompts/index.ts`, append:

```ts
export async function buildOnboard(targets: ResolvedContainer[], wakePhrase: string): Promise<string> {
  const discipline = await loadDiscipline("onboard");
  return `# OKH: onboard

**Wake phrase:** \`${wakePhrase}\`

**Current hubs:**
${renderTargets(targets)}

<discipline name="onboard">

${discipline}

</discipline>`;
}
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: may still error until Task D2/D3 use `buildOnboard` and `paths`. That's fine; proceed to D2.

- [ ] **Step 5: Commit**

```bash
git add resources/discipline/onboard.md src/prompts/discipline.ts src/prompts/index.ts
git commit -m "feat(onboard): onboarding discipline text and buildOnboard"
```

### Task D2: `onboard` tool

**Files:**
- Modify: `src/server/tools.ts`
- Test: `test/server.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/server.test.ts`, add:

```ts
  it("onboard returns guidance without args and persists a wake phrase with args", async () => {
    const { client, home } = await connect();

    const guide = await client.callTool({ name: "onboard", arguments: {} });
    expect(textOf(guide)).toContain("OKH: onboard");
    expect(textOf(guide)).toContain("hub"); // default wake phrase

    const set = await client.callTool({ name: "onboard", arguments: { wakePhrase: "brain" } });
    expect(textOf(set)).toContain('Wake phrase set to "brain"');

    const { loadPreferences } = await import("../src/preferences.js");
    expect((await loadPreferences(makePaths(home))).wakePhrase).toBe("brain");

    const bad = await client.callTool({ name: "onboard", arguments: { wakePhrase: "no spaces" } });
    expect(isErrorResult(bad)).toBe(true);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server.test.ts -t "onboard returns guidance"`
Expected: FAIL — no `onboard` tool.

- [ ] **Step 3: Register the tool**

In `src/server/tools.ts`:

Update imports:

```ts
import type { OkhPaths } from "../config.js";
import { loadPreferences, savePreferences, wakePhraseSchema } from "../preferences.js";
import { buildAsk, buildContext, buildLearn, buildOnboard, buildReflect, buildRemember } from "../prompts/index.js";
```

Change the exported signature to accept `paths` and pass it down:

```ts
export function registerTools(server: McpServer, service: ContainerService, paths: OkhPaths): void {
```

At the end of `registerTools`, before it calls `registerCognitiveTools(server, service);`, register onboard:

```ts
  server.registerTool(
    "onboard",
    {
      title: "Onboard / set wake phrase",
      description:
        "Guide first-run setup (explain OKH, inspect, create the first hub). With { wakePhrase } persist a custom phrase to address the hub.",
      inputSchema: {
        wakePhrase: z
          .string()
          .optional()
          .describe("Set a custom wake phrase (1-32 chars: a letter then letters, digits or dashes)."),
      },
      annotations: { openWorldHint: false },
    },
    handler(async (args: { wakePhrase?: string }) => {
      if (args.wakePhrase !== undefined) {
        const parsed = wakePhraseSchema.safeParse(args.wakePhrase);
        if (!parsed.success) {
          return fail(`Invalid wake phrase: ${parsed.error.issues[0]?.message ?? "invalid"}`, "Use 1-32 chars: a letter then letters, digits or dashes.");
        }
        await savePreferences(paths, { wakePhrase: parsed.data });
        return ok(
          `Wake phrase set to "${parsed.data}". It takes effect on the next client restart; you can already say "${parsed.data}, …".`,
          { wakePhrase: parsed.data },
        );
      }
      const { wakePhrase } = await loadPreferences(paths);
      const targets = await service.resolveTargets();
      return ok(await buildOnboard(targets, wakePhrase));
    }),
  );

  registerCognitiveTools(server, service);
```

(Remove the original standalone `registerCognitiveTools(server, service);` line so it is not called twice.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/server.test.ts -t "onboard"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/tools.ts test/server.test.ts
git commit -m "feat(onboard): onboard tool (guidance + persist wake phrase)"
```

### Task D3: `onboard` prompt + surface update

**Files:**
- Modify: `src/server/prompts.ts`
- Test: `test/server.test.ts`

- [ ] **Step 1: Update the surface test (failing)**

In `test/server.test.ts`, change the surface expectations:

```ts
    expect(tools).toEqual(["add", "ask", "context", "inspect", "learn", "onboard", "reflect", "remember", "sync"]);
    // ...
    expect(prompts).toEqual(["ask", "context", "learn", "onboard", "reflect", "remember"]);
```

Add a prompt test:

```ts
  it("exposes the onboard prompt", async () => {
    const { client } = await connect();
    const res = await client.getPrompt({ name: "onboard", arguments: {} });
    expect(promptText(res)).toContain("OKH: onboard");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/server.test.ts -t "onboard prompt"`
Expected: FAIL — no `onboard` prompt; surface count wrong.

- [ ] **Step 3: Register the prompt**

In `src/server/prompts.ts`:

Update imports:

```ts
import type { OkhPaths } from "../config.js";
import { loadPreferences } from "../preferences.js";
import { buildAsk, buildContext, buildLearn, buildOnboard, buildReflect, buildRemember } from "../prompts/index.js";
```

Change the signature:

```ts
export function registerPrompts(server: McpServer, service: ContainerService, paths: OkhPaths): void {
```

At the end of `registerPrompts`, add:

```ts
  server.registerPrompt(
    "onboard",
    {
      title: "Onboard",
      description: "Guide first-run setup and how to set a wake phrase for the hub.",
      argsSchema: {},
    },
    async () => {
      try {
        const { wakePhrase } = await loadPreferences(paths);
        const targets = await service.resolveTargets();
        return message(await buildOnboard(targets, wakePhrase));
      } catch (err) {
        if (isOkhError(err)) return message(`Cannot start this flow: [${err.code}] ${err.message}`);
        throw err;
      }
    },
  );
```

- [ ] **Step 4: Run the full core suite**

Run: `npm run typecheck && npm test`
Expected: PASS — 9 tools, 6 prompts, all prior tests green.

- [ ] **Step 5: Commit**

```bash
git add src/server/prompts.ts test/server.test.ts
git commit -m "feat(onboard): onboard prompt and updated MCP surface"
```

---

## Phase E — E2E harness + scenarios

### Task E1: Provisioning modes (`empty`, `unregistered-local`, `additional`)

**Files:**
- Modify: `eval/provision.ts`
- Modify: `eval-test/provision.test.ts`
- Create: `eval/fixtures/plain-notes/note.md`

- [ ] **Step 1: Create the manifest-less fixture**

Create `eval/fixtures/plain-notes/note.md`:

```markdown
# Notes

Some pre-existing notes with no OKH manifest yet.
```

- [ ] **Step 2: Write the failing test**

In `eval-test/provision.test.ts`, add:

```ts
  it("empty mode registers nothing and leaves an empty registry", async () => {
    const prov = await provision({ scenario: "s", backend: "local", container: "hub", fixtureDir: "unused", repoRoot: "C:/repo", runner: testRun, mode: "empty" });
    cleanups.push(prov.root);
    const reg = JSON.parse(await readFile(join(prov.okhHome, "registry.json"), "utf8"));
    expect(reg.containers).toHaveLength(0);
    expect(prov.containerPath).toBe("");
  });

  it("unregistered-local drops the fixture in the workspace without registering", async () => {
    const fixtureDir = await makeFixture();
    const prov = await provision({ scenario: "s", backend: "local", container: "notes", fixtureDir, repoRoot: "C:/repo", runner: testRun, mode: "unregistered-local" });
    cleanups.push(prov.root);
    const reg = JSON.parse(await readFile(join(prov.okhHome, "registry.json"), "utf8"));
    expect(reg.containers).toHaveLength(0);
    expect(await readFile(join(prov.containerPath, ".okh", "okh.yaml"), "utf8")).toContain("name: hub");
    expect(prov.containerPath.startsWith(prov.workspace)).toBe(true);
  });
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run --config vitest.eval.config.ts eval-test/provision.test.ts`
Expected: FAIL — `mode` is not a known option; behavior unchanged.

- [ ] **Step 4: Implement modes in `eval/provision.ts`**

Add to `ProvisionInput`:

```ts
  /** Registration strategy. Defaults to "registered" (pre-registers the fixture). */
  mode?: "registered" | "empty" | "unregistered-local";
  /** Extra local containers to register (for multi-container scenarios). */
  additional?: Array<{ name: string; fixtureDir: string }>;
```

Add the import for `emptyRegistry` (already imported) and near the top of `provision`, after the isolated homes are created and `paths` is defined, branch by mode. Replace the block that currently sets `entry`/`originPath` and the final `saveRegistry(...)` with:

```ts
  const mode = input.mode ?? "registered";

  if (mode === "empty") {
    await saveRegistry(paths, emptyRegistry());
    await writeMcpConfig(copilotHome, input.repoRoot, okhHome);
    return { root, okhHome, copilotHome, workspace, containerPath: "", originPath: undefined };
  }

  if (mode === "unregistered-local") {
    const dest = join(workspace, input.container);
    await cp(input.fixtureDir, dest, { recursive: true });
    await saveRegistry(paths, emptyRegistry());
    await writeMcpConfig(copilotHome, input.repoRoot, okhHome);
    return { root, okhHome, copilotHome, workspace, containerPath: dest, originPath: undefined };
  }

  // mode === "registered": existing logic below (unchanged) ...
```

Extract the mcp-config write into a helper so all branches share it. Add near the bottom of the file:

```ts
async function writeMcpConfig(copilotHome: string, repoRoot: string, okhHome: string): Promise<void> {
  const mcp = {
    mcpServers: {
      "open-knowledge-hub": {
        command: "node",
        args: [join(repoRoot, "dist", "index.js")],
        env: { OKH_HOME: okhHome },
      },
    },
  };
  await writeFile(join(copilotHome, "mcp-config.json"), `${JSON.stringify(mcp, null, 2)}\n`, "utf8");
}
```

Replace the existing inline mcp-config write at the end of the registered path with `await writeMcpConfig(copilotHome, input.repoRoot, okhHome);`. After registering the primary container in the registered path, also register any `additional` local containers before `saveRegistry`:

```ts
  let registry = withContainerAdded(emptyRegistry(), entry);
  for (const extra of input.additional ?? []) {
    const dir = join(containersDir, extra.name);
    await cp(extra.fixtureDir, dir, { recursive: true });
    registry = withContainerAdded(registry, {
      name: extra.name,
      backend: "local",
      localPath: dir,
      addedAt: new Date().toISOString(),
    });
  }
  await saveRegistry(paths, registry);
```

(Replace the current single `await saveRegistry(paths, withContainerAdded(emptyRegistry(), entry));` line.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run --config vitest.eval.config.ts eval-test/provision.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add eval/provision.ts eval-test/provision.test.ts eval/fixtures/plain-notes/note.md
git commit -m "feat(eval): empty + unregistered-local provisioning modes"
```

### Task E2: Onboarding assertions

**Files:**
- Create: `eval/assertions/container-registered.ts`
- Create: `eval/assertions/manifest-initialized.ts`
- Create: `eval/assertions/wake-phrase-set.ts`
- Test: `eval-test/assertions.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `eval-test/assertions.test.ts` (create it if absent, following the existing pattern of calling the default export with a fake `providerResponse.metadata`). Add:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "../test/helpers.js";
import containerRegistered from "../eval/assertions/container-registered.js";
import manifestInitialized from "../eval/assertions/manifest-initialized.js";
import wakePhraseSet from "../eval/assertions/wake-phrase-set.js";

const cleanups: string[] = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true }))); });

async function okhHomeWith(name: string): Promise<string> {
  const home = await makeTempDir(); cleanups.push(home);
  const containers = join(home, "containers", name);
  await mkdir(join(containers, ".okh"), { recursive: true });
  await writeFile(join(containers, ".okh", "okh.yaml"), `name: ${name}\nsync: auto\nmodules: []\n`, "utf8");
  await writeFile(join(home, "registry.json"), JSON.stringify({
    version: 1,
    containers: [{ name, backend: "local", localPath: containers, addedAt: new Date().toISOString() }],
  }), "utf8");
  return home;
}

describe("onboarding assertions", () => {
  it("container-registered passes when the container exists with a valid manifest", async () => {
    const okhHome = await okhHomeWith("my-notes");
    const r = await containerRegistered("", { providerResponse: { metadata: { okhHome } }, config: { name: "my-notes", backend: "local" } });
    expect(r.pass).toBe(true);
  });

  it("container-registered fails when nothing is registered", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    await writeFile(join(home, "registry.json"), JSON.stringify({ version: 1, containers: [] }), "utf8");
    const r = await containerRegistered("", { providerResponse: { metadata: { okhHome: home } }, config: { name: "my-notes" } });
    expect(r.pass).toBe(false);
  });

  it("manifest-initialized passes for a registered container", async () => {
    const okhHome = await okhHomeWith("my-notes");
    const r = await manifestInitialized("", { providerResponse: { metadata: { okhHome } }, config: { name: "my-notes" } });
    expect(r.pass).toBe(true);
  });

  it("wake-phrase-set passes when a non-default phrase is persisted", async () => {
    const home = await makeTempDir(); cleanups.push(home);
    await writeFile(join(home, "preferences.json"), JSON.stringify({ wakePhrase: "brain" }), "utf8");
    const r = await wakePhraseSet("", { providerResponse: { metadata: { okhHome: home } }, config: {} });
    expect(r.pass).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.eval.config.ts eval-test/assertions.test.ts`
Expected: FAIL — the three assertion modules do not exist.

- [ ] **Step 3: Create `eval/assertions/container-registered.ts`**

```ts
import { join } from "node:path";
import { loadRegistry, findContainer } from "../../src/registry/registry.js";
import { loadContainerManifest } from "../../src/container/manifest.js";

interface Ctx {
  config?: { name?: string; backend?: string; module?: string };
  providerResponse?: { metadata?: { okhHome?: string } };
}

/** Pass iff the expected container is registered with a valid manifest (and optional module). */
export default async function containerRegistered(_output: string, context: Ctx) {
  const name = context.config?.name;
  const okhHome = context.providerResponse?.metadata?.okhHome;
  if (!name || !okhHome) return { pass: false, score: 0, reason: "missing config.name or metadata.okhHome" };
  const paths = { home: okhHome, containersDir: join(okhHome, "containers"), registryFile: join(okhHome, "registry.json"), preferencesFile: join(okhHome, "preferences.json") };
  const reg = await loadRegistry(paths);
  const entry = findContainer(reg, name);
  if (!entry) return { pass: false, score: 0, reason: `no container "${name}" was registered` };
  if (context.config?.backend && entry.backend !== context.config.backend) {
    return { pass: false, score: 0, reason: `backend ${entry.backend} != expected ${context.config.backend}` };
  }
  try {
    const manifest = await loadContainerManifest(entry.localPath);
    if (context.config?.module && !manifest.modules.some((m) => m.path === context.config!.module)) {
      return { pass: false, score: 0, reason: `module "${context.config.module}" not present` };
    }
  } catch (err) {
    return { pass: false, score: 0, reason: `invalid manifest: ${(err as Error).message}` };
  }
  return { pass: true, score: 1, reason: `container "${name}" registered [${entry.backend}]` };
}
```

- [ ] **Step 4: Create `eval/assertions/manifest-initialized.ts`**

```ts
import { join } from "node:path";
import { loadRegistry, findContainer } from "../../src/registry/registry.js";
import { loadContainerManifest } from "../../src/container/manifest.js";

interface Ctx {
  config?: { name?: string };
  providerResponse?: { metadata?: { okhHome?: string } };
}

/** Pass iff the registered container's manifest exists and parses. */
export default async function manifestInitialized(_output: string, context: Ctx) {
  const name = context.config?.name;
  const okhHome = context.providerResponse?.metadata?.okhHome;
  if (!name || !okhHome) return { pass: false, score: 0, reason: "missing config.name or metadata.okhHome" };
  const paths = { home: okhHome, containersDir: join(okhHome, "containers"), registryFile: join(okhHome, "registry.json"), preferencesFile: join(okhHome, "preferences.json") };
  const entry = findContainer(await loadRegistry(paths), name);
  if (!entry) return { pass: false, score: 0, reason: `no container "${name}"` };
  try {
    await loadContainerManifest(entry.localPath);
    return { pass: true, score: 1, reason: "manifest initialized" };
  } catch (err) {
    return { pass: false, score: 0, reason: `manifest missing/invalid: ${(err as Error).message}` };
  }
}
```

- [ ] **Step 5: Create `eval/assertions/wake-phrase-set.ts`**

```ts
import { join } from "node:path";
import { readFile } from "node:fs/promises";

interface Ctx {
  config?: { default?: string };
  providerResponse?: { metadata?: { okhHome?: string } };
}

/** Pass iff preferences.json holds a wake phrase different from the default. */
export default async function wakePhraseSet(_output: string, context: Ctx) {
  const okhHome = context.providerResponse?.metadata?.okhHome;
  const def = context.config?.default ?? "hub";
  if (!okhHome) return { pass: false, score: 0, reason: "missing metadata.okhHome" };
  try {
    const prefs = JSON.parse(await readFile(join(okhHome, "preferences.json"), "utf8")) as { wakePhrase?: string };
    if (prefs.wakePhrase && prefs.wakePhrase !== def) {
      return { pass: true, score: 1, reason: `wake phrase set to "${prefs.wakePhrase}"` };
    }
    return { pass: false, score: 0, reason: `wake phrase unchanged (${prefs.wakePhrase ?? "none"})` };
  } catch {
    return { pass: false, score: 0, reason: "preferences.json not written" };
  }
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run --config vitest.eval.config.ts eval-test/assertions.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add eval/assertions/container-registered.ts eval/assertions/manifest-initialized.ts eval/assertions/wake-phrase-set.ts eval-test/assertions.test.ts
git commit -m "feat(eval): onboarding side-effect assertions"
```

### Task E3: Scenario vars + tolerant `runChecks` + provider

**Files:**
- Modify: `eval/okh-eval.ts`
- Modify: `eval/provider/copilotProvider.ts`

- [ ] **Step 1: Extend `ScenarioTest.vars` and `setupScenario`**

In `eval/okh-eval.ts`, extend the `vars` type:

```ts
export interface ScenarioTest {
  vars: {
    scenario: string;
    backend: EvalBackend;
    container: string;
    fixture: string;
    prompt: string;
    provision?: "registered" | "empty" | "unregistered-local";
    /** Optional second local container for multi-container scenarios. */
    container2?: string;
    fixture2?: string;
  };
  assert: Array<{ type: string; value?: string; config?: Record<string, unknown> }>;
}
```

In `setupScenario`, pass the mode and any second fixture to `provision`:

```ts
  const fixture2Dir = scenario.vars.fixture2
    ? (isAbsolute(scenario.vars.fixture2) ? scenario.vars.fixture2 : resolve(EVAL_ROOT, scenario.vars.fixture2))
    : undefined;
  const prov = await provision({
    scenario: name,
    backend,
    container: scenario.vars.container,
    fixtureDir,
    repoRoot: REPO_ROOT,
    ...(scenario.vars.provision ? { mode: scenario.vars.provision } : {}),
    ...(scenario.vars.container2 && fixture2Dir
      ? { additional: [{ name: scenario.vars.container2, fixtureDir: fixture2Dir }] }
      : {}),
  });
```

- [ ] **Step 2: Make `runChecks` tolerate no pre-registered container + register new side-effect assertions**

In `eval/okh-eval.ts`, add the new assertions to the side-effect list:

```ts
const SIDE_EFFECT_ASSERTIONS = [
  "okf-valid.ts",
  "memory-append.ts",
  "git-committed.ts",
  "module-unchanged.ts",
  "container-registered.ts",
  "manifest-initialized.ts",
  "wake-phrase-set.ts",
];
```

Change the import `requireContainer` to `findContainer`:

```ts
import { loadRegistry, findContainer } from "../src/registry/registry.js";
```

In `runChecks`, replace the `const entry = requireContainer(reg, scenario.vars.container);` line and the `metadata` build with a tolerant version:

```ts
  const entry = findContainer(reg, scenario.vars.container);
  const metadata = {
    workspace: root,
    okhHome,
    containerPath: entry?.localPath ?? "",
    fixtureDir,
    originPath: entry && entry.backend === "git" ? entry.origin : undefined,
    toolCalls: [] as string[],
  };
```

- [ ] **Step 3: Forward `provision` in the provider**

In `eval/provider/copilotProvider.ts`, read the mode and any second fixture and pass them:

```ts
    const mode = vars.provision === "empty" || vars.provision === "unregistered-local" ? vars.provision : undefined;
    const fixture2Raw = vars.fixture2 ? String(vars.fixture2) : undefined;
    const fixture2Dir = fixture2Raw
      ? (isAbsolute(fixture2Raw) ? fixture2Raw : resolve(EVAL_ROOT, fixture2Raw))
      : undefined;
    const prov = await provision({
      scenario: String(vars.scenario ?? "scenario"),
      backend,
      container: String(vars.container ?? "hub"),
      fixtureDir,
      repoRoot: REPO_ROOT,
      ...(mode ? { mode } : {}),
      ...(vars.container2 && fixture2Dir
        ? { additional: [{ name: String(vars.container2), fixtureDir: fixture2Dir }] }
        : {}),
    });
```

- [ ] **Step 4: Typecheck the eval project**

Run: `npm run typecheck:eval`
Expected: PASS.

- [ ] **Step 5: Run the eval suite**

Run: `npm run test:eval`
Expected: PASS (existing eval tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add eval/okh-eval.ts eval/provider/copilotProvider.ts
git commit -m "feat(eval): scenario provision modes + tolerant runChecks"
```

### Task E4: Onboarding scenario files

**Files:**
- Create: `eval/scenarios/onboard-create-local/test.yaml`
- Create: `eval/scenarios/onboard-add-existing-folder/test.yaml`
- Create: `eval/scenarios/onboard-add-github/test.yaml`
- Create: `eval/scenarios/onboard-explains/test.yaml`
- Create: `eval/scenarios/onboard-wake-phrase/test.yaml`
- Create: `eval/scenarios/ask-multi-container/test.yaml`

These are data files exercised by the (non-CI) `npm run eval`. Validate structurally with `promptfoo validate` after writing.

- [ ] **Step 1: `onboard-create-local/test.yaml`**

```yaml
- vars:
    scenario: onboard-create-local
    backend: local
    provision: empty
    container: my-notes
    fixture: fixtures/plain-notes
    prompt: |
      hub, create a new knowledge hub in a folder called "my-notes" and add a
      knowledge module named "kb". Show me the plan and wait for my confirmation
      before creating anything; when you ask, assume I say yes.
  assert:
    - type: javascript
      value: file://assertions/tools-called.ts
      config: { expect: [add] }
    - type: javascript
      value: file://assertions/container-registered.ts
      config: { name: my-notes, backend: local, module: kb }
    - type: javascript
      value: file://assertions/manifest-initialized.ts
      config: { name: my-notes }
    - type: javascript
      value: file://assertions/judge.ts
      config:
        threshold: 0.8
        rubric: |
          PASS iff the agent presented a plan for creating the folder + manifest,
          waited for confirmation, then created the hub and a "kb" knowledge module.
```

- [ ] **Step 2: `onboard-add-existing-folder/test.yaml`**

```yaml
- vars:
    scenario: onboard-add-existing-folder
    backend: local
    provision: unregistered-local
    container: notes
    fixture: fixtures/plain-notes
    prompt: |
      hub, add my existing folder "notes" (in the current working directory) as a
      knowledge hub. Show the plan first and only initialize it after I confirm;
      assume I say yes.
  assert:
    - type: javascript
      value: file://assertions/tools-called.ts
      config: { expect: [add] }
    - type: javascript
      value: file://assertions/container-registered.ts
      config: { name: notes, backend: local }
    - type: javascript
      value: file://assertions/manifest-initialized.ts
      config: { name: notes }
    - type: javascript
      value: file://assertions/judge.ts
      config:
        threshold: 0.8
        rubric: |
          PASS iff the agent registered the existing "notes" folder and initialized
          an OKH manifest, after previewing the change.
```

- [ ] **Step 3: `onboard-add-github/test.yaml`** (uses the real private repo from Phase F)

```yaml
- vars:
    scenario: onboard-add-github
    backend: local
    provision: empty
    container: okh-eval-hub
    fixture: fixtures/plain-notes
    prompt: |
      hub, add the knowledge hub at https://github.com/dryotta/okh-eval-hub.git and
      tell me what's in it. Preview the clone first; assume I confirm.
  assert:
    - type: javascript
      value: file://assertions/tools-called.ts
      config: { expect: [add, inspect] }
    - type: javascript
      value: file://assertions/container-registered.ts
      config: { name: okh-eval-hub, backend: git, module: kb }
    - type: javascript
      value: file://assertions/judge.ts
      config:
        threshold: 0.8
        rubric: |
          PASS iff the agent cloned the repo, registered it as a git container, and
          summarized its actual knowledge content (from the kb module). No push/sync required.
```

- [ ] **Step 4: `onboard-explains/test.yaml`**

```yaml
- vars:
    scenario: onboard-explains
    backend: local
    provision: empty
    container: hub
    fixture: fixtures/plain-notes
    prompt: |
      hub, what can you do?
  assert:
    - type: javascript
      value: file://assertions/judge.ts
      config:
        threshold: 0.8
        rubric: |
          PASS iff the agent explains OKH as containers of typed modules, mentions
          inspect/add/sync and the cognitive flows, and offers to help set up a first hub.
```

- [ ] **Step 5: `onboard-wake-phrase/test.yaml`**

```yaml
- vars:
    scenario: onboard-wake-phrase
    backend: local
    provision: empty
    container: hub
    fixture: fixtures/plain-notes
    prompt: |
      hub, help me get started. I'd like to call you "brain" from now on.
  assert:
    - type: javascript
      value: file://assertions/tools-called.ts
      config: { expect: [onboard] }
    - type: javascript
      value: file://assertions/wake-phrase-set.ts
      config: { default: hub }
    - type: javascript
      value: file://assertions/judge.ts
      config:
        threshold: 0.8
        rubric: |
          PASS iff the agent explained onboarding and set the wake phrase to "brain".
```

- [ ] **Step 6: `ask-multi-container/test.yaml`**

Register the primary container (`kb-hub`) plus a second local container
(`git-hub`) via the `container2`/`fixture2` vars (threaded through the provider in
Task E3). The question spans the registered hubs:

```yaml
- vars:
    scenario: ask-multi-container
    backend: local
    provision: registered
    container: kb-hub
    fixture: fixtures/kb-hub
    container2: git-hub
    fixture2: fixtures/git-hub
    prompt: |
      hub, across all my registered hubs, what do we know about authentication and
      session tokens? Cite the module path for each fact.
  assert:
    - type: javascript
      value: file://assertions/tools-called.ts
      config: { expect: [ask] }
    - type: javascript
      value: file://assertions/judge.ts
      config:
        threshold: 0.8
        rubric: |
          PASS iff the agent answered from the registered knowledge modules with
          module-path citations, drawing on more than one hub where the facts live,
          and invented nothing.
```

Note: both `fixtures/kb-hub` and `fixtures/git-hub` are existing local fixtures;
`git-hub` is registered here as a plain `local` container (no git backend needed —
the scenario only reads its knowledge).

- [ ] **Step 7: Validate scenario structure**

Run: `npx promptfoo validate -c eval/promptfooconfig.yaml`
Expected: validation passes (no automated model calls).

- [ ] **Step 8: Commit**

```bash
git add eval/scenarios/onboard-create-local eval/scenarios/onboard-add-existing-folder eval/scenarios/onboard-add-github eval/scenarios/onboard-explains eval/scenarios/onboard-wake-phrase eval/scenarios/ask-multi-container
git commit -m "feat(eval): onboarding + multi-container scenarios"
```

---

## Phase F — Private test GitHub repo

### Task F1: Create and seed `dryotta/okh-eval-hub`

Not TDD — an operational step run once from the dev machine (requires `gh` authenticated with repo-create scope). Produces the private repo the `onboard-add-github` scenario clones.

**Files:**
- Temporary local seed dir (not committed to this repo).

- [ ] **Step 1: Verify `gh` auth**

Run: `gh auth status`
Expected: logged in; token has repo scope.

- [ ] **Step 2: Build the seed content locally**

Run (PowerShell):

```powershell
$seed = Join-Path $env:TEMP "okh-eval-hub-seed"
New-Item -ItemType Directory -Force -Path (Join-Path $seed ".okh"), (Join-Path $seed "kb") | Out-Null
@"
name: okh-eval-hub
sync: auto
modules:
  - path: kb
    type: knowledge
"@ | Set-Content -Path (Join-Path $seed ".okh/okh.yaml") -Encoding utf8
@"
# Knowledge

Index for the OKH eval hub.
"@ | Set-Content -Path (Join-Path $seed "kb/index.md") -Encoding utf8
@"
# Authentication

Session tokens are signed with RS256 and the public keys rotate weekly.
"@ | Set-Content -Path (Join-Path $seed "kb/auth.md") -Encoding utf8
```

(If the `knowledge` loader requires OKF frontmatter in `index.md`, mirror the format used by `eval/fixtures/kb-hub/kb/index.md` — open that file and copy its frontmatter shape before committing the seed.)

- [ ] **Step 3: Create the private repo and push the seed**

Run (PowerShell, from `$seed`):

```powershell
Set-Location $seed
git init -b main
git add -A
git commit -m "seed okh eval hub"
gh repo create dryotta/okh-eval-hub --private --source . --remote origin --push
```

- [ ] **Step 4: Verify a clone works with current credentials**

Run:

```powershell
git clone https://github.com/dryotta/okh-eval-hub.git (Join-Path $env:TEMP "okh-eval-hub-verify")
```

Expected: clone succeeds (via `gh` credential helper). Remove the verify dir afterward.

- [ ] **Step 5: No commit in this repo**

Nothing to commit here (the repo lives on GitHub). Note the URL is already referenced by `eval/scenarios/onboard-add-github/test.yaml`.

---

## Phase G — Docs

### Task G1: `USAGE.md`

**Files:**
- Create: `USAGE.md`

- [ ] **Step 1: Create `USAGE.md`**

```markdown
# Using Open Knowledge Hub

Open Knowledge Hub (OKH) organizes your knowledge and capabilities into
**containers** (a folder, an OS-synced folder, or a git repo) made of typed
**modules** (`knowledge`, `skills`, `tools`, `memory`, `project`). Your agent does
the thinking; OKH stores, validates, and syncs.

## How your prompt reaches the hub

Your agent decides which tools to call from their descriptions and the hub's
announced **wake phrase**. Address the hub with the wake phrase — by default
`hub` — for example: `hub, remember that …`.

- Naming the hub matters most for the *cognitive* verbs (`ask`, `learn`,
  `remember`, `context`, `reflect`); without it, "remember that X" often looks
  like an ordinary request and won't reach OKH.
- The *operational* verbs (`inspect`, `add`, `sync`) usually route reliably even
  without the prefix.
- Most explicit option: clients with a prompt UI expose OKH's flows as pickable
  `/`-commands.

## Getting started

Say **`hub, help me get started`** to run the guided `onboard` flow. Or set up a
hub directly:

- **From an existing folder:** `hub, add my folder ./notes as a knowledge hub.`
- **From scratch:** `hub, create a new knowledge hub in ./my-notes.`
- **From GitHub:** `hub, connect the repo https://github.com/me/my-hub.git.`
- **Add a module:** `hub, add a knowledge module called kb.`

**The confirmation step.** `add` never changes anything on disk on its own. It
first replies with a **plan** ("will create folder …, will initialize a
manifest …"). Review it and confirm; your agent then re-runs `add` to apply. This
is why the first `add` shows a plan instead of doing the work immediately.

## Choosing a wake phrase

The default is `hub`. To change it: `hub, call yourself brain.` — your agent
persists it via the `onboard` tool. It takes effect the next time your MCP client
restarts. For the most reliable routing, you can also rename this server's key in
your MCP client config to the same phrase (client-specific).

## Everyday use

- **Remember:** `hub, remember that the login endpoint 500'd at 14:05 UTC.`
- **Learn:** `hub, learn this: session tokens use RS256, keys rotate weekly.`
- **Ask:** `hub, what do we know about authentication?`
- **Ask across everything:** `hub, across all my hubs, what do we know about X?`
- **Context:** `hub, assemble the context I need to build a login feature.`
- **Reflect:** `hub, reflect on my memory from this week and propose updates.`
- **Sync:** `hub, sync my hub.` (commit + push) or `hub, open a PR with my changes.`

Writing flows (`learn`, `remember`, `reflect`) edit files locally; your agent
summarizes the change and asks before syncing. `sync` commits + pushes (`auto`
containers) or opens a pull request (`pr` containers).
```

- [ ] **Step 2: Commit**

```bash
git add USAGE.md
git commit -m "docs: add USAGE.md with recommended prompts"
```

### Task G2: README + eval docs

**Files:**
- Modify: `README.md`
- Modify: `eval/README.md`
- Modify: `eval/MANUAL-TESTING.md`

- [ ] **Step 1: Update `README.md`**

In the **MCP surface** section, change the tools table header count and add the `onboard` row, and bump the prompts count to 6. Under the tools table add:

```markdown
| `onboard` | `wakePhrase?` | Guide first-run setup; persist a custom wake phrase. |
```

Change `**Tools (8)**` to `**Tools (9)**` and `**Prompts (5):**` to `**Prompts (6):** ... adds `onboard``. In the `add` row, note the preview/confirm behavior: append " Returns a plan unless `create:true`." Add a new subsection after **Typical usage**:

```markdown
## Wake phrase

Address the hub by its wake phrase (default `hub`), e.g. `hub, remember that …`.
Change it with the `onboard` tool; OKH stores it in `$OKH_HOME/preferences.json`
and announces it in the server instructions. See **[USAGE.md](./USAGE.md)** for
recommended prompts.
```

- [ ] **Step 2: Update `eval/README.md`**

Add a short subsection documenting the new provisioning modes and onboarding scenarios:

```markdown
## Onboarding scenarios

`provision` (per-scenario var) selects the starting state:
- `registered` (default) — the fixture is pre-registered as a container.
- `empty` — empty registry + empty workspace (agent adds from scratch or a URL).
- `unregistered-local` — the fixture sits in the workspace, unregistered, for the
  agent to `add`.

`onboard-add-github` clones the **private** repo `dryotta/okh-eval-hub`. Cloning a
private repo relies on the machine's `gh` credential helper (macOS/Windows) or a
token with `repo` read (Linux/CI). No push/sync is exercised.
```

- [ ] **Step 3: Update `eval/MANUAL-TESTING.md`**

Add the onboarding scenarios to the manual walkthrough list, and add a **PR-mode sync** manual entry:

```markdown
## PR-mode sync (manual only)

Automated e2e cannot open real pull requests. To test `pr`-mode:
1. Create/register a `pr`-mode git container against a repo you can push to.
2. `hub, learn this: <fact>` then confirm; `hub, open a PR with my changes.`
3. Verify `sync` created a branch `okh/<name>/sync-*`, pushed it, and opened a PR
   via `gh`, then returned you to the base branch.
```

- [ ] **Step 4: Commit**

```bash
git add README.md eval/README.md eval/MANUAL-TESTING.md
git commit -m "docs: onboarding surface, wake phrase, eval modes, manual PR sync"
```

---

## Final Verification

### Task Z1: Full green + spec coverage

- [ ] **Step 1: Core suite**

Run: `npm run build && npm run typecheck && npm test`
Expected: build clean, typecheck exit 0, all core tests pass (including `add-confirm`, `preferences`, updated `server`/`service`/`inspect`).

- [ ] **Step 2: Eval suite**

Run: `npm run typecheck:eval && npm run test:eval`
Expected: exit 0; all eval unit tests pass.

- [ ] **Step 3: Scenario validation**

Run: `npx promptfoo validate -c eval/promptfooconfig.yaml`
Expected: passes.

- [ ] **Step 4: (Optional, non-CI) live e2e smoke**

Run a single onboarding scenario manually to sanity-check routing/behavior:
`npm run eval:setup -- setup onboard-create-local` → `npm run eval:setup -- enter` → drive it → `npm run eval:setup -- check` → `npm run eval:setup -- clean`.
Expected: the checks (`container-registered`, `manifest-initialized`) pass.

- [ ] **Step 5: Final commit (if any docs/tweaks remain)**

```bash
git add -A
git commit -m "chore: finalize onboarding experience"
```

