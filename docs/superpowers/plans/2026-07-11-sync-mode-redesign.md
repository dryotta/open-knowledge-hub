# Sync Mode and Backend Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Git-specific `auto`/`pr` branching with backend adapters supporting universal `auto`, optional `shared`, and Git's explicit `publish-pr` action.

**Architecture:** Registry v2 stores structured backend and sync descriptors. `ContainerService` resolves and validates entries through a `SyncBackendRegistry`, while Git and passive filesystem adapters own mode defaults, actions, and synchronization. Git shared mode keeps a persistent configured branch, rebases it onto `origin/main`, and publishes an idempotent PR only when requested.

**Tech Stack:** TypeScript 5.6, Zod 4, Vitest 4, Node.js filesystem APIs, git CLI, GitHub `gh` CLI, MCP SDK.

---

## File map

**Create**

- `src/sync/types.ts` — common adapter requests, results, modes, and interface.
- `src/sync/backendRegistry.ts` — backend registration, lookup, validation, and dispatch metadata.
- `src/sync/passiveBackend.ts` — local/OneDrive `auto` validation-only adapter.
- `src/sync/gitBackend.ts` — Git `auto`, `shared`, and `publish-pr`.
- `src/registry/migrate.ts` — atomic registry v1-to-v2 conversion.
- `test/sync-backends.test.ts` — adapter registry and passive backend tests.
- `test/git-backend.test.ts` — direct Git adapter behavior against temp repos.
- `test/git-primitives.test.ts` — focused Git/Gh wrapper command tests.

**Modify**

- `src/registry/schema.ts` — registry v2 structural model and legacy v1 parsing types.
- `src/registry/registry.ts` — load-time migration and atomic persistence.
- `src/container/migrate.ts` — return legacy mode without binding it to the v2 schema.
- `src/git/git.ts` — branch existence/tracking, remote fetch, rebase, abort, and ref validation.
- `src/git/gh.ts` — authenticated login and open-PR lookup.
- `src/container/service.ts` — adapter dispatch, structured add config, migration integration, status models.
- `src/server/toolSchemas.ts` — structured add sync selection and optional sync action.
- `src/server/tools.ts` — new argument/result formatting and action validation.
- `src/prompts/index.ts` — render structured sync mode/config.
- `resources/tool-meta/add_container.md` — document structured sync config.
- `resources/tool-meta/sync.md` — document actions and named-container requirement.
- `resources/prompts/partials/write-policy.md` — remove ordinary write confirmation.
- `resources/prompts/instructions.md` — describe auto/shared and explicit publication.
- `resources/prompts/onboard.md` — retain setup confirmation without contradicting normal writes.
- `resources/module-types/memory/skills/remember/SKILL.md` — apply todo mutations directly, summarize, sync.
- `resources/module-types/memory/skills/todo/SKILL.md` — apply mutations directly, summarize, sync.
- `README.md`, `USAGE.md` — public mode, action, todo, and write-policy documentation.
- `test/registry.test.ts`, `test/migrate.test.ts`, `test/review-fixes.test.ts` — v2 and legacy migration.
- `test/service.test.ts`, `test/add-confirm.test.ts`, `test/inspect.test.ts` — structured add/status behavior.
- `test/sync.test.ts` — end-to-end auto/shared/publish behavior against real temp git repos.
- `test/server.test.ts`, `test/toolMeta.test.ts` — MCP tool schema, formatting, and metadata.
- `test/prompts.test.ts`, `test/run.test.ts` — no-confirmation policy and shared publication guidance.
- `eval/assertions/checks.ts` — assert direct todo apply followed by sync.
- `eval/scenarios/remember/todo.yaml`, `eval/scenarios/todo/complete.yaml` — single-turn apply-and-sync expectations.

## Task 1: Introduce registry v2 and atomic migration

**Files:**
- Create: `src/registry/migrate.ts`
- Modify: `src/registry/schema.ts`
- Modify: `src/registry/registry.ts`
- Test: `test/registry.test.ts`

- [ ] **Step 1: Write failing registry v2 and migration tests**

Replace v1-shaped helpers in `test/registry.test.ts` and add these cases:

```ts
function entry(over: Partial<ContainerEntry> = {}): ContainerEntry {
  return {
    name: "my-hub",
    backend: { type: "local", config: {} },
    localPath: "/tmp/my-hub",
    sync: { mode: "auto", config: {} },
    addedAt: "2026-07-02T00:00:00.000Z",
    ...over,
  };
}

it("migrates a v1 git pr entry to v2 shared", async () => {
  const home = await makeTempDir();
  cleanups.push(home);
  const paths = makePaths(home);
  await writeFile(paths.registryFile, JSON.stringify({
    version: 1,
    containers: [{
      name: "team",
      backend: "git",
      origin: "https://github.com/example/team.git",
      localPath: "/tmp/team",
      sync: "pr",
      addedAt: "2026-07-02T00:00:00.000Z",
    }],
  }));

  const reg = await loadRegistry(paths, { resolveGitLogin: async () => "alice" });

  expect(reg.version).toBe(2);
  expect(reg.containers[0]).toMatchObject({
    backend: { type: "git", config: { origin: "https://github.com/example/team.git" } },
    sync: { mode: "shared", config: { branch: "user/alice/hub" } },
  });
  expect(JSON.parse(await readFile(paths.registryFile, "utf8")).version).toBe(2);
});

it("does not rewrite a v1 git pr registry when login resolution fails", async () => {
  const home = await makeTempDir();
  cleanups.push(home);
  const paths = makePaths(home);
  const legacy = JSON.stringify({
    version: 1,
    containers: [{
      name: "team",
      backend: "git",
      origin: "https://github.com/example/team.git",
      localPath: "/tmp/team",
      sync: "pr",
      addedAt: "2026-07-02T00:00:00.000Z",
    }],
  });
  await writeFile(paths.registryFile, legacy);

  await expect(loadRegistry(paths, {
    resolveGitLogin: async () => { throw new Error("not logged in"); },
  })).rejects.toThrow(/gh auth login|legacy.*pr/i);
  expect(await readFile(paths.registryFile, "utf8")).toBe(legacy);
});

it("migrates a non-git v1 pr entry to auto", async () => {
  const home = await makeTempDir();
  cleanups.push(home);
  const paths = makePaths(home);
  await writeFile(paths.registryFile, JSON.stringify({
    version: 1,
    containers: [{
      name: "notes",
      backend: "local",
      localPath: "/tmp/notes",
      sync: "pr",
      addedAt: "2026-07-02T00:00:00.000Z",
    }],
  }));

  const reg = await loadRegistry(paths);
  expect(reg.containers[0]?.sync).toEqual({ mode: "auto", config: {} });
});
```

- [ ] **Step 2: Run registry tests and verify the old schema fails**

Run:

```powershell
npx vitest run test\registry.test.ts
```

Expected: FAIL because registry version 2, structured backend/sync entries, and migration options do not exist.

- [ ] **Step 3: Define v2 and legacy structural schemas**

In `src/registry/schema.ts`, replace the flat backend/sync fields with:

```ts
export const REGISTRY_VERSION = 2;

export const backendTypeSchema = z.enum(["git", "local", "onedrive"]);
export type BackendType = z.infer<typeof backendTypeSchema>;

export const syncModeSchema = z.enum(["auto", "shared"]);
export type SyncMode = z.infer<typeof syncModeSchema>;

const configSchema = z.record(z.string(), z.unknown());

export const backendDescriptorSchema = z.object({
  type: backendTypeSchema,
  config: configSchema.default({}),
}).strict();

export const syncDescriptorSchema = z.object({
  mode: syncModeSchema.default("auto"),
  config: configSchema.default({}),
}).strict();

export const containerEntrySchema = z.object({
  name: containerNameSchema,
  backend: backendDescriptorSchema,
  localPath: z.string().min(1),
  sync: syncDescriptorSchema.default({ mode: "auto", config: {} }),
  addedAt: z.string().datetime(),
}).strict();

export const registrySchema = z.object({
  version: z.literal(REGISTRY_VERSION),
  containers: z.array(containerEntrySchema),
}).strict();

export const legacyRegistrySchema = z.object({
  version: z.literal(1),
  containers: z.array(z.object({
    name: containerNameSchema,
    backend: backendTypeSchema,
    origin: repoUrlSchema.optional(),
    localPath: z.string().min(1),
    sync: z.enum(["auto", "pr"]).default("auto"),
    addedAt: z.string().datetime(),
  }).strict()),
}).strict();
```

Keep `repoUrlSchema`, `ContainerEntry`, `Registry`, and `emptyRegistry()`, updating
`emptyRegistry()` to return version 2.

- [ ] **Step 4: Implement pure registry migration**

Create `src/registry/migrate.ts`:

```ts
import { OkhError } from "../errors.js";
import type { z } from "zod";
import {
  legacyRegistrySchema,
  REGISTRY_VERSION,
  type Registry,
} from "./schema.js";

export interface RegistryMigrationOptions {
  resolveGitLogin?: () => Promise<string>;
}

type LegacyRegistry = z.infer<typeof legacyRegistrySchema>;

export async function migrateRegistryV1(
  legacy: LegacyRegistry,
  options: RegistryMigrationOptions = {},
): Promise<Registry> {
  const containers = [];
  for (const entry of legacy.containers) {
    if (entry.backend === "git" && !entry.origin) {
      throw new OkhError(
        "INVALID_MANIFEST",
        `Legacy Git container "${entry.name}" has no origin.`,
      );
    }
    let sync: Registry["containers"][number]["sync"];
    if (entry.backend === "git" && entry.sync === "pr") {
      if (!options.resolveGitLogin) {
        throw new OkhError(
          "INVALID_MANIFEST",
          `Legacy PR container "${entry.name}" needs a GitHub login to migrate.`,
          "Authenticate with `gh auth login` and retry.",
        );
      }
      let login: string;
      try {
        login = await options.resolveGitLogin();
      } catch (error) {
        throw new OkhError(
          "INVALID_MANIFEST",
          `Could not migrate legacy PR container "${entry.name}": ${(error as Error).message}`,
          "Authenticate with `gh auth login` and retry.",
        );
      }
      sync = { mode: "shared", config: { branch: `user/${login}/hub` } };
    } else {
      sync = { mode: "auto", config: {} };
    }
    containers.push({
      name: entry.name,
      backend: {
        type: entry.backend,
        config: entry.backend === "git" ? { origin: entry.origin! } : {},
      },
      localPath: entry.localPath,
      sync,
      addedAt: entry.addedAt,
    });
  }
  return { version: REGISTRY_VERSION, containers };
}
```

Validate the returned value with `registrySchema.parse(...)` before returning so
a missing legacy Git origin fails migration.

- [ ] **Step 5: Make `loadRegistry` parse and persist migrations atomically**

In `src/registry/registry.ts`, change the signature and parse branch:

```ts
export async function loadRegistry(
  paths: OkhPaths,
  options: RegistryMigrationOptions = {},
): Promise<Registry> {
  // existing file read and JSON parse
  const current = registrySchema.safeParse(parsed);
  if (current.success) return current.data;

  const legacy = legacyRegistrySchema.safeParse(parsed);
  if (legacy.success) {
    const migrated = await migrateRegistryV1(legacy.data, options);
    await saveRegistry(paths, migrated);
    return migrated;
  }

  throw new OkhError(
    "INVALID_MANIFEST",
    `Registry at ${paths.registryFile} does not match the expected schema: ${current.error.message}`,
    "Fix or delete the file to reset the registry.",
  );
}
```

Do not write until migration and v2 validation both succeed.

- [ ] **Step 6: Run registry tests**

Run:

```powershell
npx vitest run test\registry.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit registry v2**

```powershell
git add src\registry\schema.ts src\registry\registry.ts src\registry\migrate.ts test\registry.test.ts
git commit -m "refactor: add structured sync registry"
```

## Task 2: Add backend adapter contracts and passive backends

**Files:**
- Create: `src/sync/types.ts`
- Create: `src/sync/backendRegistry.ts`
- Create: `src/sync/passiveBackend.ts`
- Create: `test/sync-backends.test.ts`

- [ ] **Step 1: Write failing capability and passive-sync tests**

Create `test/sync-backends.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { BackendRegistry } from "../src/sync/backendRegistry.js";
import { PassiveBackend } from "../src/sync/passiveBackend.js";

describe("BackendRegistry", () => {
  it("rejects unsupported modes and config keys", async () => {
    const backends = new BackendRegistry([
      new PassiveBackend("local"),
      new PassiveBackend("onedrive"),
    ]);
    await expect(backends.resolveSync("local", {
      mode: "shared",
      config: {},
    }, { containerName: "notes" })).rejects.toThrow(/local.*auto/i);
    await expect(backends.resolveSync("local", {
      mode: "auto",
      config: { branch: "x" },
    }, { containerName: "notes" })).rejects.toThrow(/branch|unknown/i);
  });

  it("validates only for passive auto sync", async () => {
    const backend = new PassiveBackend("local");
    await expect(backend.sync({
      entry: {
        name: "notes",
        backend: { type: "local", config: {} },
        localPath: "C:\\notes",
        sync: { mode: "auto", config: {} },
        addedAt: new Date().toISOString(),
      },
      validation: { ok: true, issues: [] },
    })).resolves.toMatchObject({ outcome: "validated", mode: "auto" });
  });
});
```

- [ ] **Step 2: Run the new test and verify missing modules**

Run:

```powershell
npx vitest run test\sync-backends.test.ts
```

Expected: FAIL with module-not-found errors.

- [ ] **Step 3: Define the common adapter contract**

Create `src/sync/types.ts`:

```ts
import type { BackendType, ContainerEntry, SyncMode } from "../registry/schema.js";

export type SyncOutcome = "synced" | "up-to-date" | "published" | "validated" | "error";

export interface SyncSelection {
  mode: SyncMode;
  config: Record<string, unknown>;
}

export interface ResolveSyncContext {
  containerName: string;
}

export interface BackendSyncRequest {
  entry: ContainerEntry;
  validation: { ok: boolean; issues: string[] };
  message?: string;
  action?: string;
}

export interface BackendSyncResult {
  mode: SyncMode;
  requestedAction?: string;
  outcome: SyncOutcome;
  committed?: boolean;
  pushed?: boolean;
  branch?: string;
  prUrl?: string;
}

export interface SyncBackend {
  readonly type: BackendType;
  readonly modes: readonly SyncMode[];
  resolveBackendConfig(config: unknown): Record<string, unknown>;
  resolveSync(selection: SyncSelection, context: ResolveSyncContext): Promise<SyncSelection>;
  actions(selection: SyncSelection): readonly string[];
  sync(request: BackendSyncRequest): Promise<BackendSyncResult>;
}
```

- [ ] **Step 4: Implement backend lookup and validation**

Create `src/sync/backendRegistry.ts` with:

```ts
export class BackendRegistry {
  private readonly byType: Map<BackendType, SyncBackend>;

  constructor(backends: readonly SyncBackend[]) {
    this.byType = new Map(backends.map((backend) => [backend.type, backend]));
  }

  require(type: BackendType): SyncBackend {
    const backend = this.byType.get(type);
    if (!backend) throw new OkhError("INVALID_ARGUMENT", `Unsupported backend "${type}".`);
    return backend;
  }

  resolveBackendConfig(type: BackendType, config: unknown): Record<string, unknown> {
    return this.require(type).resolveBackendConfig(config);
  }

  resolveSync(
    type: BackendType,
    selection: SyncSelection,
    context: ResolveSyncContext,
  ): Promise<SyncSelection> {
    const backend = this.require(type);
    if (!backend.modes.includes(selection.mode)) {
      throw new OkhError(
        "INVALID_ARGUMENT",
        `Backend "${type}" does not support sync mode "${selection.mode}". Supported modes: ${backend.modes.join(", ")}.`,
      );
    }
    return backend.resolveSync(selection, context);
  }
}
```

Also add `actions(entry)` and `validateEntry(entry)` helpers. `validateEntry`
must re-run both backend config and sync resolution without changing persisted
values; compare parsed output to the input so unknown keys cannot survive.

- [ ] **Step 5: Implement passive local/OneDrive adapters**

Create `src/sync/passiveBackend.ts`:

```ts
const emptyConfig = z.object({}).strict();

export class PassiveBackend implements SyncBackend {
  readonly modes = ["auto"] as const;

  constructor(readonly type: "local" | "onedrive") {}

  resolveBackendConfig(config: unknown): Record<string, unknown> {
    return emptyConfig.parse(config);
  }

  async resolveSync(selection: SyncSelection): Promise<SyncSelection> {
    if (selection.mode !== "auto") {
      throw new OkhError("INVALID_ARGUMENT", `${this.type} supports only auto sync.`);
    }
    return { mode: "auto", config: emptyConfig.parse(selection.config) };
  }

  actions(): readonly string[] {
    return [];
  }

  async sync(request: BackendSyncRequest): Promise<BackendSyncResult> {
    if (request.action) {
      throw new OkhError("INVALID_ARGUMENT", `${this.type} auto sync supports no actions.`);
    }
    return { mode: "auto", outcome: "validated" };
  }
}
```

- [ ] **Step 6: Run adapter tests and typecheck**

Run:

```powershell
npx vitest run test\sync-backends.test.ts
npm run typecheck:server
```

Expected: PASS.

- [ ] **Step 7: Commit adapter foundation**

```powershell
git add src\sync test\sync-backends.test.ts
git commit -m "refactor: introduce sync backend adapters"
```

## Task 3: Add Git and GitHub primitives

**Files:**
- Modify: `src/git/git.ts`
- Modify: `src/git/gh.ts`
- Create: `test/git-primitives.test.ts`

- [ ] **Step 1: Write failing command-wrapper tests**

Create `test/git-primitives.test.ts` with a recording runner:

```ts
it("checks branches, fetches origin, rebases, and aborts", async () => {
  const calls: string[][] = [];
  const runner: Runner = async (_command, args) => {
    calls.push(args);
    return { stdout: "", stderr: "" };
  };
  const git = new Git(runner);

  await git.fetchRemote("C:\\repo", "origin");
  await git.createBranchFrom("C:\\repo", "user/alice/hub", "origin/main");
  await git.rebase("C:\\repo", "origin/main");
  await git.abortRebase("C:\\repo");

  expect(calls).toEqual([
    ["fetch", "origin", "--prune"],
    ["checkout", "-b", "user/alice/hub", "origin/main"],
    ["rebase", "origin/main"],
    ["rebase", "--abort"],
  ]);
});

it("resolves login and an existing open PR", async () => {
  const calls: string[][] = [];
  const runner: Runner = async (_command, args) => {
    calls.push(args);
    return {
      stdout: args[0] === "api" ? "alice\n" : "https://github.com/x/y/pull/7\n",
      stderr: "",
    };
  };
  const gh = new Gh(runner);

  await expect(gh.currentLogin()).resolves.toBe("alice");
  await expect(gh.findOpenPr({
    cwd: "C:\\repo",
    base: "main",
    head: "user/alice/hub",
  })).resolves.toBe("https://github.com/x/y/pull/7");
});
```

- [ ] **Step 2: Run primitive tests and verify missing methods**

Run:

```powershell
npx vitest run test\git-primitives.test.ts
```

Expected: FAIL because the new methods do not exist.

- [ ] **Step 3: Add Git branch/rebase methods**

In `src/git/git.ts`, add:

```ts
async isValidBranchName(branch: string): Promise<boolean> {
  try {
    await this.git(["check-ref-format", "--branch", branch]);
    return true;
  } catch {
    return false;
  }
}

async localBranchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd);
    return true;
  } catch {
    return false;
  }
}

async remoteBranchExists(cwd: string, remote: string, branch: string): Promise<boolean> {
  try {
    await this.git(["show-ref", "--verify", "--quiet", `refs/remotes/${remote}/${branch}`], cwd);
    return true;
  } catch {
    return false;
  }
}

async fetchRemote(cwd: string, remote: string): Promise<void> {
  await this.git(["fetch", remote, "--prune"], cwd);
}

async createBranchFrom(cwd: string, branch: string, startPoint: string): Promise<void> {
  await this.git(["checkout", "-b", branch, startPoint], cwd);
}

async checkoutTracking(cwd: string, branch: string, upstream: string): Promise<void> {
  await this.git(["checkout", "--track", "-b", branch, upstream], cwd);
}

async rebase(cwd: string, upstream: string): Promise<void> {
  await this.git(["rebase", upstream], cwd);
}

async abortRebase(cwd: string): Promise<void> {
  await this.git(["rebase", "--abort"], cwd);
}
```

Keep existing methods used by auto mode.

- [ ] **Step 4: Add GitHub login and PR lookup**

In `src/git/gh.ts`, add:

```ts
async currentLogin(): Promise<string> {
  return (await this.gh(["api", "user", "--jq", ".login"])).trim();
}

async findOpenPr(options: {
  cwd: string;
  base: string;
  head: string;
}): Promise<string | undefined> {
  const out = await this.gh([
    "pr", "list",
    "--state", "open",
    "--base", options.base,
    "--head", options.head,
    "--json", "url",
    "--jq", ".[0].url // \"\"",
  ], options.cwd);
  return out.trim() || undefined;
}
```

Extend `createPr` with `head?: string` and append `--head <branch>` when set.

- [ ] **Step 5: Run primitive tests and typecheck**

Run:

```powershell
npx vitest run test\git-primitives.test.ts
npm run typecheck:server
```

Expected: PASS.

- [ ] **Step 6: Commit Git primitives**

```powershell
git add src\git\git.ts src\git\gh.ts test\git-primitives.test.ts
git commit -m "feat: add shared branch git primitives"
```

## Task 4: Implement the Git backend

**Files:**
- Create: `src/sync/gitBackend.ts`
- Create: `test/git-backend.test.ts`

- [ ] **Step 1: Write direct Git backend behavior tests**

Create `test/git-backend.test.ts`. Construct `GitBackend` directly so this task
can pass before `ContainerService` is rewired:

```ts
it("defaults shared branch from the authenticated gh login", async () => {
  const backend = new GitBackend(new Git(testRun), new FakeGh("tester") as unknown as Gh);
  await expect(backend.resolveSync(
    { mode: "shared", config: {} },
    { containerName: "team" },
  )).resolves.toEqual({
    mode: "shared",
    config: { branch: "user/tester/hub" },
  });
});

it("syncs a persistent shared branch rebased onto origin/main", async () => {
  const origin = await makeOrigin();
  const root = await makeTempDir();
  cleanups.push(root);
  const git = new Git(testRun);
  await git.clone(origin, root);
  const backend = new GitBackend(git, new FakeGh("tester") as unknown as Gh);
  const entry = gitEntry(root, origin, "user/tester/hub");
  await writeFile(join(root, "local.md"), "local", "utf8");
  await pushToOrigin(origin, "remote.md", "remote");

  const result = await backend.sync({
    entry,
    validation: { ok: true, issues: [] },
  });

  expect(result).toMatchObject({
    mode: "shared",
    outcome: "synced",
    branch: "user/tester/hub",
    committed: true,
    pushed: true,
  });
  expect(await git.currentBranch(root)).toBe("user/tester/hub");
});

it("publishes or reuses a PR only when requested", async () => {
  const origin = await makeOrigin();
  const root = await makeTempDir();
  cleanups.push(root);
  const git = new Git(testRun);
  await git.clone(origin, root);
  const gh = new FakeGh("tester");
  const backend = new GitBackend(git, gh as unknown as Gh);
  const entry = gitEntry(root, origin, "user/tester/hub");
  await writeFile(join(root, "note.md"), "x", "utf8");

  const synced = await backend.sync({
    entry,
    validation: { ok: true, issues: [] },
  });
  expect(synced.prUrl).toBeUndefined();

  const published = await backend.sync({
    entry,
    validation: { ok: true, issues: [] },
    action: "publish-pr",
  });
  expect(published).toMatchObject({
    outcome: "published",
    prUrl: "https://github.com/test/x/pull/1",
  });
  expect(gh.prCalls).toHaveLength(1);
});
```

Define `gitEntry()` with the v2 Git backend descriptor and shared sync config.
`FakeGh` implements `currentLogin()`, `findOpenPr()`, and `createPr()`. Add a
second `publish-pr` call where `findOpenPr()` returns the first URL and assert
`createPr()` is not called again.

Add a direct auto-mode regression using the same adapter and temp repo.

- [ ] **Step 2: Run sync tests and verify shared behavior fails**

Run:

```powershell
npx vitest run test\git-backend.test.ts
```

Expected: FAIL because `GitBackend` does not exist.

- [ ] **Step 3: Implement Git mode/config validation**

Create `src/sync/gitBackend.ts` with strict schemas:

```ts
const gitConfigSchema = z.object({
  origin: repoUrlSchema,
}).strict();

const autoConfigSchema = z.object({}).strict();
const sharedConfigInputSchema = z.object({
  branch: z.string().min(1).optional(),
}).strict();
const sharedConfigSchema = z.object({
  branch: z.string().min(1),
}).strict();
```

Implement:

```ts
async resolveSync(selection: SyncSelection): Promise<SyncSelection> {
  if (selection.mode === "auto") {
    return { mode: "auto", config: autoConfigSchema.parse(selection.config) };
  }
  const input = sharedConfigInputSchema.parse(selection.config);
  const branch = input.branch ?? `user/${await this.gh.currentLogin()}/hub`;
  if (branch === "main" || !(await this.git.isValidBranchName(branch))) {
    throw new OkhError("INVALID_ARGUMENT", `Invalid shared branch "${branch}".`);
  }
  return { mode: "shared", config: sharedConfigSchema.parse({ branch }) };
}

actions(selection: SyncSelection): readonly string[] {
  return selection.mode === "shared" ? ["publish-pr"] : [];
}
```

Wrap a failed login lookup with an error that requests an explicit branch or
`gh auth login`.

- [ ] **Step 4: Implement Git auto sync**

Move the current `syncAuto` behavior from `ContainerService` into a private
`syncAuto(request)` method. Return:

```ts
{
  mode: "auto",
  outcome: committed ? "synced" : "up-to-date",
  committed,
  pushed: true,
  branch,
}
```

Reject any action in auto mode and continue using `pull --ff-only`.

- [ ] **Step 5: Implement shared branch checkout and sync**

Add:

```ts
private async ensureSharedBranch(root: string, branch: string): Promise<void> {
  await this.git.fetchRemote(root, "origin");
  if (await this.git.localBranchExists(root, branch)) {
    await this.git.checkout(root, branch);
  } else if (await this.git.remoteBranchExists(root, "origin", branch)) {
    await this.git.checkoutTracking(root, branch, `origin/${branch}`);
  } else {
    await this.git.createBranchFrom(root, branch, "origin/main");
  }
}
```

Then implement shared sync in this order:

```ts
await this.ensureSharedBranch(root, branch);
await this.git.stageAll(root);
if (await this.git.hasStagedChanges(root)) {
  await this.git.commit(root, message ?? `okh: sync ${entry.name}`);
  committed = true;
}
await this.git.fetchRemote(root, "origin");
try {
  await this.git.rebase(root, "origin/main");
} catch (primary) {
  try {
    await this.git.abortRebase(root);
  } catch (abort) {
    throw new AggregateError([primary, abort], `Shared sync rebase and abort failed for "${entry.name}".`);
  }
  throw new OkhError(
    "GIT_ERROR",
    `Shared sync rebase failed for "${entry.name}": ${(primary as Error).message}`,
    `Resolve the conflict on "${branch}" and retry.`,
  );
}
await this.git.push(root, "origin", branch);
```

Return `outcome: committed ? "synced" : "up-to-date"` with branch and push
details.

- [ ] **Step 6: Implement idempotent `publish-pr`**

After shared sync completes:

```ts
const existing = await this.gh.findOpenPr({
  cwd: root,
  base: "main",
  head: branch,
});
const prUrl = existing ?? await this.gh.createPr({
  cwd: root,
  base: "main",
  head: branch,
  title: request.message ?? `okh sync: ${entry.name}`,
  body: "Automated OKH sync.",
});
return {
  ...sharedResult,
  requestedAction: "publish-pr",
  outcome: "published",
  prUrl,
};
```

Reject unknown actions with `Supported actions: publish-pr`.

- [ ] **Step 7: Add rebase-conflict and retry tests**

Add real-repo coverage that creates conflicting edits on shared and main,
expects `GIT_ERROR`, verifies no rebase remains in progress, and verifies the
local shared commit still exists. Add a fake-Gh failure case asserting the
branch remains pushed and a retry publishes successfully.

- [ ] **Step 8: Run focused Git sync tests**

Run:

```powershell
npx vitest run test\git-backend.test.ts test\git-primitives.test.ts
npm run typecheck:server
```

Expected: PASS.

- [ ] **Step 9: Commit Git backend**

```powershell
git add src\sync\gitBackend.ts test\git-backend.test.ts
git commit -m "feat: add git shared sync backend"
```

## Task 5: Route container operations through adapters

**Files:**
- Modify: `src/container/service.ts`
- Modify: `src/container/migrate.ts`
- Modify: `src/sync/backendRegistry.ts`
- Modify: `test/service.test.ts`
- Modify: `test/add-confirm.test.ts`
- Modify: `test/inspect.test.ts`
- Modify: `test/review-fixes.test.ts`
- Modify: `test/migrate.test.ts`
- Modify: `test/sync.test.ts`

- [ ] **Step 1: Write failing structured add, inspect, and action tests**

Update service tests to assert:

```ts
expect(entry.backend).toEqual({ type: "git", config: { origin } });
expect(entry.sync).toEqual({ mode: "auto", config: {} });
```

Add:

```ts
it("shows resolved shared config and actions in container status", async () => {
  const origin = await makeOrigin();
  const { service } = await setup();
  await service.addContainer({
    source: origin,
    name: "team",
    sync: { mode: "shared", config: { branch: "user/alice/hub" } },
    create: true,
  });
  await expect(service.status("team")).resolves.toMatchObject({
    backend: "git",
    sync: { mode: "shared", config: { branch: "user/alice/hub" } },
    syncActions: ["publish-pr"],
  });
});

it("requires a named container for an action", async () => {
  const { service } = await setup();
  await expect(service.sync(undefined, undefined, "publish-pr"))
    .rejects.toThrow(/specific container|named container/i);
});
```

In `test/sync.test.ts`, retain the existing auto and local-backend regression
tests, replace the generated PR-branch cases with service-level shared branch
creation/tracking/rebase tests, and add service-level `publish-pr` creation and
existing-PR reuse cases. Use v2 registry entries throughout.

- [ ] **Step 2: Run service-focused tests**

Run:

```powershell
npx vitest run test\service.test.ts test\add-confirm.test.ts test\inspect.test.ts test\review-fixes.test.ts test\migrate.test.ts test\sync.test.ts
```

Expected: FAIL on old flat entry shapes and service dispatch.

- [ ] **Step 3: Add default backend registry construction**

Export from `src/sync/backendRegistry.ts`:

```ts
export function createBackendRegistry(git = new Git(), gh = new Gh()): BackendRegistry {
  return new BackendRegistry([
    new GitBackend(git, gh),
    new PassiveBackend("local"),
    new PassiveBackend("onedrive"),
  ]);
}
```

In `ContainerService`, keep current injection compatibility:

```ts
constructor(
  private readonly paths: OkhPaths,
  private readonly git: Git = new Git(),
  private readonly gh: Gh = new Gh(),
  private readonly backends: BackendRegistry = createBackendRegistry(git, gh),
) {}
```

Add a private registry loader:

```ts
private async loadRegistry(): Promise<Registry> {
  const registry = await loadRegistry(this.paths, {
    resolveGitLogin: () => this.gh.currentLogin(),
  });
  await this.backends.validateEntries(registry.containers);
  return registry;
}
```

Replace service-level `loadRegistry(this.paths)` calls with `this.loadRegistry()`.

- [ ] **Step 4: Change service public models to structured sync**

Use:

```ts
export interface AddContainerInput {
  source: string;
  name?: string;
  sync?: {
    mode: SyncMode;
    config?: Record<string, unknown>;
  };
  backend?: "local" | "onedrive";
  create?: boolean;
}

export interface SyncResult extends BackendSyncResult {
  name: string;
  backend: BackendType;
  validation: { ok: boolean; issues: string[] };
  error?: string;
}
```

Add `syncActions: string[]` to `ContainerStatus` and inspect summary records.
Keep `ResolvedContainer.backend` as the display string and change
`ResolvedContainer.sync` to the structured descriptor.

- [ ] **Step 5: Resolve backend and sync config during add**

In `planAddContainer`:

```ts
const backendType: BackendType = isGit ? "git" : (input.backend ?? "local");
const backendConfig = this.backends.resolveBackendConfig(
  backendType,
  isGit ? { origin: input.source } : {},
);
const sync = await this.backends.resolveSync(
  backendType,
  {
    mode: input.sync?.mode ?? "auto",
    config: input.sync?.config ?? {},
  },
  { containerName: name },
);
```

Store `{ type: backendType, config: backendConfig }` and `sync` in the plan.
Show the resolved branch in previews. Clone using
`entry.backend.config.origin` after strict string validation.

- [ ] **Step 6: Replace service Git mode branches with adapter dispatch**

Change the signature:

```ts
async sync(name?: string, message?: string, action?: string): Promise<SyncResult[]>
```

Reject `action && !name`. In `syncOne`:

```ts
const validation = await this.validate(entry.name);
const backend = this.backends.require(entry.backend.type);
const result = await backend.sync({ entry, validation, message, action });
return {
  name: entry.name,
  backend: entry.backend.type,
  validation,
  ...result,
};
```

Delete `syncAuto`, `syncPr`, generated-branch cleanup helpers, and PR-specific
result fields now owned by `GitBackend`. Preserve sync-all error isolation and
include `mode` plus `requestedAction` in error results.

- [ ] **Step 7: Map legacy container manifests safely**

In `src/container/migrate.ts`, use a local legacy schema and separate deletion
from module migration:

```ts
const legacySyncModeSchema = z.enum(["auto", "pr"]);
export type LegacySyncMode = z.infer<typeof legacySyncModeSchema>;

export async function removeLegacyContainerManifest(root: string): Promise<void> {
  await rm(join(root, LEGACY_REL), { force: true });
}
```

`migrateLegacyContainerManifest()` still writes missing per-module manifests and
returns `LegacySyncMode | undefined`, but no longer deletes the legacy file. In
`ContainerService`, when it returns `pr`:

- Git: resolve `{ mode: "shared", config: {} }` through the Git adapter so login
  defaulting and validation are reused.
- local/OneDrive: resolve `{ mode: "auto", config: {} }`.

Persist the structured result, then call `removeLegacyContainerManifest(root)`.
If resolution or registry persistence fails, do not remove the legacy file.
Update `test/migrate.test.ts` to assert the migration function leaves the file
until the explicit remove call, and update `test/review-fixes.test.ts` to assert
service-driven migration removes it only after registry persistence.

- [ ] **Step 8: Run service, migration, and sync tests**

Run:

```powershell
npx vitest run test\registry.test.ts test\migrate.test.ts test\review-fixes.test.ts test\service.test.ts test\add-confirm.test.ts test\inspect.test.ts test\sync.test.ts
npm run typecheck:server
```

Expected: PASS.

- [ ] **Step 9: Commit service integration**

```powershell
git add src\container src\sync\backendRegistry.ts test\service.test.ts test\add-confirm.test.ts test\inspect.test.ts test\review-fixes.test.ts test\migrate.test.ts
git commit -m "refactor: dispatch container sync through backends"
```

## Task 6: Update the MCP tool surface and formatting

**Files:**
- Modify: `src/server/toolSchemas.ts`
- Modify: `src/server/tools.ts`
- Modify: `src/prompts/index.ts`
- Modify: `resources/tool-meta/add_container.md`
- Modify: `resources/tool-meta/sync.md`
- Modify: `test/server.test.ts`
- Modify: `test/toolMeta.test.ts`
- Modify: `test/prompts.test.ts`

- [ ] **Step 1: Write failing MCP contract tests**

Add server tests:

```ts
const preview = await client.callTool({
  name: "add_container",
  arguments: {
    source: origin,
    name: "team",
    sync: { mode: "shared", config: { branch: "user/alice/hub" } },
  },
});
expect(textOf(preview)).toContain("shared");
expect(textOf(preview)).toContain("user/alice/hub");

const invalid = await client.callTool({
  name: "sync",
  arguments: { action: "publish-pr" },
});
expect(isErrorResult(invalid)).toBe(true);
expect(textOf(invalid)).toMatch(/container/i);
```

Add an inspect formatting assertion for:

```text
Sync: shared (branch=user/alice/hub)
Actions: publish-pr
```

- [ ] **Step 2: Run server/tool metadata tests**

Run:

```powershell
npx vitest run test\server.test.ts test\toolMeta.test.ts test\prompts.test.ts
```

Expected: FAIL on old tool shapes and formatting.

- [ ] **Step 3: Update tool schemas**

In `src/server/toolSchemas.ts`:

```ts
const syncSelection = z.object({
  mode: z.enum(["auto", "shared"]),
  config: z.record(z.string(), z.unknown()).optional(),
}).strict();

add_container: {
  source: z.string(),
  name: z.string().optional(),
  sync: syncSelection.optional(),
  backend: z.enum(["local", "onedrive"]).optional(),
  create: z.boolean().optional(),
},
sync: {
  container,
  message: z.string().optional(),
  action: z.string().min(1).optional(),
},
```

- [ ] **Step 4: Update handlers and result formatting**

Pass structured `sync` unchanged to `service.addContainer`. Pass
`args.action` as the third `service.sync` argument.

Format normalized results:

```ts
const details = [
  r.branch ? `branch=${r.branch}` : undefined,
  r.prUrl ? `PR=${r.prUrl}` : undefined,
].filter(Boolean).join(" ");
return `- ${r.name} [${r.backend}/${r.mode}] ${r.outcome} (${validation})${details ? ` ${details}` : ""}`;
```

For shared results without `publish-pr`, append:

```text
Changes are on <branch>. When ready to publish, call sync with action "publish-pr".
```

Update add-plan formatting to include effective mode and config.

- [ ] **Step 5: Update prompt target formatting and metadata**

In `src/prompts/index.ts`, render:

```ts
function renderSync(sync: ResolvedContainer["sync"]): string {
  const config = Object.entries(sync.config)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(", ");
  return config ? `${sync.mode} (${config})` : sync.mode;
}
```

Use it in target and run headers. Update tool metadata argument docs and
descriptions to explain `shared`, `config.branch`, `action`, and the
named-container rule.

- [ ] **Step 6: Run MCP tests**

Run:

```powershell
npx vitest run test\server.test.ts test\toolMeta.test.ts test\prompts.test.ts
npm run typecheck:server
```

Expected: PASS.

- [ ] **Step 7: Commit MCP surface changes**

```powershell
git add src\server src\prompts\index.ts resources\tool-meta test\server.test.ts test\toolMeta.test.ts test\prompts.test.ts
git commit -m "feat: expose shared sync actions"
```

## Task 7: Remove ordinary write confirmation and update evals

**Files:**
- Modify: `resources/prompts/partials/write-policy.md`
- Modify: `resources/prompts/instructions.md`
- Modify: `resources/prompts/onboard.md`
- Modify: `resources/module-types/memory/skills/remember/SKILL.md`
- Modify: `resources/module-types/memory/skills/todo/SKILL.md`
- Modify: `test/prompts.test.ts`
- Modify: `test/run.test.ts`
- Modify: `eval/assertions/checks.ts`
- Modify: `eval/scenarios/remember/todo.yaml`
- Modify: `eval/scenarios/todo/complete.yaml`

- [ ] **Step 1: Write failing prompt-policy tests**

Update `test/run.test.ts` to require direct application:

```ts
expectTerms(remember.body, [
  /operation:\s*"create"/i,
  /apply:\s*true/i,
  /summar/i,
  /sync/i,
]);
expect(remember.body).not.toMatch(/needsConfirmation|wait for confirmation|omit `apply`/i);

expectTerms(todo.body, [
  /operation:\s*"update"/i,
  /apply:\s*true/i,
  /summar/i,
  /sync/i,
]);
expect(todo.body).not.toMatch(/needsConfirmation|wait for confirmation|omit `apply`/i);
```

In `test/prompts.test.ts`, assert the rendered write policy says:

```ts
expect(text).toContain("Do not ask for confirmation");
expect(text).toContain("summarize");
expect(text).toContain("call `sync` immediately");
expect(text).toContain('action "publish-pr"');
expect(text).not.toContain("get explicit confirmation before persisting");
```

- [ ] **Step 2: Run prompt tests and verify old policy fails**

Run:

```powershell
npx vitest run test\run.test.ts test\prompts.test.ts
```

Expected: FAIL on old preview/confirmation instructions.

- [ ] **Step 3: Rewrite the shared write policy**

Set `resources/prompts/partials/write-policy.md` to:

```md
## Write policy

If this skill edits files or applies a content/todo mutation:
1. Choose exactly one target container/module.
2. Make the requested change without asking for confirmation.
3. Inspect and summarize the resulting changes.
4. Call `sync` immediately for the affected container; do not wait for approval.
5. Report the change summary and sync outcome.

For shared mode, plain sync pushes the configured branch but does not publish it.
Tell the user to call `sync` with action `"publish-pr"` when ready to publish.
Container and module setup keep their separate preview/confirmation workflows.
```

- [ ] **Step 4: Rewrite remember/todo mutation steps**

In `remember/SKILL.md`, replace steps 7-10 with one direct applied call:

```md
7. Call `todos` once with `operation: "create"`, `apply: true`, `container`,
   `module`, `text`, `entrySummary`, `observation`, `labels`, and optional
   `due` / `priority`.
8. Inspect and summarize the applied todo and any memory entry written with it.
9. Call `sync` immediately for the affected container.
```

In `todo/SKILL.md`, replace steps 5-8 with:

```md
5. Call `todos` once with `operation: "create"` or `operation: "update"` and
   `apply: true` for the single intended mutation.
6. Inspect and summarize the applied change.
7. Call `sync` immediately for the affected container.
```

Remove all claims that confirmation is required. Keep preview support in the
deterministic API for explicit user review requests.

- [ ] **Step 5: Remove instruction contradictions**

Update `resources/prompts/instructions.md` to describe `auto` and `shared`.
Change the onboarding warning to:

```md
Never create folders or initialize container/module setup without explicit
confirmation. Ordinary content and todo workflows apply their changes and sync
without a separate confirmation step.
```

- [ ] **Step 6: Replace the eval preview/apply assertion**

In `eval/assertions/checks.ts`, rename the check kind:

```ts
| { kind: "todo-apply-sync"; operation: "create" | "update" };
```

Implement `checkTodoApplySync` to find exactly one successful mutation with
`apply: true`, reject an earlier matching applied mutation, and require a later
successful `sync`. It must not require a preview or a later turn.

Update the switch case to call the new check.

- [ ] **Step 7: Make todo eval scenarios single-turn**

Remove confirmation turns from both YAML files. Prompts should request direct
application and sync:

```yaml
prompt: |
  Use the open-knowledge-hub MCP tools. In container "kb-hub", module "mem",
  remember that I need to buy printer ink by 2026-07-15. It is high priority
  and labeled shopping. Apply the todo, summarize the change, and sync it
  without asking for confirmation.
terminal:
  after: start
  requiredTools: [run, todos, sync]
```

Use `check: { kind: todo-apply-sync, operation: create }` and the equivalent
update check. Rewrite judge text to require direct apply, summary, and sync.

- [ ] **Step 8: Run prompt and eval-only validation**

Run:

```powershell
npx vitest run test\run.test.ts test\prompts.test.ts
npm run typecheck:eval
npm run test:eval
npm run eval:validate
```

Expected: PASS.

- [ ] **Step 9: Commit policy and eval changes**

```powershell
git add resources\prompts resources\module-types\memory\skills test\run.test.ts test\prompts.test.ts eval
git commit -m "refactor: sync ordinary writes without confirmation"
```

## Task 8: Update public documentation and complete regression validation

**Files:**
- Modify: `README.md`
- Modify: `USAGE.md`

- [ ] **Step 1: Update README contracts and examples**

Document:

- registry entries use structured backend/sync descriptors;
- `auto` exists for all backends;
- Git `shared` uses `config.branch`, defaulting to `user/<gh-login>/hub`;
- `sync { container }` pushes the shared branch without opening a PR;
- `sync { container, action: "publish-pr" }` opens or returns the PR to `main`;
- `gh` is needed for shared branch defaulting and PR publication;
- normal todo/content flows apply and sync without confirmation;
- todo preview remains available when explicitly requested.

Update the operational tool table:

```md
| `add_container` | `source`, `name?`, `sync?`, `backend?`, `create?` | Register a container; `sync` is `{ mode, config? }`. |
| `sync` | `container?`, `message?`, `action?` | Validate and synchronize; Git shared mode supports `publish-pr`. |
```

- [ ] **Step 2: Update USAGE examples**

Replace old PR-mode language with:

```md
- **Sync:** `hub, sync my container.` pushes according to its mode.
- **Publish:** `hub, sync and publish a PR for my shared container.`

`auto` syncs to the backend's default destination. Git `shared` syncs to its
configured branch; publication is a separate `publish-pr` action.
```

State that agents summarize ordinary writes and sync immediately without asking
for approval.

- [ ] **Step 3: Run the focused regression suite**

Run:

```powershell
npx vitest run test\registry.test.ts test\migrate.test.ts test\review-fixes.test.ts test\sync-backends.test.ts test\git-primitives.test.ts test\sync.test.ts test\service.test.ts test\add-confirm.test.ts test\inspect.test.ts test\server.test.ts test\toolMeta.test.ts test\prompts.test.ts test\run.test.ts
```

Expected: PASS.

- [ ] **Step 4: Run all non-live validation**

Run:

```powershell
npm test
npm run build
npm run typecheck
npm run typecheck:eval
npm run test:eval
npm run eval:validate
npm pack --dry-run
```

Expected: every command exits 0.

- [ ] **Step 5: Run the final end-to-end eval**

Development must be complete before this step. The eval harness launches
`dist/index.js`, so keep the successful build from Step 4.

Run:

```powershell
npm run eval
```

Expected: all configured live scenarios pass, including direct todo apply/sync
behavior.

- [ ] **Step 6: Review the final diff for stale PR-mode language**

Run:

```powershell
rg -n 'sync:\s*pr|"pr"|PR mode|opens a pull request|asks before syncing|needsConfirmation' src test resources README.md USAGE.md eval
git --no-pager diff --check
git --no-pager status --short
```

Expected: remaining `pr` occurrences are only migration fixtures, GitHub PR
operations, `publish-pr`, or intentional historical text. Diff check is clean.

- [ ] **Step 7: Commit documentation and final regression fixes**

```powershell
git add README.md USAGE.md
git add -u
git commit -m "docs: describe shared sync workflow"
```
