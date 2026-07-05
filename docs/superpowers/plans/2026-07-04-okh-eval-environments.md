# OKH eval environment abstraction — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `eval/provision.ts` with a single `eval/environments.ts` that both defines 3 named eval environments (`empty`, `git`, `local-and-git`) and materializes them, and collapse every scenario's provisioning vars into one `env` var (dropping `scenario`, `backend`, `container`, `fixture`, `provision`, `container2`, `fixture2`).

**Architecture:** `environments.ts` exports a typed `environments` map plus `provisionEnvironment(env, { repoRoot, label, runner })`, absorbing all of provision.ts's filesystem/git/mcp-config logic. Each env is `{ placement: "registered" | "workspace", hubs: EnvHub[] }`; `hubs[0]` is primary (drives `containerPath`/`fixtureDir`/`originPath`). The provider and manual harness resolve `vars.env` → `provisionEnvironment`. `provision.ts` and `provision.test.ts` are deleted.

**Tech Stack:** TypeScript (NodeNext, `.js` import specifiers), tsx, vitest, promptfoo (0.120.x), Windows PowerShell.

**Spec:** `docs/superpowers/specs/2026-07-04-okh-eval-environments-design.md`

---

## Scenario → environment mapping (authoritative)

| env | scenarios (16 total) |
|-----|----------------------|
| `local-and-git` (9) | ask-grounded, ask-declines-when-absent, ask-multi-container, context-assembly, context-includes-skills-tools, learn-rejects-trivial, reflect-insights, remember-records, remember-no-conclusions |
| `git` (1) | learn-integrates |
| `empty` (6) | onboard-add-existing-folder, onboard-add-github, onboard-create-local, onboard-explains, onboard-phrase, onboard-wake-phrase |

## File structure

- **Create** `eval/environments.ts` — env map + types (`EvalBackend`, `EnvHub`, `Environment`, `Provisioned`, `EnvName`) + `isEnvName()` + `provisionEnvironment()`.
- **Create** `eval-test/environments.test.ts` — replaces `provision.test.ts`.
- **Delete** `eval/provision.ts`, `eval-test/provision.test.ts`.
- **Modify** `eval/provider/copilotProvider.ts`, `eval/okh-eval.ts`, all 16 `test.yaml`, `eval-test/config.test.ts`, `eval-test/okh-eval.test.ts`, `eval/MANUAL-TESTING.md`.

---

### Task 1: Create `eval/environments.ts` (definitions + provisioning)

**Files:**
- Create: `eval/environments.ts`
- Create (test): `eval-test/environments.test.ts`

- [ ] **Step 1: Write the failing test** — create `eval-test/environments.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { provisionEnvironment, environments, isEnvName } from "../eval/environments.js";
import { makeTempDir, testRun } from "../test/helpers.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const exists = async (p: string) => !!(await stat(p).catch(() => null));

describe("environments", () => {
  it("defines exactly empty, git, local-and-git", () => {
    expect(Object.keys(environments).sort()).toEqual(["empty", "git", "local-and-git"]);
    expect(isEnvName("git")).toBe(true);
    expect(isEnvName("nope")).toBe(false);
  });

  it("local-and-git registers a local kb-hub + a git git-hub with isolated homes + mcp-config", async () => {
    const prov = await provisionEnvironment("local-and-git", { repoRoot: "C:/repo", runner: testRun });
    cleanups.push(prov.root);
    const reg = JSON.parse(await readFile(join(prov.okhHome, "registry.json"), "utf8"));
    const byName = Object.fromEntries(reg.containers.map((c: { name: string }) => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual(["git-hub", "kb-hub"]);
    expect(byName["kb-hub"].backend).toBe("local");
    expect(byName["git-hub"].backend).toBe("git");
    // primary is kb-hub (local): containerPath registered, no origin
    expect(byName["kb-hub"].localPath).toBe(prov.containerPath);
    expect(prov.originPath).toBeUndefined();
    expect(prov.fixtureDir.replace(/\\/g, "/")).toContain("fixtures/kb-hub");
    const mcp = JSON.parse(await readFile(join(prov.copilotHome, "mcp-config.json"), "utf8"));
    expect(mcp.mcpServers["open-knowledge-hub"].env.OKH_HOME).toBe(prov.okhHome);
  });

  it("git seeds a bare origin for the single git hub", async () => {
    const prov = await provisionEnvironment("git", { repoRoot: "C:/repo", runner: testRun });
    cleanups.push(prov.root);
    expect(prov.originPath).toBeTruthy();
    const reg = JSON.parse(await readFile(join(prov.okhHome, "registry.json"), "utf8"));
    expect(reg.containers[0].backend).toBe("git");
    expect(reg.containers[0].origin).toBe(prov.originPath);
    const verify = await makeTempDir("okh-verify-"); cleanups.push(verify);
    await testRun("git", ["clone", prov.originPath!, join(verify, "c")]);
    expect(await exists(join(verify, "c", "kb"))).toBe(true);
  });

  it("empty leaves an empty registry with an unregistered notes folder in the workspace", async () => {
    const prov = await provisionEnvironment("empty", { repoRoot: "C:/repo", runner: testRun });
    cleanups.push(prov.root);
    const reg = JSON.parse(await readFile(join(prov.okhHome, "registry.json"), "utf8"));
    expect(reg.containers).toHaveLength(0);
    expect(prov.containerPath.startsWith(prov.workspace)).toBe(true);
    expect(await exists(join(prov.workspace, "notes"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd 'D:\work\open-knowledge-hub'; npx vitest run --config vitest.eval.config.ts eval-test/environments.test.ts`
Expected: FAIL — cannot find module `../eval/environments.js`.

- [ ] **Step 3: Create `eval/environments.ts`**

```ts
import { mkdir, mkdtemp, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { run } from "../src/exec.js";
import { Git } from "../src/git/git.js";
import { emptyRegistry, type ContainerEntry } from "../src/registry/schema.js";
import { saveRegistry, withContainerAdded } from "../src/registry/registry.js";
import type { OkhPaths } from "../src/config.js";

const EVAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));

export type EvalBackend = "local" | "git-auto";

/** One hub within an environment. `fixture` is relative to eval/ (or absolute). */
export interface EnvHub {
  container: string;
  fixture: string;
  backend?: EvalBackend; // default "local"
}

/**
 * An eval environment. `placement: "registered"` copies each hub into the OKH
 * registry (seeding a bare git origin for git-auto hubs); `placement: "workspace"`
 * drops each hub as an UNREGISTERED folder in the working dir (registry stays empty).
 * hubs[0] is the primary hub (drives containerPath/fixtureDir/originPath).
 */
export interface Environment {
  placement: "registered" | "workspace";
  hubs: EnvHub[];
}

export const environments = {
  // Empty registry + an unregistered `notes` folder in the workspace. Serves all
  // onboarding scenarios (add-existing-folder, add-github, create-local, explains,
  // phrase, wake-phrase).
  empty: {
    placement: "workspace",
    hubs: [{ container: "notes", fixture: "fixtures/plain-notes" }],
  },
  // Single git-backed hub with a push origin — for sync (learn-integrates).
  git: {
    placement: "registered",
    hubs: [{ container: "git-hub", fixture: "fixtures/git-hub", backend: "git-auto" }],
  },
  // Local kb-hub + git git-hub, both registered — for local-folder and multi-hub cases.
  "local-and-git": {
    placement: "registered",
    hubs: [
      { container: "kb-hub", fixture: "fixtures/kb-hub", backend: "local" },
      { container: "git-hub", fixture: "fixtures/git-hub", backend: "git-auto" },
    ],
  },
} satisfies Record<string, Environment>;

export type EnvName = keyof typeof environments;

export function isEnvName(v: unknown): v is EnvName {
  return typeof v === "string" && Object.prototype.hasOwnProperty.call(environments, v);
}

export interface Provisioned {
  root: string;
  okhHome: string;
  copilotHome: string;
  workspace: string;
  /** Primary hub's local path (workspace/<name> for a workspace-placed hub). */
  containerPath: string;
  /** Primary hub's resolved fixture dir (used by okf-valid requireChanged). */
  fixtureDir: string;
  /** Primary hub's bare origin, if git-backed. */
  originPath?: string;
}

const fixturePath = (f: string): string => (isAbsolute(f) ? f : resolve(EVAL_ROOT, f));

/** Register one hub into the OKH containers dir; seed a bare origin for git-auto. */
async function registerHub(
  hub: EnvHub,
  containersDir: string,
  root: string,
  git: Git,
  runner: typeof run,
): Promise<{ entry: ContainerEntry; originPath?: string }> {
  const fixtureDir = fixturePath(hub.fixture);
  if ((hub.backend ?? "local") === "git-auto") {
    const originPath = join(root, `${hub.container}-origin.git`);
    await runner("git", ["init", "--bare", "-b", "main", originPath]);
    const seed = join(root, `${hub.container}-seed`);
    await runner("git", ["clone", originPath, seed]);
    await cp(fixtureDir, seed, { recursive: true });
    await runner("git", ["add", "-A"], { cwd: seed });
    await runner("git", ["commit", "-m", "seed"], { cwd: seed });
    await runner("git", ["push", "origin", "main"], { cwd: seed });
    const clone = join(containersDir, hub.container);
    await git.clone(originPath, clone);
    return {
      entry: { name: hub.container, backend: "git", origin: originPath, localPath: clone, addedAt: new Date().toISOString() },
      originPath,
    };
  }
  const dir = join(containersDir, hub.container);
  await cp(fixtureDir, dir, { recursive: true });
  return { entry: { name: hub.container, backend: "local", localPath: dir, addedAt: new Date().toISOString() } };
}

/**
 * Build a fully isolated workspace for one eval run against a named environment:
 * an OKH_HOME (registry per the env), a COPILOT_HOME whose mcp-config launches the
 * built OKH server against that OKH_HOME, and a working directory.
 */
export async function provisionEnvironment(
  env: EnvName,
  opts: { repoRoot: string; label?: string; runner?: typeof run },
): Promise<Provisioned> {
  const def = environments[env];
  const runner = opts.runner ?? run;
  const git = new Git(runner);

  const root = await mkdtemp(join(tmpdir(), `okh-eval-${opts.label ?? env}-`));
  const okhHome = join(root, "okh-home");
  const copilotHome = join(root, "copilot-home");
  const workspace = join(root, "workspace");
  const containersDir = join(okhHome, "containers");
  await mkdir(containersDir, { recursive: true });
  await mkdir(copilotHome, { recursive: true });
  await mkdir(workspace, { recursive: true });

  const paths: OkhPaths = {
    home: okhHome,
    containersDir,
    registryFile: join(okhHome, "registry.json"),
    preferencesFile: join(okhHome, "preferences.json"),
  };

  const primary = def.hubs[0];
  const primaryFixtureDir = fixturePath(primary.fixture);
  let containerPath = "";
  let originPath: string | undefined;

  if (def.placement === "workspace") {
    for (const hub of def.hubs) {
      const dest = join(workspace, hub.container);
      await cp(fixturePath(hub.fixture), dest, { recursive: true });
      if (hub === primary) containerPath = dest;
    }
    await saveRegistry(paths, emptyRegistry());
  } else {
    let registry = emptyRegistry();
    for (const hub of def.hubs) {
      const { entry, originPath: hubOrigin } = await registerHub(hub, containersDir, root, git, runner);
      registry = withContainerAdded(registry, entry);
      if (hub === primary) {
        containerPath = entry.localPath;
        originPath = hubOrigin;
      }
    }
    await saveRegistry(paths, registry);
  }

  await writeMcpConfig(copilotHome, opts.repoRoot, okhHome);
  return { root, okhHome, copilotHome, workspace, containerPath, fixtureDir: primaryFixtureDir, originPath };
}

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

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd 'D:\work\open-knowledge-hub'; npx vitest run --config vitest.eval.config.ts eval-test/environments.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck**

Run: `cd 'D:\work\open-knowledge-hub'; npm run typecheck:eval`
Expected: exit 0. (Note: `provision.ts` still exists and is unused by `environments.ts`; that's fine — it is removed in Task 6.)

- [ ] **Step 6: Commit**

```powershell
cd 'D:\work\open-knowledge-hub'
git add eval/environments.ts eval-test/environments.test.ts
git commit -m "feat(eval): environments.ts — define + provision 3 eval environments

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 2: Switch the provider to environments

**Files:**
- Modify: `eval/provider/copilotProvider.ts`
- Modify (test): `eval-test/provider.test.ts`

- [ ] **Step 1: Rewrite the provider test** — replace the entire body of `eval-test/provider.test.ts` with:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { rm, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import CopilotProvider from "../eval/provider/copilotProvider.js";
import type { CopilotRunner } from "../eval/copilot.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const exists = async (p: string) => !!(await stat(p).catch(() => null));

describe("CopilotProvider", () => {
  it("provisions the env, runs the (faked) copilot, and returns transcript + metadata", async () => {
    const fake: CopilotRunner = async (opts) => {
      expect(opts.copilotHome).toContain("copilot-home");
      expect(opts.prompt).toBe("answer: how does auth work?");
      return { transcript: "Calling open-knowledge-hub__ask ... done", code: 0 };
    };
    const provider = new CopilotProvider({ config: { model: "test-model", runner: fake } });
    expect(provider.id()).toBeTruthy();

    const res = await provider.callApi("answer: how does auth work?", {
      vars: { env: "local-and-git" },
      test: { description: "ask-grounded" },
    });
    cleanups.push(res.metadata.workspace);

    expect(res.output).toContain("done");
    expect(res.metadata.toolCalls).toContain("ask");
    // primary hub (kb-hub) is registered with an okh manifest
    expect(await exists(join(res.metadata.containerPath, ".okh", "okh.yaml"))).toBe(true);
  });

  it("empty env yields an empty registry + an unregistered notes folder", async () => {
    const provider = new CopilotProvider({ config: { runner: async () => ({ transcript: "ok", code: 0 }) } });
    const res = await provider.callApi("prompt", {
      vars: { env: "empty" },
      test: { description: "onboard-explains" },
    });
    cleanups.push(res.metadata.workspace);
    const reg = JSON.parse(await readFile(join(res.metadata.okhHome, "registry.json"), "utf8"));
    expect(reg.containers).toHaveLength(0);
  });
});
```

Note: `res.metadata.workspace` is the temp **root** (see provider code below), so pushing it to cleanups removes the whole run dir.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd 'D:\work\open-knowledge-hub'; npx vitest run --config vitest.eval.config.ts eval-test/provider.test.ts`
Expected: FAIL — the current provider reads `vars.fixture`/`vars.backend`, not `vars.env`.

- [ ] **Step 3: Replace `eval/provider/copilotProvider.ts` with:**

```ts
import { provisionEnvironment, isEnvName } from "../environments.js";
import { spawnCopilot, extractToolCalls, type CopilotRunner } from "../copilot.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const EVAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(EVAL_ROOT, "..");

interface ProviderOptions {
  id?: string;
  config?: { model?: string; timeoutMs?: number; runner?: CopilotRunner };
}

interface CallContext {
  vars?: Record<string, unknown>;
  test?: { description?: string };
}

/** promptfoo custom provider: provision a named environment, run `copilot -p`, return transcript + metadata. */
export default class CopilotProvider {
  private readonly providerId: string;
  private readonly config: NonNullable<ProviderOptions["config"]>;

  constructor(options: ProviderOptions = {}) {
    this.providerId = options.id ?? "copilot-cli";
    this.config = options.config ?? {};
  }

  id(): string {
    return this.providerId;
  }

  async callApi(prompt: string, context: CallContext = {}) {
    const vars = context.vars ?? {};
    const env = vars.env;
    if (!isEnvName(env)) {
      throw new Error(`scenario is missing a valid \`env\` var (got ${JSON.stringify(env)})`);
    }
    const label = context.test?.description ?? env;

    const prov = await provisionEnvironment(env, { repoRoot: REPO_ROOT, label });

    const runner: CopilotRunner = this.config.runner ?? spawnCopilot;
    const res = await runner({
      prompt,
      model: this.config.model,
      copilotHome: prov.copilotHome,
      cwd: prov.workspace,
      timeoutMs: this.config.timeoutMs ?? 300_000,
    });

    return {
      output: res.transcript,
      metadata: {
        workspace: prov.root,
        okhHome: prov.okhHome,
        containerPath: prov.containerPath,
        fixtureDir: prov.fixtureDir,
        originPath: prov.originPath,
        toolCalls: extractToolCalls(res.transcript),
        exitCode: res.code,
      },
    };
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd 'D:\work\open-knowledge-hub'; npx vitest run --config vitest.eval.config.ts eval-test/provider.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```powershell
cd 'D:\work\open-knowledge-hub'
git add eval/provider/copilotProvider.ts eval-test/provider.test.ts
git commit -m "refactor(eval): provider resolves vars.env via environments.ts

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 3: Migrate all 16 test.yaml to `{ prompt, env }`

**Files:**
- Modify: all 16 `eval/scenarios/<verb>/<case>/test.yaml`

- [ ] **Step 1: Rewrite each test.yaml's `vars` to `{ prompt, env }` and apply cleanups**

For every file, keep `description`, keep the `prompt: file://...` var, replace the remaining provisioning vars with a single `env`, per the mapping table at the top. Also drop the two always-empty `mustNotContain: []` fields and the redundant `provision: registered`. Concretely, set each file's `vars` block to exactly:

- `local-and-git` (ask-grounded, ask-declines-when-absent, ask-multi-container, context-assembly, context-includes-skills-tools, learn-rejects-trivial, reflect-insights, remember-records, remember-no-conclusions):

```yaml
  vars:
    prompt: file://scenarios/<verb>/<case>/prompt.md
    env: local-and-git
```

- `git` (learn-integrates):

```yaml
  vars:
    prompt: file://scenarios/learn/integrates/prompt.md
    env: git
```

- `empty` (onboard-add-existing-folder, onboard-add-github, onboard-create-local, onboard-explains, onboard-phrase, onboard-wake-phrase):

```yaml
  vars:
    prompt: file://scenarios/onboard/<case>/prompt.md
    env: empty
```

Also edit the two `transcript.ts` asserts to drop the empty `mustNotContain`:
- `eval/scenarios/ask/grounded/test.yaml`: change `config: { mustContain: ["token"], mustNotContain: [] }` → `config: { mustContain: ["token"] }`.
- `eval/scenarios/context/includes-skills-tools/test.yaml`: change `config: { mustContain: ["debugging", "csv2json"], mustNotContain: [] }` → `config: { mustContain: ["debugging", "csv2json"] }`.

Leave every `assert:` block otherwise unchanged (including `assert.config.name` container names — those are the agent-created/registered names the checks verify, independent of the env).

- [ ] **Step 2: Verify each test.yaml has only `prompt` + `env` vars and a valid env**

Run:

```powershell
cd 'D:\work\open-knowledge-hub'
Get-ChildItem eval\scenarios -Recurse -Filter test.yaml | ForEach-Object {
  $y = Get-Content $_.FullName -Raw
  $legacy = @('scenario:','backend:','container:','fixture:','provision:','container2:','fixture2:') | Where-Object { $y -match "(?m)^\s+$_" }
  $env = if ($y -match '(?m)^\s+env:\s*(\S+)') { $Matches[1] } else { 'MISSING' }
  "{0,-32} env={1,-14} legacy=[{2}]" -f "$($_.Directory.Parent.Name)-$($_.Directory.Name)", $env, ($legacy -join ',')
}
```

Expected: 16 rows; every `env` ∈ {empty, git, local-and-git} per the mapping; every `legacy=[]` (empty).

- [ ] **Step 3: Validate the promptfoo config**

Run: `cd 'D:\work\open-knowledge-hub'; npm run eval:validate`
Expected: ends with `Configuration is valid.`

- [ ] **Step 4: Commit**

```powershell
cd 'D:\work\open-knowledge-hub'
git add eval/scenarios
git commit -m "refactor(eval): collapse provisioning vars into a single env var

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 4: Update the manual harness (`okh-eval.ts`) + its test

**Files:**
- Modify: `eval/okh-eval.ts`
- Modify (test): `eval-test/okh-eval.test.ts`

- [ ] **Step 1: Update `eval-test/okh-eval.test.ts`** — the "loads a scenario" test now checks `env` (the `backend` var is gone):

Replace:

```ts
  it("loads a scenario's prompt (from prompt.md) + backend", async () => {
    const s = await loadScenario("ask-grounded");
    expect(s.vars.backend).toBe("local");
    expect(s.prompt).toMatch(/auth/i);
  });
```

with:

```ts
  it("loads a scenario's prompt (from prompt.md) + env", async () => {
    const s = await loadScenario("ask-grounded");
    expect(s.vars.env).toBe("local-and-git");
    expect(s.prompt).toMatch(/auth/i);
  });
```

Leave the other tests unchanged. The "setup registers both containers for the multi-container scenario" test already expects `["git-hub", "kb-hub"]`, which `local-and-git` produces.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd 'D:\work\open-knowledge-hub'; npx vitest run --config vitest.eval.config.ts eval-test/okh-eval.test.ts`
Expected: FAIL — `s.vars.backend`/`ScenarioTest` type + `setupScenario` still reference `provision.ts` / removed vars.

- [ ] **Step 3: Edit `eval/okh-eval.ts`**

3a. Replace the import line:

```ts
import { provision, type EvalBackend } from "./provision.js";
```

with:

```ts
import { provisionEnvironment, environments, isEnvName, type EnvName, type EvalBackend } from "./environments.js";
```

3b. Replace the `ScenarioTest` interface's `vars` shape. Change:

```ts
  vars: {
    scenario: string;
    backend: EvalBackend;
    container: string;
    fixture: string;
    provision?: "registered" | "empty" | "unregistered-local";
    /** Optional second local container for multi-container scenarios. */
    container2?: string;
    fixture2?: string;
  };
```

to:

```ts
  vars: {
    /** Prompt file ref (file://scenarios/<verb>/<case>/prompt.md). */
    prompt: string;
    /** Named environment (see eval/environments.ts). */
    env: EnvName;
  };
```

3c. Replace `SetupResult` + `setupScenario` (the whole block from `export interface SetupResult {` through the end of `setupScenario`) with:

```ts
export interface SetupResult {
  root: string;
  workspace: string;
  copilotHome: string;
  containerPath: string;
  scenario: string;
  backend: EvalBackend;
  command: string;
  checklist: string[];
}

export async function setupScenario(
  name: string,
  opts: { model?: string } = {},
): Promise<SetupResult> {
  const scenario = await loadScenario(name);
  const env = scenario.vars.env;
  if (!isEnvName(env)) throw new Error(`scenario "${name}": invalid env "${String(env)}"`);
  const prov = await provisionEnvironment(env, { repoRoot: REPO_ROOT, label: name });
  const backend: EvalBackend = environments[env].hubs[0].backend ?? "local";
  const model = opts.model ?? "claude-sonnet-4.5";
  const prompt = shellQuote(scenario.prompt.trim());
  const command =
    process.platform === "win32"
      ? `Set-Location -LiteralPath ${shellQuote(prov.workspace)}; $env:COPILOT_HOME=${shellQuote(prov.copilotHome)}; copilot -p ${prompt} --allow-all --model ${model}`
      : `COPILOT_HOME=${shellQuote(prov.copilotHome)} copilot -p ${prompt} --allow-all --model ${model}   # run from cwd: ${prov.workspace}`;
  const checklist = scenario.assert.map((a) =>
    `${a.type} ${a.value ? a.value.replace("file://assertions/", "") : ""} ${a.config ? JSON.stringify(a.config) : ""}`.trim(),
  );
  return { root: prov.root, workspace: prov.workspace, copilotHome: prov.copilotHome, containerPath: prov.containerPath, scenario: name, backend, command, checklist };
}
```

3d. In `runChecks`, replace the primary-container + fixture resolution. Change:

```ts
  const entry = findContainer(reg, scenario.vars.container);
  const fixtureRaw = scenario.vars.fixture;
  const fixtureDir = isAbsolute(fixtureRaw) ? fixtureRaw : resolve(EVAL_ROOT, fixtureRaw);
```

to:

```ts
  const primary = environments[scenario.vars.env].hubs[0];
  const entry = findContainer(reg, primary.container);
  const fixtureDir = isAbsolute(primary.fixture) ? primary.fixture : resolve(EVAL_ROOT, primary.fixture);
```

3e. In `main`, remove the `--backend` handling from the `setup` command. Change:

```ts
    const bi = rest.indexOf("--backend");
    const mi = rest.indexOf("--model");
    const res = await setupScenario(name, {
      backend: bi >= 0 ? (rest[bi + 1] as EvalBackend) : undefined,
      model: mi >= 0 ? rest[mi + 1] : undefined,
    });
```

to:

```ts
    const mi = rest.indexOf("--model");
    const res = await setupScenario(name, {
      model: mi >= 0 ? rest[mi + 1] : undefined,
    });
```

- [ ] **Step 4: Run the harness test to verify it passes**

Run: `cd 'D:\work\open-knowledge-hub'; npx vitest run --config vitest.eval.config.ts eval-test/okh-eval.test.ts`
Expected: PASS (all tests, including "lists all 16 scenarios" and "setup registers both containers ... ['git-hub','kb-hub']").

- [ ] **Step 5: Typecheck**

Run: `cd 'D:\work\open-knowledge-hub'; npm run typecheck:eval`
Expected: exit 0.

- [ ] **Step 6: Commit**

```powershell
cd 'D:\work\open-knowledge-hub'
git add eval/okh-eval.ts eval-test/okh-eval.test.ts
git commit -m "refactor(eval): manual harness resolves env via environments.ts

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 5: Update `config.test.ts` for the env var

**Files:**
- Modify (test): `eval-test/config.test.ts`

- [ ] **Step 1: Update the scenario test body** — in `eval-test/config.test.ts`, add an `environments` import at top:

```ts
import { environments } from "../eval/environments.js";
```

Then, inside the `for (const s of scenarios)` loop in the `describe("scenarios", ...)` test, replace:

```ts
      expect(test.description).toBe(s.id);
      expect(test.vars.prompt).toBe(s.relPrompt);
      expect((await readFile(join(s.dir, "prompt.md"), "utf8")).trim().length).toBeGreaterThan(0);
      expect(await exists(join(EVAL, String(test.vars.fixture)))).toBe(true);
```

with:

```ts
      expect(test.description).toBe(s.id);
      expect(test.vars.prompt).toBe(s.relPrompt);
      expect(Object.keys(test.vars).sort()).toEqual(["env", "prompt"]);
      expect(Object.keys(environments)).toContain(test.vars.env);
      expect((await readFile(join(s.dir, "prompt.md"), "utf8")).trim().length).toBeGreaterThan(0);
```

(The old fixture-path check is dropped — fixtures now live in the env, not the test.)

- [ ] **Step 2: Run the config test**

Run: `cd 'D:\work\open-knowledge-hub'; npx vitest run --config vitest.eval.config.ts eval-test/config.test.ts`
Expected: PASS (both tests) — every scenario has exactly `{ prompt, env }` vars and a valid env.

- [ ] **Step 3: Commit**

```powershell
cd 'D:\work\open-knowledge-hub'
git add eval-test/config.test.ts
git commit -m "test(eval): assert scenarios carry only prompt + a valid env var

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 6: Delete `provision.ts` and its test

**Files:**
- Delete: `eval/provision.ts`, `eval-test/provision.test.ts`

- [ ] **Step 1: Confirm nothing still imports provision.js**

Run:

```powershell
cd 'D:\work\open-knowledge-hub'
Get-ChildItem eval,eval-test -Recurse -Include *.ts | Select-String -Pattern 'from "\.{1,2}/.*provision\.js"|provision\.ts' | ForEach-Object { $_.Path }
```

Expected: **no output** (only the files about to be deleted might match; if any live file matches, fix its import to `environments.js` before deleting).

- [ ] **Step 2: Delete the files**

```powershell
cd 'D:\work\open-knowledge-hub'
git rm eval/provision.ts eval-test/provision.test.ts
```

- [ ] **Step 3: Typecheck + full eval test suite**

Run: `cd 'D:\work\open-knowledge-hub'; npm run typecheck:eval; npm run test:eval`
Expected: typecheck exit 0; `test:eval` all tests pass (the new `environments.test.ts` replaces the deleted `provision.test.ts`).

- [ ] **Step 4: Commit**

```powershell
cd 'D:\work\open-knowledge-hub'
git commit -m "chore(eval): remove provision.ts (replaced by environments.ts)

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 7: Update MANUAL-TESTING.md

**Files:**
- Modify: `eval/MANUAL-TESTING.md`

- [ ] **Step 1: Refresh the doc's var references**

Open `eval/MANUAL-TESTING.md`. Wherever it describes the scenario vars or provisioning backends, update to the env model. Specifically:

- Any mention of choosing a backend via `--backend` on `npm run eval:setup -- setup <scenario>` must be removed (the flag no longer exists; the backend is defined by the scenario's `env`).
- Add a one-line note near the setup section: "Each scenario declares a single `env` (see `eval/environments.ts`); provisioning is driven by that environment (`empty`, `git`, or `local-and-git`)."

Search first to find the exact lines to edit:

```powershell
cd 'D:\work\open-knowledge-hub'; Select-String -Path eval\MANUAL-TESTING.md -Pattern '--backend|backend|vars\.|provision' | ForEach-Object { "L$($_.LineNumber): $($_.Line.Trim())" }
```

Edit the matched lines to reflect the env model (remove `--backend` usage; describe `env`).

- [ ] **Step 2: Commit**

```powershell
cd 'D:\work\open-knowledge-hub'
git add eval/MANUAL-TESTING.md
git commit -m "docs(eval): document the env model in MANUAL-TESTING

Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
```

---

### Task 8: Offline verification

**Files:** none (verification only).

- [ ] **Step 1: Run the eval verification trio**

Run: `cd 'D:\work\open-knowledge-hub'; npm run eval:validate; npm run typecheck:eval; npm run test:eval`
Expected: `Configuration is valid.`; typecheck exit 0; `test:eval` all pass.

- [ ] **Step 2: Offline echo run over the new config (no premium requests, no auth)**

This confirms the tests glob resolves all 16 and the single prompt column stays dense.

```powershell
$src = 'D:\work\open-knowledge-hub\eval'; $dst = "$env:TEMP\echo-env"
Remove-Item -Recurse -Force $dst -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force "$dst\scenarios" | Out-Null
Get-ChildItem "$src\scenarios" -Directory | ForEach-Object {
  $verb = $_.Name
  Get-ChildItem $_.FullName -Directory | ForEach-Object {
    $leaf = "$dst\scenarios\$verb\$($_.Name)"
    New-Item -ItemType Directory -Force $leaf | Out-Null
    Copy-Item "$($_.FullName)\prompt.md" "$leaf\prompt.md"
    $lines = Get-Content "$($_.FullName)\test.yaml"
    $idx = ($lines | Select-String -Pattern '^  assert:').LineNumber
    if ($idx) { $lines = $lines[0..($idx-2)] }
    Set-Content "$leaf\test.yaml" $lines
  }
}
$cfgLines = Get-Content "$src\promptfooconfig.yaml"
$promptsStart = ($cfgLines | Select-String -Pattern '^prompts:').LineNumber - 1
$rest = $cfgLines[$promptsStart..($cfgLines.Count-1)] -join "`n"
Set-Content "$dst\promptfooconfig.yaml" ("description: echo-env`nproviders:`n  - id: echo`n" + $rest)
cd 'D:\work\open-knowledge-hub'
node ./node_modules/promptfoo/dist/src/entrypoint.js eval -c "$dst\promptfooconfig.yaml" -o "$dst\out.json" --no-cache 2>&1 | Select-Object -Last 3
$j = Get-Content "$dst\out.json" -Raw | ConvertFrom-Json
"results=$($j.results.results.Count) (expect 16)"
"distinct env vars: " + (($j.results.results | ForEach-Object { $_.testCase.vars.env } | Sort-Object -Unique) -join ', ')
Remove-Item -Recurse -Force $dst -ErrorAction SilentlyContinue
```

Expected: `results=16`; `distinct env vars: empty, git, local-and-git`.

---

### Task 9: Full live eval + viewer verification (larger-change completion criteria)

**Files:** none (produces a fresh eval in the promptfoo DB).

- [ ] **Step 1: Clear old eval history and rebuild**

```powershell
cd 'D:\work\open-knowledge-hub'
"y" | node ./node_modules/promptfoo/dist/src/entrypoint.js delete eval all
npm run build
```

Expected: `All evaluations have been deleted.`; build exit 0.

- [ ] **Step 2: Run the full live eval**

Run (long-running; needs authenticated Copilot CLI): `cd 'D:\work\open-knowledge-hub'; npm run eval`
Expected: `Results: ✓ 16 passed, 0 failed, 0 errors (100%)`.

If any scenario fails due to the shared env (e.g., an ask scenario reads git-hub, or an onboard scenario reacts to the stray notes folder), **fix the scenario's prompt or the shared env** — do NOT add a new environment (consolidation is the priority per the spec).

- [ ] **Step 3: Confirm the viewer grid is clean**

```powershell
cd 'D:\work\open-knowledge-hub'
$env:BROWSER="none"; Start-Process -NoNewWindow node -ArgumentList './node_modules/promptfoo/dist/src/entrypoint.js','view','-y','-p','15500'
Start-Sleep 6
$evalId = (Invoke-RestMethod "http://localhost:15500/api/results").data[0].evalId
$j = (Invoke-WebRequest "http://localhost:15500/api/eval/$evalId/table?filterMode=all&limit=100" -UseBasicParsing).Content | ConvertFrom-Json
$body = if ($j.table) { $j.table.body } else { $j.body }
$nullCells = 0; foreach ($r in $body) { foreach ($o in $r.outputs) { if ($null -eq $o) { $nullCells++ } } }
"rows=$($body.Count) (expect 16); null cells=$nullCells (expect 0)"
```

Expected: `rows=16 (expect 16); null cells=0 (expect 0)`.

- [ ] **Step 4: Final status**

Confirm `git status` is clean for `eval/` and `eval-test/` (all implementation committed in Tasks 1–7).

---

## Self-review notes

- **Spec coverage:** environments.ts defines+provisions (T1); provider (T2); test.yaml env migration + cleanups (T3); harness (T4); config test (T5); delete provision.ts (T6); docs (T7); offline + live verification incl. viewer null-cell check (T8–T9). All spec sections mapped.
- **Type consistency:** `provisionEnvironment(env, { repoRoot, label?, runner? })`, `Provisioned { root, okhHome, copilotHome, workspace, containerPath, fixtureDir, originPath? }`, `EnvName`, `isEnvName`, and `environments[env].hubs[0]` are used identically across environments.ts, the provider, and okh-eval.ts. `EvalBackend` is now exported from environments.ts (was provision.ts).
- **No placeholders:** every code/command step is concrete; the 16-file env mapping is enumerated in the mapping table + Task 3.
