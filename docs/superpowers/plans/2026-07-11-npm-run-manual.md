# One-Command Manual Testing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the recorded `eval:setup` workflow with `npm run manual`, which provisions an isolated environment, launches Copilot CLI, and cleans up automatically.

**Architecture:** A new `eval/manual.ts` owns argument parsing, scenario prompt loading, provisioning, Copilot launch, and cleanup. It reuses `eval/environments.ts`, defaults to `local-and-git`, supports an optional environment and model, and removes the obsolete run-state/manual-subcommand implementation.

**Tech Stack:** TypeScript, Node.js child processes and filesystem APIs, npm scripts, Vitest.

---

## File structure

- Create `eval/manual.ts`: one-shot manual-session entry point and testable helpers.
- Create `eval-test/manual.test.ts`: argument, prompt loading, invocation, lifecycle, and cleanup tests.
- Modify `package.json`: add `manual`; remove `eval:setup`.
- Modify `eval/README.md`: document the new workflow.
- Delete `eval/okh-eval.ts`: obsolete multi-command manual CLI.
- Delete `eval/run-state.ts`: obsolete persistent pointer for multi-step runs.
- Delete `eval-test/okh-eval.test.ts`: replaced by `manual.test.ts`.
- Delete `eval-test/run-state.test.ts`: run-state no longer exists.

### Task 1: Manual arguments, scenarios, and invocation

**Files:**
- Create: `eval/manual.ts`
- Create: `eval-test/manual.test.ts`

- [ ] **Step 1: Write failing tests for parsing, scenario loading, and invocation**

Create `eval-test/manual.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  buildCopilotInvocation,
  loadScenarios,
  parseManualArgs,
  scenariosForEnv,
} from "../eval/manual.js";

describe("manual testing helpers", () => {
  it("defaults to local-and-git", () => {
    expect(parseManualArgs([])).toEqual({ env: "local-and-git", model: undefined });
  });

  it("accepts an environment and model", () => {
    expect(parseManualArgs(["wiki", "--model", "claude-sonnet-4.5"])).toEqual({
      env: "wiki",
      model: "claude-sonnet-4.5",
    });
  });

  it.each([
    [["unknown"], /unknown environment/i],
    [["--model"], /requires a value/i],
    [["wiki", "git"], /unexpected argument/i],
    [["--wat"], /unknown option/i],
  ])("rejects invalid arguments: %j", (argv, message) => {
    expect(() => parseManualArgs(argv as string[])).toThrow(message);
  });

  it("loads all scenario prompts and groups them by environment", async () => {
    const all = await loadScenarios();
    expect(all).toHaveLength(28);
    expect(await scenariosForEnv("local-and-git")).toHaveLength(12);
    expect(await scenariosForEnv("git")).toHaveLength(1);
    expect(await scenariosForEnv("empty")).toHaveLength(8);
    expect(await scenariosForEnv("custom")).toHaveLength(2);
    expect(await scenariosForEnv("wiki")).toHaveLength(3);
    expect(await scenariosForEnv("health")).toHaveLength(2);
    for (const scenario of all) {
      expect(scenario.prompt).not.toHaveLength(0);
      expect(scenario.checklist).not.toHaveLength(0);
    }
  });

  it("builds an isolated Copilot invocation", () => {
    expect(buildCopilotInvocation(
      { workspace: "C:\\temp\\workspace", copilotHome: "C:\\temp\\copilot-home" },
      "test-model",
    )).toEqual({
      command: "copilot",
      args: ["--allow-all", "--model", "test-model"],
      cwd: "C:\\temp\\workspace",
      env: { COPILOT_HOME: "C:\\temp\\copilot-home" },
    });
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```powershell
npx vitest run --config vitest.eval.config.ts eval-test\manual.test.ts
```

Expected: FAIL because `eval/manual.ts` does not exist.

- [ ] **Step 3: Implement parsing, scenario loading, and invocation**

Create `eval/manual.ts` with these imports and helpers:

```ts
import { spawn, type ChildProcess } from "node:child_process";
import { rm, readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  environments,
  isEnvName,
  provisionEnvironment,
  type EnvName,
  type Provisioned,
} from "./environments.js";

const EVAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = resolve(EVAL_ROOT, "..");
export const DEFAULT_MANUAL_ENV: EnvName = "local-and-git";

export interface ManualOptions {
  env: EnvName;
  model?: string;
}

export interface ManualScenario {
  file: string;
  description: string;
  env: EnvName;
  prompt: string;
  checklist: string[];
}

export interface CopilotInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

export function parseManualArgs(argv: string[]): ManualOptions {
  let env: EnvName = DEFAULT_MANUAL_ENV;
  let envSeen = false;
  let model: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--model") {
      const value = argv[i + 1];
      if (!value || value.startsWith("--")) {
        throw new Error("--model requires a value");
      }
      model = value;
      i += 1;
      continue;
    }
    if (arg.startsWith("--")) {
      throw new Error(`unknown option "${arg}"`);
    }
    if (envSeen) {
      throw new Error(`unexpected argument "${arg}"`);
    }
    if (!isEnvName(arg)) {
      throw new Error(
        `unknown environment "${arg}" - use one of: ${Object.keys(environments).join(", ")}`,
      );
    }
    env = arg;
    envSeen = true;
  }

  return { env, model };
}

async function scenarioConfigFiles(): Promise<string[]> {
  const root = join(EVAL_ROOT, "scenarios");
  const files: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name !== "shared") await walk(join(dir, entry.name), relative);
      } else if (entry.name.endsWith(".yaml")) {
        files.push(relative);
      }
    }
  };
  await walk(root, "");
  return files.sort();
}

export async function loadScenarios(): Promise<ManualScenario[]> {
  const root = join(EVAL_ROOT, "scenarios");
  const result: ManualScenario[] = [];
  for (const file of await scenarioConfigFiles()) {
    const document = parseYaml(await readFile(join(root, file), "utf8"));
    const scenarios = Array.isArray(document) ? document : [document];
    for (const scenario of scenarios) {
      const vars = scenario?.config?.[0]?.vars ?? {};
      const test = scenario?.tests?.[0];
      if (
        typeof test?.description !== "string"
        || typeof vars.prompt !== "string"
        || !isEnvName(vars.env)
      ) {
        throw new Error(
          `scenarios/${file}: expected tests[0].description + config[0].vars.prompt + config[0].vars.env`,
        );
      }
      result.push({
        file,
        description: test.description,
        env: vars.env,
        prompt: vars.prompt.trim(),
        checklist: (test.assert ?? []).map(
          (assertion: { type: string; value?: string; config?: Record<string, unknown> }) =>
            `${assertion.type} ${
              assertion.value ? assertion.value.replace("file://assertions/", "") : ""
            } ${assertion.config ? JSON.stringify(assertion.config) : ""}`.trim(),
        ),
      });
    }
  }
  return result;
}

export async function scenariosForEnv(env: EnvName): Promise<ManualScenario[]> {
  return (await loadScenarios()).filter((scenario) => scenario.env === env);
}

export function buildCopilotInvocation(
  environment: Pick<Provisioned, "workspace" | "copilotHome">,
  model?: string,
): CopilotInvocation {
  const args = ["--allow-all"];
  if (model) args.push("--model", model);
  return {
    command: "copilot",
    args,
    cwd: environment.workspace,
    env: { COPILOT_HOME: environment.copilotHome },
  };
}
```

Keep the currently unused lifecycle imports; Task 2 uses them.

- [ ] **Step 4: Run the focused test to verify it passes**

Run:

```powershell
npx vitest run --config vitest.eval.config.ts eval-test\manual.test.ts
```

Expected: PASS with 8 tests.

- [ ] **Step 5: Commit the helper layer**

```powershell
git add eval\manual.ts eval-test\manual.test.ts
git commit -m "feat(eval): add manual session helpers" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: 292c4179-636f-44b9-abc8-4d8579d35468"
```

### Task 2: One-shot session lifecycle and cleanup

**Files:**
- Modify: `eval/manual.ts`
- Modify: `eval-test/manual.test.ts`

- [ ] **Step 1: Add failing lifecycle tests**

Append to `eval-test/manual.test.ts` and extend its imports with `runManual`:

```ts
import type { Provisioned } from "../eval/environments.js";

const provisioned: Provisioned = {
  root: "C:\\temp\\manual-root",
  okhHome: "C:\\temp\\manual-root\\okh-home",
  copilotHome: "C:\\temp\\manual-root\\copilot-home",
  workspace: "C:\\temp\\manual-root\\workspace",
  containerPath: "C:\\temp\\manual-root\\okh-home\\containers\\kb-hub",
  fixtureDir: "C:\\repo\\eval\\fixtures\\kb-hub",
};

describe("runManual", () => {
  it("provisions the default env, launches Copilot, and cleans up", async () => {
    const events: string[] = [];
    const exitCode = await runManual([], {
      provision: async (env) => {
        events.push(`provision:${env}`);
        return provisioned;
      },
      scenarios: async () => [{
        file: "ask/answerable.yaml",
        description: "answers from stored knowledge",
        env: "local-and-git",
        prompt: "What is the deployment process?",
        checklist: ["tools-called ask"],
      }],
      launch: async (invocation) => {
        events.push(`launch:${invocation.cwd}`);
        return 7;
      },
      cleanup: async (root) => {
        events.push(`cleanup:${root}`);
      },
      output: (line) => events.push(`output:${line}`),
    });

    expect(exitCode).toBe(7);
    expect(events).toContain("provision:local-and-git");
    expect(events).toContain(`launch:${provisioned.workspace}`);
    expect(events.at(-1)).toBe(`output:Cleaned ${provisioned.root}`);
    expect(events).toContain(`cleanup:${provisioned.root}`);
  });

  it("cleans up when Copilot launch fails", async () => {
    const cleaned: string[] = [];
    await expect(runManual(["wiki"], {
      provision: async () => provisioned,
      scenarios: async () => [],
      launch: async () => {
        throw new Error("copilot unavailable");
      },
      cleanup: async (root) => {
        cleaned.push(root);
      },
      output: () => undefined,
    })).rejects.toThrow("copilot unavailable");
    expect(cleaned).toEqual([provisioned.root]);
  });

  it("rejects invalid arguments before provisioning", async () => {
    let provisionedCount = 0;
    await expect(runManual(["bad-env"], {
      provision: async () => {
        provisionedCount += 1;
        return provisioned;
      },
      scenarios: async () => [],
      launch: async () => 0,
      cleanup: async () => undefined,
      output: () => undefined,
    })).rejects.toThrow(/unknown environment/i);
    expect(provisionedCount).toBe(0);
  });
});
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```powershell
npx vitest run --config vitest.eval.config.ts eval-test\manual.test.ts
```

Expected: FAIL because `runManual` is not exported.

- [ ] **Step 3: Implement provisioning, output, launch, signal forwarding, and cleanup**

Append to `eval/manual.ts`:

```ts
export interface ManualDependencies {
  provision: (env: EnvName) => Promise<Provisioned>;
  scenarios: (env: EnvName) => Promise<ManualScenario[]>;
  launch: (invocation: CopilotInvocation) => Promise<number>;
  cleanup: (root: string) => Promise<void>;
  output: (line: string) => void;
}

function defaultProvision(env: EnvName): Promise<Provisioned> {
  return provisionEnvironment(env, { repoRoot: REPO_ROOT, label: `manual-${env}` });
}

function defaultCleanup(root: string): Promise<void> {
  return rm(root, { recursive: true, force: true });
}

function printSession(
  environment: Provisioned,
  env: EnvName,
  scenarios: ManualScenario[],
  output: (line: string) => void,
): void {
  output(`Environment  : ${env}`);
  output(`OKH_HOME     : ${environment.okhHome}`);
  output(`COPILOT_HOME : ${environment.copilotHome}`);
  output(`Workspace    : ${environment.workspace}`);
  output("");
  output("Paste a prompt into the Copilot session and verify its checklist:");
  scenarios.forEach((scenario, index) => {
    output("");
    output(`[${index + 1}] ${scenario.description}`);
    output(scenario.prompt.split("\n").map((line) => `    ${line}`).join("\n"));
    output("  expected:");
    scenario.checklist.forEach((item) => output(`    - ${item}`));
  });
  output("");
}

export function launchCopilot(
  invocation: CopilotInvocation,
  spawnChild: typeof spawn = spawn,
): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child: ChildProcess = spawnChild(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: { ...process.env, ...invocation.env },
      stdio: "inherit",
      shell: false,
    });
    let settled = false;
    const forward = (signal: NodeJS.Signals): void => {
      if (!child.killed) child.kill(signal);
    };
    const onSigint = (): void => forward("SIGINT");
    const onSigterm = (): void => forward("SIGTERM");
    const removeSignalHandlers = (): void => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      removeSignalHandlers();
      rejectPromise(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      removeSignalHandlers();
      resolvePromise(code ?? (signal ? 1 : 0));
    });
  });
}

const defaultDependencies: ManualDependencies = {
  provision: defaultProvision,
  scenarios: scenariosForEnv,
  launch: launchCopilot,
  cleanup: defaultCleanup,
  output: console.log,
};

export async function runManual(
  argv: string[],
  dependencies: ManualDependencies = defaultDependencies,
): Promise<number> {
  const options = parseManualArgs(argv);
  const environment = await dependencies.provision(options.env);
  try {
    const scenarios = await dependencies.scenarios(options.env);
    printSession(environment, options.env, scenarios, dependencies.output);
    return await dependencies.launch(buildCopilotInvocation(environment, options.model));
  } finally {
    await dependencies.cleanup(environment.root);
    dependencies.output(`Cleaned ${environment.root}`);
  }
}

const invokedDirectly =
  !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  runManual(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
```

- [ ] **Step 4: Run the focused test to verify it passes**

Run:

```powershell
npx vitest run --config vitest.eval.config.ts eval-test\manual.test.ts
```

Expected: PASS with 11 tests.

- [ ] **Step 5: Type-check the eval code**

Run:

```powershell
npm run typecheck:eval
```

Expected: exit code 0.

- [ ] **Step 6: Commit the one-shot lifecycle**

```powershell
git add eval\manual.ts eval-test\manual.test.ts
git commit -m "feat(eval): run disposable manual sessions" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: 292c4179-636f-44b9-abc8-4d8579d35468"
```

### Task 3: Replace the legacy manual eval commands

**Files:**
- Modify: `package.json:17-37`
- Delete: `eval/okh-eval.ts`
- Delete: `eval/run-state.ts`
- Delete: `eval-test/okh-eval.test.ts`
- Delete: `eval-test/run-state.test.ts`

- [ ] **Step 1: Change the npm script**

In `package.json`, add `manual` beside the other interactive scripts and remove
`eval:setup`:

```json
"inspect:dev": "npm run build:app && npx @modelcontextprotocol/inspector npx tsx src/index.ts",
"manual": "tsx eval/manual.ts",
"test": "npm run build:app && vitest run",
```

Keep these eval scripts unchanged:

```json
"typecheck:eval": "tsc -p tsconfig.eval.json",
"test:eval": "vitest run --config vitest.eval.config.ts",
"eval": "node --import tsx eval/run-scenarios.ts eval",
"eval:validate": "node --import tsx eval/run-scenarios.ts validate",
"eval:view": "promptfoo view",
```

- [ ] **Step 2: Delete the obsolete implementation and tests**

Delete:

```text
eval/okh-eval.ts
eval/run-state.ts
eval-test/okh-eval.test.ts
eval-test/run-state.test.ts
```

- [ ] **Step 3: Verify no active code or current docs reference the old workflow**

Run:

```powershell
rg "eval:setup|okh-eval|run-state| setup | enter | clean " package.json eval eval-test README.md USAGE.md
```

Expected: only `eval/README.md` references remain; they are updated in Task 4.
Historical files under `docs/superpowers/` may still describe the old design.

- [ ] **Step 4: Run eval tests and typecheck**

Run:

```powershell
npm run typecheck:eval
npm run test:eval
```

Expected: both commands exit 0.

- [ ] **Step 5: Commit the command replacement**

```powershell
git add package.json eval\okh-eval.ts eval\run-state.ts eval-test\okh-eval.test.ts eval-test\run-state.test.ts
git commit -m "refactor(eval): replace manual eval subcommands" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: 292c4179-636f-44b9-abc8-4d8579d35468"
```

### Task 4: Document and validate the manual workflow

**Files:**
- Modify: `eval/README.md:45-58`
- Modify: `eval/README.md:306-330`

- [ ] **Step 1: Update the key-files table**

Replace the `okh-eval.ts` row with:

```markdown
| `manual.ts` | one-shot manual harness (`npm run manual`) with isolated homes and automatic cleanup |
```

- [ ] **Step 2: Replace the manual-running section**

Replace lines 306-330 with:

```markdown
## Running manually (with example prompts)

`npm run manual` creates an isolated temporary `OKH_HOME`, `COPILOT_HOME`, and
workspace; prints every prompt and checklist for the selected environment; then
opens an interactive Copilot CLI session. The default environment is
`local-and-git`, which provides both local and git-backed containers.

```powershell
npm run build
npm run manual
npm run manual -- wiki
npm run manual -- local-and-git --model <model>
```

Valid environments are `empty`, `git`, `local-and-git`, `custom`, `health`, and
`wiki`. Inside Copilot, `/mcp` confirms **open-knowledge-hub** is loaded. Paste a
printed prompt, observe the tool calls and result, and inspect the workspace as
needed.

The full temporary root is removed when Copilot exits, including failed or
interrupted sessions. There are no setup, enter, or cleanup follow-up commands.
Deterministic assertions remain part of `npm run eval`.
```

- [ ] **Step 3: Verify active references**

Run:

```powershell
rg "eval:setup|okh-eval|run-state|recorded runs|setup <env>|enter \[env\]|clean \[env\]" package.json eval eval-test README.md USAGE.md
```

Expected: no matches.

- [ ] **Step 4: Run non-live validation**

Run:

```powershell
npm run build
npm run typecheck
npm run typecheck:eval
npm run test:eval
npm run eval:validate
```

Expected: every command exits 0.

- [ ] **Step 5: Smoke-test the command without consuming a live session**

Run:

```powershell
npm run manual -- invalid-env
```

Expected: exit code 1, concise valid-environment guidance, and no temp
environment provisioned.

- [ ] **Step 6: Perform the final live manual smoke check**

After all implementation and non-live validation is complete, run:

```powershell
npm run manual
```

Expected:

```text
Environment  : local-and-git
OKH_HOME     : <temporary path>
COPILOT_HOME : <temporary path>
Workspace    : <temporary path>
```

Confirm `/mcp` lists `open-knowledge-hub`, exit Copilot, and confirm the printed
temporary root no longer exists.

- [ ] **Step 7: Commit documentation**

```powershell
git add eval\README.md
git commit -m "docs(eval): simplify manual testing workflow" -m "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>" -m "Copilot-Session: 292c4179-636f-44b9-abc8-4d8579d35468"
```
