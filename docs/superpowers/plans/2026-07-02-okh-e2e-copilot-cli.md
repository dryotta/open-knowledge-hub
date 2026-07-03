# OKH E2E (Copilot CLI) Harness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an `eval/` harness that runs the real OKH MCP server inside GitHub Copilot CLI against real fixture containers, using promptfoo as the outer shell (custom Copilot-CLI provider + deterministic `javascript` assertions + `llm-rubric` judge), plus a manual-mode CLI — supporting regression and prompt-optimization workflows.

**Architecture:** A shared `provision()` builds an isolated `COPILOT_HOME` + `OKH_HOME` with a copied fixture container (and a throwaway bare git origin for `git-auto`). A promptfoo custom provider calls `provision()` then spawns `copilot -p`, returning the transcript + a `metadata` object (workspace paths, tool calls). Deterministic assertions read `metadata` and reuse OKH's own parsers; an `llm-rubric` judge grades quality. The same `provision()` powers a manual `okh-eval setup` CLI. All harness code lives under `eval/`, runs via `tsx`, imports from `src/`, and is excluded from the published package.

**Tech Stack:** TypeScript (NodeNext ESM, strict), `tsx`, `vitest` (separate eval config), `zod`/`yaml` (already deps), `promptfoo` (new devDependency), GitHub Copilot CLI (`copilot`), `git`.

**Reference spec:** `docs/superpowers/specs/2026-07-02-okh-e2e-copilot-cli-design.md`

**Conventions (match the repo):**
- ESM relative imports use `.js` extensions (e.g. `../src/registry/registry.js`).
- Expected failures throw `OkhError`; reuse `src/` modules rather than reimplementing (registry, manifest, frontmatter, Git).
- Eval unit tests spawn NO real `copilot` — the Copilot runner is injected/faked. They MAY use real `git` against temp dirs (repo pattern), reusing `test/helpers.ts` (`testRun`, `GIT_ENV`).
- Run eval unit tests: `npm run test:eval`. Typecheck eval: `npm run typecheck:eval`. Main suite (`npm test`) stays unchanged.

**Prerequisites for a LIVE run (not for unit tests):** `npm run build` (mcp-config points at `dist/index.js`); `GH_TOKEN`/`COPILOT_GITHUB_TOKEN` in env; `copilot` installed; `promptfoo` installed; a judge-model API key (e.g. `OPENAI_API_KEY`).

---

## Target File Structure

```
eval/
  README.md                       # runbook: manual + automated usage, prereqs, verify-points
  promptfooconfig.yaml            # providers (copilot × models), defaultTest (grader), tests glob
  tsconfig.eval.json              # rootDir eval; typecheck the harness
  provision.ts                    # SHARED: isolated COPILOT_HOME + OKH_HOME + fixture copy + bare origin + mcp-config.json
  copilot.ts                      # spawn wrapper (injectable) + extractToolCalls()
  provider/
    copilotProvider.ts            # promptfoo custom provider: provision -> copilot -p -> {output, metadata}
  assertions/
    tools-called.ts               # metadata.toolCalls ⊇ expected
    transcript.ts                 # mustContain / mustNotContain regex
    okf-valid.ts                  # knowledge module concept docs parse as OKF (reuse src parser)
    memory-append.ts              # memory module gained exactly one dated entry vs baseline
    git-committed.ts              # git-auto origin received a commit beyond the seed
  okh-eval.ts                     # manual CLI: list | setup <scenario> [--backend] | check <ws> --scenario | clean <ws>
  fixtures/
    kb-hub/                       # local backend: knowledge+skills+tools+memory (seeded)
      .okh/okh.yaml
      kb/{index.md,auth.md}
      skills/debugging/SKILL.md
      tools/csv2json/README.md
      mem/2026-01-01.md
    git-hub/                      # git-auto backend: knowledge+memory (seeded)
      .okh/okh.yaml
      kb/{index.md,auth.md}
      mem/2026-01-01.md
  scenarios/
    ask-grounded/test.yaml
    ask-declines-when-absent/test.yaml
    context-assembly/test.yaml
    learn-integrates/test.yaml            # git-auto (git-hub)
    learn-rejects-trivial/test.yaml
    remember-records/test.yaml
    remember-no-conclusions/test.yaml
    reflect-insights/test.yaml
  reports/                        # gitignored
eval-test/                        # eval unit tests (kept out of the main test/ suite)
  provision.test.ts
  copilot.test.ts
  provider.test.ts
  assertions.test.ts
  config.test.ts
  okh-eval.test.ts
vitest.eval.config.ts             # include eval-test/**/*.test.ts
tsconfig.eval.json                # (listed above under eval/) — actually repo root; see Task 1
```

Root files touched: `package.json` (devDep + scripts), `.gitignore` (`eval/reports/`), `vitest.eval.config.ts` (new), `tsconfig.eval.json` (new).

> **Note on imports from `src/`:** the provider/assertions import OKH parsers from `../src/...js`. Unit tests run under vitest (transpiles TS fine). For the LIVE promptfoo run, promptfoo loads TS providers via its Node/tsx loader; if that fails to resolve TS `src` imports, the fallback is to import from built `dist/…js` (a documented verify-point in Task 8).

---

## Task 1: Scaffolding (deps, configs, scripts)

**Files:**
- Modify: `package.json`, `.gitignore`
- Create: `tsconfig.eval.json`, `vitest.eval.config.ts`, `eval/README.md` (placeholder), `eval-test/smoke.test.ts`

- [ ] **Step 1: Add the promptfoo dev dependency**

```bash
npm install -D promptfoo
```
Expected: `promptfoo` appears under `devDependencies`.

- [ ] **Step 2: Create `tsconfig.eval.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": true,
    "rootDir": ".",
    "types": ["node"]
  },
  "include": ["eval/**/*.ts", "eval-test/**/*.ts", "src/**/*.ts"]
}
```

- [ ] **Step 3: Create `vitest.eval.config.ts`**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["eval-test/**/*.test.ts"],
    environment: "node",
    testTimeout: 60000,
  },
});
```

- [ ] **Step 4: Add scripts to `package.json`**

Add these entries to the `"scripts"` block (leave existing scripts untouched):
```json
    "typecheck:eval": "tsc -p tsconfig.eval.json",
    "test:eval": "vitest run --config vitest.eval.config.ts",
    "eval": "promptfoo eval -c eval/promptfooconfig.yaml --no-cache",
    "eval:view": "promptfoo view",
    "eval:setup": "tsx eval/okh-eval.ts"
```

- [ ] **Step 5: Ignore generated reports**

Append to `.gitignore`:
```
eval/reports/
```

- [ ] **Step 6: Create placeholders so the eval suite runs green**

`eval/README.md`:
```markdown
# OKH E2E harness (Copilot CLI)

See `docs/superpowers/specs/2026-07-02-okh-e2e-copilot-cli-design.md`. Runbook filled in during implementation (Task 8).
```

`eval-test/smoke.test.ts`:
```ts
import { describe, it, expect } from "vitest";

describe("eval harness scaffolding", () => {
  it("runs the eval test config", () => {
    expect(true).toBe(true);
  });
});
```

- [ ] **Step 7: Verify + commit**

```bash
npm run typecheck:eval
npm run test:eval
```
Expected: typecheck passes; 1 test passes.

```bash
git add -A
git commit -m "chore(eval): scaffold e2e harness (promptfoo dep, eval tsconfig/vitest, scripts)"
```

---

## Task 2: `provision.ts` — isolated workspace builder

**Files:**
- Create: `eval/provision.ts`
- Test: `eval-test/provision.test.ts`

- [ ] **Step 1: Write the failing test `eval-test/provision.test.ts`**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { provision } from "../eval/provision.js";
import { makeTempDir, testRun } from "../test/helpers.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

/** Build a minimal fixture container dir on disk and return its path. */
async function makeFixture(): Promise<string> {
  const dir = await makeTempDir("okh-fix-"); cleanups.push(dir);
  await mkdir(join(dir, ".okh"), { recursive: true });
  await writeFile(join(dir, ".okh", "okh.yaml"), "name: hub\nsync: auto\nmodules:\n  - path: kb\n    type: knowledge\n", "utf8");
  await mkdir(join(dir, "kb"), { recursive: true });
  await writeFile(join(dir, "kb", "index.md"), "# Knowledge\n", "utf8");
  return dir;
}

describe("provision", () => {
  it("materializes a local container + isolated homes + mcp-config", async () => {
    const fixtureDir = await makeFixture();
    const prov = await provision({ scenario: "s", backend: "local", container: "hub", fixtureDir, repoRoot: "C:/repo", runner: testRun });
    cleanups.push(prov.root);

    // registry registers the container as local, pointing at the copied fixture
    const reg = JSON.parse(await readFile(join(prov.okhHome, "registry.json"), "utf8"));
    expect(reg.containers[0].backend).toBe("local");
    expect(reg.containers[0].localPath).toBe(prov.containerPath);
    expect(await readFile(join(prov.containerPath, ".okh", "okh.yaml"), "utf8")).toContain("name: hub");

    // mcp-config points OKH at the isolated OKH_HOME and the built server
    const mcp = JSON.parse(await readFile(join(prov.copilotHome, "mcp-config.json"), "utf8"));
    const server = mcp.mcpServers["open-knowledge-hub"];
    expect(server.env.OKH_HOME).toBe(prov.okhHome);
    expect(server.args.join(" ")).toContain("dist");
    expect(prov.originPath).toBeUndefined();
  });

  it("materializes a git-auto container with a seeded bare origin", async () => {
    const fixtureDir = await makeFixture();
    const prov = await provision({ scenario: "s", backend: "git-auto", container: "hub", fixtureDir, repoRoot: "C:/repo", runner: testRun });
    cleanups.push(prov.root);

    expect(prov.originPath).toBeTruthy();
    const reg = JSON.parse(await readFile(join(prov.okhHome, "registry.json"), "utf8"));
    expect(reg.containers[0].backend).toBe("git");
    expect(reg.containers[0].origin).toBe(prov.originPath);

    // a fresh clone of the origin has the seeded content
    const verify = await makeTempDir("okh-verify-"); cleanups.push(verify);
    await testRun("git", ["clone", prov.originPath!, join(verify, "c")]);
    expect(await readFile(join(verify, "c", "kb", "index.md"), "utf8")).toContain("# Knowledge");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run --config vitest.eval.config.ts eval-test/provision.test.ts
```
Expected: FAIL (`../eval/provision.js` not found).

- [ ] **Step 3: Implement `eval/provision.ts`**

```ts
import { mkdir, mkdtemp, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/exec.js";
import { Git } from "../src/git/git.js";
import { emptyRegistry, type ContainerEntry } from "../src/registry/schema.js";
import { saveRegistry, withContainerAdded } from "../src/registry/registry.js";
import type { OkhPaths } from "../src/config.js";

export type EvalBackend = "local" | "git-auto";

export interface ProvisionInput {
  scenario: string;
  backend: EvalBackend;
  container: string;
  /** Absolute path to the fixture container directory to copy. */
  fixtureDir: string;
  /** Absolute path to the OKH repo root (for dist/index.js in mcp-config). */
  repoRoot: string;
  /** Injectable process runner (tests pass a git-identity-bound runner). */
  runner?: typeof run;
}

export interface Provisioned {
  /** Temp root holding everything for this run. */
  root: string;
  okhHome: string;
  copilotHome: string;
  workspace: string;
  containerPath: string;
  originPath?: string;
}

/**
 * Build a fully isolated workspace for one eval run: an OKH_HOME with a
 * registered container (copied from the fixture), a COPILOT_HOME with an
 * mcp-config that launches the built OKH server against that OKH_HOME, and an
 * empty working directory. For git-auto, a throwaway bare origin is seeded and
 * cloned so `sync` has somewhere to push.
 */
export async function provision(input: ProvisionInput): Promise<Provisioned> {
  const runner = input.runner ?? run;
  const git = new Git(runner);

  const root = await mkdtemp(join(tmpdir(), `okh-eval-${input.scenario}-`));
  const okhHome = join(root, "okh-home");
  const copilotHome = join(root, "copilot-home");
  const workspace = join(root, "workspace");
  const containersDir = join(okhHome, "containers");
  await mkdir(containersDir, { recursive: true });
  await mkdir(copilotHome, { recursive: true });
  await mkdir(workspace, { recursive: true });

  const paths: OkhPaths = { home: okhHome, containersDir, registryFile: join(okhHome, "registry.json") };
  let entry: ContainerEntry;
  let originPath: string | undefined;

  if (input.backend === "git-auto") {
    originPath = join(root, "origin.git");
    await runner("git", ["init", "--bare", "-b", "main", originPath]);
    const seed = join(root, "seed");
    await runner("git", ["clone", originPath, seed]);
    await cp(input.fixtureDir, seed, { recursive: true });
    await runner("git", ["add", "-A"], { cwd: seed });
    await runner("git", ["commit", "-m", "seed"], { cwd: seed });
    await runner("git", ["push", "origin", "main"], { cwd: seed });
    const clone = join(containersDir, input.container);
    await git.clone(originPath, clone);
    entry = { name: input.container, backend: "git", origin: originPath, localPath: clone, addedAt: new Date().toISOString() };
  } else {
    const dir = join(containersDir, input.container);
    await cp(input.fixtureDir, dir, { recursive: true });
    entry = { name: input.container, backend: "local", localPath: dir, addedAt: new Date().toISOString() };
  }

  await saveRegistry(paths, withContainerAdded(emptyRegistry(), entry));

  const mcp = {
    mcpServers: {
      "open-knowledge-hub": {
        command: "node",
        args: [join(input.repoRoot, "dist", "index.js")],
        env: { OKH_HOME: okhHome },
      },
    },
  };
  await writeFile(join(copilotHome, "mcp-config.json"), `${JSON.stringify(mcp, null, 2)}\n`, "utf8");

  return { root, okhHome, copilotHome, workspace, containerPath: entry.localPath, originPath };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run --config vitest.eval.config.ts eval-test/provision.test.ts
npm run typecheck:eval
```
Expected: PASS + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(eval): shared provision() for isolated Copilot/OKH workspaces"
```

---

## Task 3: `copilot.ts` — spawn wrapper + tool-call extraction

**Files:**
- Create: `eval/copilot.ts`
- Test: `eval-test/copilot.test.ts`

- [ ] **Step 1: Write the failing test `eval-test/copilot.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { extractToolCalls } from "../eval/copilot.js";

describe("extractToolCalls", () => {
  it("detects a server-qualified tool call", () => {
    expect(extractToolCalls("Calling open-knowledge-hub__ask with {q}")).toEqual(["ask"]);
  });
  it("detects a dotted qualified call and a parenthesized call", () => {
    expect(extractToolCalls("invoked open-knowledge-hub.sync() now")).toEqual(["sync"]);
    expect(extractToolCalls("ran learn( container )")).toEqual(["learn"]);
  });
  it("returns a sorted unique set and ignores prose", () => {
    expect(extractToolCalls("open-knowledge-hub__remember then open-knowledge-hub__ask; will add a note"))
      .toEqual(["ask", "remember"]);
  });
  it("returns empty when no tools are referenced", () => {
    expect(extractToolCalls("just some text about knowledge")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run --config vitest.eval.config.ts eval-test/copilot.test.ts
```
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `eval/copilot.ts`**

```ts
import { spawn } from "node:child_process";

export interface CopilotRunOptions {
  prompt: string;
  model?: string;
  copilotHome: string;
  cwd: string;
  timeoutMs?: number;
  /** Extra env merged over process.env (e.g. tokens). */
  extraEnv?: NodeJS.ProcessEnv;
}

export interface CopilotResult {
  transcript: string;
  code: number | null;
}

/** Injectable so tests never spawn the real `copilot`. */
export type CopilotRunner = (opts: CopilotRunOptions) => Promise<CopilotResult>;

/** Default runner: spawns `copilot -p ... --allow-all [--model M]`, captures stdout+stderr. */
export const spawnCopilot: CopilotRunner = (opts) =>
  new Promise((resolve) => {
    const args = ["-p", opts.prompt, "--allow-all"];
    if (opts.model) args.push("--model", opts.model);
    const child = spawn("copilot", args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.extraEnv, COPILOT_HOME: opts.copilotHome },
      shell: false,
      windowsHide: true,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (out += d.toString()));
    const timer = opts.timeoutMs ? setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs) : undefined;
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ transcript: out, code });
    });
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      resolve({ transcript: `${out}\n[spawn error] ${(err as Error).message}`, code: null });
    });
  });

const OKH_TOOLS = ["inspect", "add", "sync", "ask", "context", "learn", "remember", "reflect"] as const;

/**
 * Best-effort extraction of which OKH tools were invoked, from the transcript.
 * Matches a server-qualified reference (`open-knowledge-hub<sep>TOOL`) or a
 * parenthesized call (`TOOL(`). The exact Copilot CLI tool-call rendering is a
 * verify-point (Task 8); this parser is tolerant and unit-tested.
 */
export function extractToolCalls(transcript: string): string[] {
  const found = new Set<string>();
  for (const t of OKH_TOOLS) {
    const qualified = new RegExp(`open-knowledge-hub[^a-z0-9]{1,4}${t}\\b`, "i");
    const called = new RegExp(`\\b${t}\\s*\\(`, "i");
    if (qualified.test(transcript) || called.test(transcript)) found.add(t);
  }
  return [...found].sort();
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run --config vitest.eval.config.ts eval-test/copilot.test.ts
```
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(eval): copilot spawn wrapper + tool-call extraction"
```

---

## Task 4: `copilotProvider.ts` — promptfoo custom provider

**Files:**
- Create: `eval/provider/copilotProvider.ts`
- Test: `eval-test/provider.test.ts`

- [ ] **Step 1: Write the failing test `eval-test/provider.test.ts`**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import CopilotProvider from "../eval/provider/copilotProvider.js";
import { makeTempDir } from "../test/helpers.js";
import type { CopilotRunner } from "../eval/copilot.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function makeFixture(): Promise<string> {
  const dir = await makeTempDir("okh-fix-"); cleanups.push(dir);
  await mkdir(join(dir, ".okh"), { recursive: true });
  await writeFile(join(dir, ".okh", "okh.yaml"), "name: hub\nsync: auto\nmodules:\n  - path: kb\n    type: knowledge\n", "utf8");
  await mkdir(join(dir, "kb"), { recursive: true });
  await writeFile(join(dir, "kb", "index.md"), "# Knowledge\n", "utf8");
  return dir;
}

describe("CopilotProvider", () => {
  it("provisions, runs the (faked) copilot, and returns transcript + metadata", async () => {
    const fixtureDir = await makeFixture();
    const fake: CopilotRunner = async (opts) => {
      // prove the provider wired the isolated home + prompt through
      expect(opts.copilotHome).toContain("copilot-home");
      expect(opts.prompt).toBe("answer: how does auth work?");
      return { transcript: "Calling open-knowledge-hub__ask ... done", code: 0 };
    };
    const provider = new CopilotProvider({ config: { model: "test-model", runner: fake } });
    expect(provider.id()).toBeTruthy();

    const res = await provider.callApi("answer: how does auth work?", {
      vars: { scenario: "ask-grounded", backend: "local", container: "hub", fixture: fixtureDir },
    });
    cleanups.push(res.metadata.workspace);

    expect(res.output).toContain("done");
    expect(res.metadata.toolCalls).toContain("ask");
    expect((await stat(join(res.metadata.containerPath, ".okh", "okh.yaml"))).isFile()).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run --config vitest.eval.config.ts eval-test/provider.test.ts
```
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `eval/provider/copilotProvider.ts`**

```ts
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, resolve } from "node:path";
import { provision, type EvalBackend } from "../provision.js";
import { spawnCopilot, extractToolCalls, type CopilotRunner } from "../copilot.js";

const EVAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(EVAL_ROOT, "..");

interface ProviderOptions {
  id?: string;
  config?: { model?: string; timeoutMs?: number; runner?: CopilotRunner };
}

interface CallContext {
  vars?: Record<string, unknown>;
}

/** promptfoo custom provider: provision an isolated workspace, run `copilot -p`, return transcript + metadata. */
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
    const fixtureRaw = String(vars.fixture ?? "");
    const fixtureDir = isAbsolute(fixtureRaw) ? fixtureRaw : resolve(EVAL_ROOT, fixtureRaw);
    const backend: EvalBackend = vars.backend === "git-auto" ? "git-auto" : "local";

    const prov = await provision({
      scenario: String(vars.scenario ?? "scenario"),
      backend,
      container: String(vars.container ?? "hub"),
      fixtureDir,
      repoRoot: REPO_ROOT,
    });

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
        originPath: prov.originPath,
        toolCalls: extractToolCalls(res.transcript),
        exitCode: res.code,
      },
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
npx vitest run --config vitest.eval.config.ts eval-test/provider.test.ts
npm run typecheck:eval
```
Expected: PASS + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(eval): promptfoo custom provider wrapping copilot -p"
```

---

## Task 5: Deterministic assertions

**Files:**
- Create: `eval/assertions/tools-called.ts`, `eval/assertions/transcript.ts`, `eval/assertions/okf-valid.ts`, `eval/assertions/memory-append.ts`, `eval/assertions/git-committed.ts`
- Test: `eval-test/assertions.test.ts`

Each assertion is a promptfoo `javascript` assertion: `default (output, context) => boolean | GradingResult`, reading `context.providerResponse.metadata` and per-assertion `context.config`.

- [ ] **Step 1: Write the failing test `eval-test/assertions.test.ts`**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir, makeOrigin, pushToOrigin } from "../test/helpers.js";
import toolsCalled from "../eval/assertions/tools-called.js";
import transcript from "../eval/assertions/transcript.js";
import okfValid from "../eval/assertions/okf-valid.js";
import memoryAppend from "../eval/assertions/memory-append.js";
import gitCommitted from "../eval/assertions/git-committed.js";

const cleanups: string[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const ctx = (metadata: Record<string, unknown>, config: Record<string, unknown> = {}) =>
  ({ providerResponse: { metadata }, config });

describe("tools-called", () => {
  it("passes when expected tools are present, fails when missing", () => {
    expect(toolsCalled("", ctx({ toolCalls: ["ask", "sync"] }, { expect: ["ask"] })).pass).toBe(true);
    expect(toolsCalled("", ctx({ toolCalls: ["ask"] }, { expect: ["learn"] })).pass).toBe(false);
  });
});

describe("transcript", () => {
  it("checks mustContain / mustNotContain", () => {
    expect(transcript("see kb/auth.md", ctx({}, { mustContain: ["kb/auth.md"] })).pass).toBe(true);
    expect(transcript("boom error", ctx({}, { mustNotContain: ["error"] })).pass).toBe(false);
  });
});

describe("okf-valid", () => {
  it("passes for valid OKF concepts, fails when a concept lacks a type", async () => {
    const c = await makeTempDir("okf-"); cleanups.push(c);
    await mkdir(join(c, "kb"), { recursive: true });
    await writeFile(join(c, "kb", "index.md"), "# Knowledge\n", "utf8");
    await writeFile(join(c, "kb", "auth.md"), "---\ntype: Concept\ntitle: Auth\n---\n# Auth\n# Citations\n[1] src\n", "utf8");
    expect((await okfValid("", ctx({ containerPath: c }, { module: "kb", requireCitations: true }))).pass).toBe(true);

    await writeFile(join(c, "kb", "bad.md"), "no frontmatter here\n", "utf8");
    expect((await okfValid("", ctx({ containerPath: c }, { module: "kb" }))).pass).toBe(false);
  });
});

describe("memory-append", () => {
  it("passes when memory file count grew beyond baseline", async () => {
    const c = await makeTempDir("mem-"); cleanups.push(c);
    await mkdir(join(c, "mem"), { recursive: true });
    await writeFile(join(c, "mem", "2026-01-01.md"), "old\n", "utf8");
    await writeFile(join(c, "mem", "2026-07-02.md"), "new\n", "utf8");
    expect((await memoryAppend("", ctx({ containerPath: c }, { module: "mem", baselineFileCount: 1 }))).pass).toBe(true);
    expect((await memoryAppend("", ctx({ containerPath: c }, { module: "mem", baselineFileCount: 2 }))).pass).toBe(false);
  });
});

describe("git-committed", () => {
  it("passes when the origin has commits beyond the seed", async () => {
    const origin = await makeOrigin({ "kb/index.md": "# k\n" }); // 1 commit
    expect((await gitCommitted("", ctx({ originPath: origin }, { minCommits: 2 }))).pass).toBe(false);
    await pushToOrigin(origin, "kb/auth.md", "x"); // 2nd commit
    expect((await gitCommitted("", ctx({ originPath: origin }, { minCommits: 2 }))).pass).toBe(true);
  });
  it("fails cleanly for a non-git container", async () => {
    expect((await gitCommitted("", ctx({}, {}))).pass).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run --config vitest.eval.config.ts eval-test/assertions.test.ts
```
Expected: FAIL (modules not found).

- [ ] **Step 3: Implement `eval/assertions/tools-called.ts`**

```ts
interface Ctx {
  config?: { expect?: string[] };
  providerResponse?: { metadata?: { toolCalls?: string[] } };
}

/** Pass iff every expected OKH tool appears in the run's detected tool calls. */
export default function toolsCalled(_output: string, context: Ctx) {
  const expected = context.config?.expect ?? [];
  const called = context.providerResponse?.metadata?.toolCalls ?? [];
  const missing = expected.filter((t) => !called.includes(t));
  const pass = missing.length === 0;
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass ? `tools called: ${called.join(", ") || "(none)"}` : `missing tool calls: ${missing.join(", ")}`,
  };
}
```

- [ ] **Step 4: Implement `eval/assertions/transcript.ts`**

```ts
interface Ctx {
  config?: { mustContain?: string[]; mustNotContain?: string[] };
}

/** Pass iff all mustContain patterns match and no mustNotContain pattern matches (case-insensitive). */
export default function transcript(output: string, context: Ctx) {
  const must = context.config?.mustContain ?? [];
  const mustNot = context.config?.mustNotContain ?? [];
  const missing = must.filter((s) => !new RegExp(s, "i").test(output));
  const present = mustNot.filter((s) => new RegExp(s, "i").test(output));
  const pass = missing.length === 0 && present.length === 0;
  return {
    pass,
    score: pass ? 1 : 0,
    reason: pass ? "transcript matched" : `missing: [${missing.join(", ")}] unexpected: [${present.join(", ")}]`,
  };
}
```

- [ ] **Step 5: Implement `eval/assertions/okf-valid.ts`**

```ts
import { join, basename } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { parseFrontmatter, stringField } from "../../src/util/frontmatter.js";

interface Ctx {
  config?: { module?: string; requireCitations?: boolean };
  providerResponse?: { metadata?: { containerPath?: string } };
}
const RESERVED = new Set(["index.md", "log.md"]);

async function walkMd(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function rec(d: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        if (e.name !== ".git" && e.name !== ".okh") await rec(p);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        out.push(p);
      }
    }
  }
  await rec(dir);
  return out;
}

/** Pass iff every concept doc in the knowledge module parses with a non-empty OKF `type`. */
export default async function okfValid(_output: string, context: Ctx) {
  const containerPath = context.providerResponse?.metadata?.containerPath;
  const module = context.config?.module ?? "kb";
  if (!containerPath) return { pass: false, score: 0, reason: "no containerPath in metadata" };
  const root = join(containerPath, module);
  const concepts = (await walkMd(root)).filter((f) => !RESERVED.has(basename(f)));
  if (concepts.length === 0) return { pass: false, score: 0, reason: `no concept docs in ${module}` };
  const problems: string[] = [];
  let hasCitations = false;
  for (const f of concepts) {
    const text = await readFile(f, "utf8");
    const { data, body } = parseFrontmatter(text);
    if (!stringField(data, "type")) problems.push(`${basename(f)}: missing frontmatter type`);
    if (/^#\s*Citations/im.test(body)) hasCitations = true;
  }
  if (context.config?.requireCitations && !hasCitations) problems.push("no concept has a # Citations section");
  const pass = problems.length === 0;
  return { pass, score: pass ? 1 : 0, reason: pass ? `OKF valid (${concepts.length} concepts)` : problems.join("; ") };
}
```

- [ ] **Step 6: Implement `eval/assertions/memory-append.ts`**

```ts
import { join } from "node:path";
import { readdir } from "node:fs/promises";

interface Ctx {
  config?: { module?: string; baselineFileCount?: number };
  providerResponse?: { metadata?: { containerPath?: string } };
}

/**
 * Pass iff the memory module's markdown file count grew beyond the baseline —
 * i.e. `remember` created a new dated entry file. (The memory format is
 * provisional; scenarios seed a known baseline count.)
 */
export default async function memoryAppend(_output: string, context: Ctx) {
  const containerPath = context.providerResponse?.metadata?.containerPath;
  const module = context.config?.module ?? "mem";
  const baseline = context.config?.baselineFileCount ?? 0;
  if (!containerPath) return { pass: false, score: 0, reason: "no containerPath in metadata" };
  let files: string[] = [];
  try {
    files = (await readdir(join(containerPath, module))).filter((f) => f.endsWith(".md"));
  } catch {
    files = [];
  }
  const pass = files.length > baseline;
  return { pass, score: pass ? 1 : 0, reason: `memory .md files: ${files.length} (baseline ${baseline}, need > ${baseline})` };
}
```

- [ ] **Step 7: Implement `eval/assertions/git-committed.ts`**

```ts
import { run } from "../../src/exec.js";

interface Ctx {
  config?: { minCommits?: number };
  providerResponse?: { metadata?: { originPath?: string } };
}

/** Pass iff the git-auto container's bare origin received commits beyond the seed (i.e. sync pushed). */
export default async function gitCommitted(_output: string, context: Ctx) {
  const origin = context.providerResponse?.metadata?.originPath;
  if (!origin) return { pass: false, score: 0, reason: "no origin (not a git-auto container)" };
  const min = context.config?.minCommits ?? 2; // seed + at least one synced commit
  let count = 0;
  try {
    const { stdout } = await run("git", ["-C", origin, "log", "--oneline"]);
    count = stdout.trim().split(/\r?\n/).filter(Boolean).length;
  } catch (err) {
    return { pass: false, score: 0, reason: `git log failed: ${(err as Error).message}` };
  }
  const pass = count >= min;
  return { pass, score: pass ? 1 : 0, reason: `origin commits: ${count} (need >= ${min})` };
}
```

- [ ] **Step 8: Run tests + typecheck**

```bash
npx vitest run --config vitest.eval.config.ts eval-test/assertions.test.ts
npm run typecheck:eval
```
Expected: PASS + typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(eval): deterministic assertions (tools/transcript/okf/memory/git)"
```

---

## Task 6: Fixtures, scenarios & promptfoo config

**Files:**
- Create fixtures: `eval/fixtures/kb-hub/**`, `eval/fixtures/git-hub/**`
- Create scenarios: `eval/scenarios/<8>/test.yaml`
- Create: `eval/promptfooconfig.yaml`
- Test: `eval-test/config.test.ts`

- [ ] **Step 1: Create the `kb-hub` fixture (local backend)**

`eval/fixtures/kb-hub/.okh/okh.yaml`:
```yaml
name: kb-hub
sync: auto
modules:
  - path: kb
    type: knowledge
  - path: skills
    type: skills
  - path: tools
    type: tools
  - path: mem
    type: memory
```
`eval/fixtures/kb-hub/kb/index.md`:
```markdown
# Knowledge

* [Auth](auth.md) - how authentication works in this system
```
`eval/fixtures/kb-hub/kb/auth.md`:
```markdown
---
type: Concept
title: Auth
description: How authentication works in this system
---

# Auth

Authentication uses signed session tokens issued at login and verified on each
request. Tokens expire after 24 hours; refresh tokens rotate on use.

# Citations

[1] internal design note — auth flow
```
`eval/fixtures/kb-hub/skills/debugging/SKILL.md`:
```markdown
---
name: Debugging
description: Systematic root-cause analysis for failing tests
---

# Debugging

1. Reproduce. 2. Isolate. 3. Form a hypothesis. 4. Verify the fix.
```
`eval/fixtures/kb-hub/tools/csv2json/README.md`:
```markdown
# CSV to JSON

Convert a CSV file to JSON.

## Usage

`python run.py input.csv > output.json`
```
`eval/fixtures/kb-hub/mem/2026-01-01.md`:
```markdown
## 2026-01-01T09:00:00Z — auth spike

Observed that token refresh failed intermittently under clock skew.
```

- [ ] **Step 2: Create the `git-hub` fixture (git-auto backend)**

`eval/fixtures/git-hub/.okh/okh.yaml`:
```yaml
name: git-hub
sync: auto
modules:
  - path: kb
    type: knowledge
  - path: mem
    type: memory
```
`eval/fixtures/git-hub/kb/index.md`:
```markdown
# Knowledge

* [Auth](auth.md) - how authentication works in this system
```
`eval/fixtures/git-hub/kb/auth.md`:
```markdown
---
type: Concept
title: Auth
description: How authentication works in this system
---

# Auth

Authentication uses signed session tokens verified on each request.

# Citations

[1] internal design note — auth flow
```
`eval/fixtures/git-hub/mem/2026-01-01.md`:
```markdown
## 2026-01-01T09:00:00Z — note

Initial memory entry.
```

- [ ] **Step 3: Create the 8 scenario `test.yaml` files**

Each file is a YAML list containing one promptfoo test. `fixture` is relative to the `eval/` root (the provider resolves it there).

`eval/scenarios/ask-grounded/test.yaml`:
```yaml
- vars:
    scenario: ask-grounded
    backend: local
    container: kb-hub
    fixture: fixtures/kb-hub
    prompt: |
      Use the open-knowledge-hub MCP tools. In container "kb-hub", answer strictly
      from its knowledge module: How does auth work?
  assert:
    - type: javascript
      value: file://eval/assertions/tools-called.ts
      config: { expect: [ask] }
    - type: javascript
      value: file://eval/assertions/transcript.ts
      config: { mustContain: ["auth"], mustNotContain: [] }
    - type: llm-rubric
      value: |
        PASS iff the answer is grounded ONLY in the container's knowledge module
        (the Auth concept), reflects token-based auth, and invents nothing.
      threshold: 0.8
```

`eval/scenarios/ask-declines-when-absent/test.yaml`:
```yaml
- vars:
    scenario: ask-declines-when-absent
    backend: local
    container: kb-hub
    fixture: fixtures/kb-hub
    prompt: |
      Use the open-knowledge-hub MCP tools. In container "kb-hub", answer strictly
      from its knowledge module: What is the company's paid vacation policy?
  assert:
    - type: javascript
      value: file://eval/assertions/tools-called.ts
      config: { expect: [ask] }
    - type: llm-rubric
      value: |
        PASS iff the answer states the information is NOT in the knowledge base
        (declines / says not found) and does NOT fabricate a vacation policy.
      threshold: 0.8
```

`eval/scenarios/context-assembly/test.yaml`:
```yaml
- vars:
    scenario: context-assembly
    backend: local
    container: kb-hub
    fixture: fixtures/kb-hub
    prompt: |
      Use the open-knowledge-hub MCP tools. Assemble the context needed to
      implement a secure login feature in container "kb-hub".
  assert:
    - type: javascript
      value: file://eval/assertions/tools-called.ts
      config: { expect: [context] }
    - type: llm-rubric
      value: |
        PASS iff the response assembles a compact, relevant working set that
        includes the Auth knowledge concept and cites module paths, omits clearly
        irrelevant items, and notes any gaps. FAIL if it dumps everything or misses auth.
      threshold: 0.8
```

`eval/scenarios/learn-integrates/test.yaml`:
```yaml
- vars:
    scenario: learn-integrates
    backend: git-auto
    container: git-hub
    fixture: fixtures/git-hub
    prompt: |
      Use the open-knowledge-hub MCP tools. Learn the following into container
      "git-hub" and persist it: "Session tokens are signed with RS256 and the
      public keys are rotated weekly." Then sync.
  assert:
    - type: javascript
      value: file://eval/assertions/tools-called.ts
      config: { expect: [learn, sync] }
    - type: javascript
      value: file://eval/assertions/okf-valid.ts
      config: { module: kb, requireCitations: false }
    - type: javascript
      value: file://eval/assertions/git-committed.ts
      config: { minCommits: 2 }
    - type: llm-rubric
      value: |
        PASS iff a valid OKF knowledge concept capturing the RS256/weekly-rotation
        fact was added and persisted via sync.
      threshold: 0.8
```

`eval/scenarios/learn-rejects-trivial/test.yaml`:
```yaml
- vars:
    scenario: learn-rejects-trivial
    backend: local
    container: kb-hub
    fixture: fixtures/kb-hub
    prompt: |
      Use the open-knowledge-hub MCP tools. Learn this into container "kb-hub":
      "The sky is blue on a clear day."
  assert:
    - type: javascript
      value: file://eval/assertions/tools-called.ts
      config: { expect: [learn] }
    - type: llm-rubric
      value: |
        PASS iff the okf-learn gate REJECTS this as not serving any goal of the
        knowledge base and does NOT write it as a concept. FAIL if it stores it.
      threshold: 0.8
```

`eval/scenarios/remember-records/test.yaml`:
```yaml
- vars:
    scenario: remember-records
    backend: local
    container: kb-hub
    fixture: fixtures/kb-hub
    prompt: |
      Use the open-knowledge-hub MCP tools. Remember this observation in container
      "kb-hub": "The login endpoint returned 500s for ~3 minutes at 14:05 UTC during deploy."
  assert:
    - type: javascript
      value: file://eval/assertions/tools-called.ts
      config: { expect: [remember] }
    - type: javascript
      value: file://eval/assertions/memory-append.ts
      config: { module: mem, baselineFileCount: 1 }
    - type: llm-rubric
      value: |
        PASS iff a factual, timestamped memory entry capturing the 500s incident
        was recorded.
      threshold: 0.8
```

`eval/scenarios/remember-no-conclusions/test.yaml`:
```yaml
- vars:
    scenario: remember-no-conclusions
    backend: local
    container: kb-hub
    fixture: fixtures/kb-hub
    prompt: |
      Use the open-knowledge-hub MCP tools. Remember this in container "kb-hub":
      "Test suite run #42 finished in 13s with 88 passing."
  assert:
    - type: javascript
      value: file://eval/assertions/tools-called.ts
      config: { expect: [remember] }
    - type: llm-rubric
      value: |
        PASS iff the entry records the raw fact only and does NOT synthesize
        conclusions, lessons, or recommendations (that is reflect's job).
      threshold: 0.8
```

`eval/scenarios/reflect-insights/test.yaml`:
```yaml
- vars:
    scenario: reflect-insights
    backend: local
    container: kb-hub
    fixture: fixtures/kb-hub
    prompt: |
      Use the open-knowledge-hub MCP tools. Reflect on the memory module of
      container "kb-hub" and produce lessons and proposed updates.
  assert:
    - type: javascript
      value: file://eval/assertions/tools-called.ts
      config: { expect: [reflect] }
    - type: llm-rubric
      value: |
        PASS iff the reflection cites the existing memory entry (the 2026-01-01
        auth spike), draws a high-signal lesson, and proposes concrete updates.
      threshold: 0.8
```

- [ ] **Step 4: Create `eval/promptfooconfig.yaml`**

```yaml
description: OKH E2E in GitHub Copilot CLI
providers:
  - id: file://eval/provider/copilotProvider.ts
    label: copilot-default
    config:
      # Verify the exact model id via `copilot help` / `/model`.
      model: claude-sonnet-4.5
      timeoutMs: 300000
defaultTest:
  options:
    # Independent judge model for llm-rubric (requires OPENAI_API_KEY, or swap provider).
    provider: openai:gpt-5
prompts:
  - "{{prompt}}"
tests: file://eval/scenarios/*/test.yaml
```

- [ ] **Step 5: Write the config-validation test `eval-test/config.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { readFile, stat, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const EVAL = join(REPO, "eval");
const exists = async (p: string) => !!(await stat(p).catch(() => null));

describe("promptfooconfig.yaml", () => {
  it("references an existing provider and a tests glob", async () => {
    const cfg = parseYaml(await readFile(join(EVAL, "promptfooconfig.yaml"), "utf8"));
    const providerId: string = cfg.providers[0].id;
    expect(providerId.startsWith("file://")).toBe(true);
    expect(await exists(join(REPO, providerId.replace("file://", "")))).toBe(true);
    expect(cfg.defaultTest.options.provider).toBeTruthy();
    expect(String(cfg.tests)).toContain("scenarios");
  });
});

describe("scenarios", () => {
  it("all 8 scenarios parse, reference existing fixtures + assertion files, and have a rubric", async () => {
    const dirs = (await readdir(join(EVAL, "scenarios"), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    expect(dirs).toEqual([
      "ask-declines-when-absent",
      "ask-grounded",
      "context-assembly",
      "learn-integrates",
      "learn-rejects-trivial",
      "reflect-insights",
      "remember-no-conclusions",
      "remember-records",
    ]);

    for (const d of dirs) {
      const list = parseYaml(await readFile(join(EVAL, "scenarios", d, "test.yaml"), "utf8"));
      expect(Array.isArray(list)).toBe(true);
      const test = list[0];
      expect(typeof test.vars.prompt).toBe("string");
      expect(await exists(join(EVAL, String(test.vars.fixture)))).toBe(true);
      const rubrics = test.assert.filter((a: { type: string }) => a.type === "llm-rubric");
      expect(rubrics.length).toBeGreaterThanOrEqual(1);
      for (const a of test.assert) {
        if (a.type === "javascript") {
          expect(await exists(join(REPO, String(a.value).replace("file://", "")))).toBe(true);
        }
      }
    }
  });
});
```

- [ ] **Step 6: Run tests + typecheck**

```bash
npx vitest run --config vitest.eval.config.ts eval-test/config.test.ts
npm run typecheck:eval
```
Expected: PASS + typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(eval): fixtures, 8 scenarios, and promptfoo config"
```

---

## Task 7: `okh-eval.ts` — manual-mode CLI

**Files:**
- Create: `eval/okh-eval.ts`
- Test: `eval-test/okh-eval.test.ts`

- [ ] **Step 1: Write the failing test `eval-test/okh-eval.test.ts`**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { listScenarios, loadScenario, setupScenario, runChecks, clean } from "../eval/okh-eval.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => clean(r)));
});

describe("okh-eval manual CLI", () => {
  it("lists all 8 scenarios", async () => {
    expect((await listScenarios()).length).toBe(8);
  });

  it("loads a scenario's prompt + backend", async () => {
    const s = await loadScenario("ask-grounded");
    expect(s.vars.backend).toBe("local");
    expect(s.vars.prompt).toMatch(/auth/i);
  });

  it("setup provisions a workspace and prints a copilot command", async () => {
    const res = await setupScenario("ask-grounded", { model: "test-model" });
    roots.push(res.root);
    expect(res.command).toContain("copilot -p");
    expect(res.command).toContain("--allow-all");
    expect(res.checklist.length).toBeGreaterThan(0);
  });

  it("runChecks evaluates filesystem side-effects (memory append)", async () => {
    const res = await setupScenario("remember-records");
    roots.push(res.root);
    // simulate the agent adding a new dated memory entry
    await mkdir(join(res.containerPath, "mem"), { recursive: true });
    await writeFile(join(res.containerPath, "mem", "2026-07-02.md"), "## new\n", "utf8");
    const results = await runChecks(res.root, "remember-records");
    const mem = results.find((r) => r.name.endsWith("memory-append.ts"));
    expect(mem?.pass).toBe(true);
    // transcript/tools checks are skipped in manual mode (no transcript)
    expect(results.some((r) => r.name.endsWith("tools-called.ts"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

```bash
npx vitest run --config vitest.eval.config.ts eval-test/okh-eval.test.ts
```
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `eval/okh-eval.ts`**

```ts
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { readdir, readFile, rm } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { provision, type EvalBackend } from "./provision.js";

const EVAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = resolve(EVAL_ROOT, "..");

/** Manual-mode check assertions: only objective filesystem/git side-effects (need no transcript). */
const SIDE_EFFECT_ASSERTIONS = ["okf-valid.ts", "memory-append.ts", "git-committed.ts"];

export interface ScenarioTest {
  vars: { scenario: string; backend: EvalBackend; container: string; fixture: string; prompt: string };
  assert: Array<{ type: string; value?: string; config?: Record<string, unknown> }>;
}

export async function listScenarios(): Promise<string[]> {
  const dirs = await readdir(join(EVAL_ROOT, "scenarios"), { withFileTypes: true });
  return dirs.filter((e) => e.isDirectory()).map((e) => e.name).sort();
}

export async function loadScenario(name: string): Promise<ScenarioTest> {
  const raw = await readFile(join(EVAL_ROOT, "scenarios", name, "test.yaml"), "utf8");
  const list = parseYaml(raw);
  if (!Array.isArray(list) || list.length === 0) throw new Error(`scenario "${name}": expected a non-empty test list`);
  return list[0] as ScenarioTest;
}

export interface SetupResult {
  root: string;
  workspace: string;
  copilotHome: string;
  containerPath: string;
  command: string;
  checklist: string[];
}

export async function setupScenario(
  name: string,
  opts: { model?: string; backend?: EvalBackend } = {},
): Promise<SetupResult> {
  const scenario = await loadScenario(name);
  const backend = opts.backend ?? scenario.vars.backend;
  const fixtureRaw = scenario.vars.fixture;
  const fixtureDir = isAbsolute(fixtureRaw) ? fixtureRaw : resolve(EVAL_ROOT, fixtureRaw);
  const prov = await provision({ scenario: name, backend, container: scenario.vars.container, fixtureDir, repoRoot: REPO_ROOT });
  const model = opts.model ?? "claude-sonnet-4.5";
  const command =
    `COPILOT_HOME=${prov.copilotHome} copilot -p ${JSON.stringify(scenario.vars.prompt.trim())} --allow-all --model ${model}` +
    `   # run from cwd: ${prov.workspace}`;
  const checklist = scenario.assert.map((a) =>
    a.type === "llm-rubric"
      ? `rubric: ${String(a.value).trim().split("\n")[0]} …`
      : `${a.type} ${a.value ? a.value.replace("file://eval/assertions/", "") : ""} ${a.config ? JSON.stringify(a.config) : ""}`.trim(),
  );
  return { root: prov.root, workspace: prov.workspace, copilotHome: prov.copilotHome, containerPath: prov.containerPath, command, checklist };
}

export interface CheckResult {
  name: string;
  pass: boolean;
  reason: string;
}

/** Re-run objective side-effect assertions against a workspace you drove by hand. */
export async function runChecks(root: string, name: string): Promise<CheckResult[]> {
  const scenario = await loadScenario(name);
  const okhHome = join(root, "okh-home");
  const reg = JSON.parse(await readFile(join(okhHome, "registry.json"), "utf8"));
  const entry = reg.containers[0];
  const metadata = {
    workspace: root,
    okhHome,
    containerPath: entry.localPath,
    originPath: entry.backend === "git" ? entry.origin : undefined,
    toolCalls: [] as string[],
  };
  const results: CheckResult[] = [];
  for (const a of scenario.assert) {
    if (a.type !== "javascript" || !a.value) continue;
    const rel = a.value.replace("file://", "");
    if (!SIDE_EFFECT_ASSERTIONS.some((s) => rel.endsWith(s))) continue;
    const mod = await import(pathToFileURL(join(REPO_ROOT, rel)).href);
    const fn = mod.default as (output: string, ctx: unknown) => unknown;
    const out = fn("", { providerResponse: { metadata }, config: a.config ?? {} });
    const r = (out instanceof Promise ? await out : out) as { pass: boolean; reason?: string };
    results.push({ name: rel, pass: !!r.pass, reason: r.reason ?? "" });
  }
  return results;
}

/** Remove the temp run (accepts the temp root or the workspace path). */
export async function clean(workspaceOrRoot: string): Promise<void> {
  const root = workspaceOrRoot.replace(/[\\/]workspace$/, "");
  await rm(root, { recursive: true, force: true });
}

async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "list") {
    for (const s of await listScenarios()) console.log(s);
    return 0;
  }
  if (cmd === "setup") {
    const name = rest[0];
    if (!name) throw new Error("usage: okh-eval setup <scenario> [--backend local|git-auto] [--model M]");
    const bi = rest.indexOf("--backend");
    const mi = rest.indexOf("--model");
    const res = await setupScenario(name, {
      backend: bi >= 0 ? (rest[bi + 1] as EvalBackend) : undefined,
      model: mi >= 0 ? rest[mi + 1] : undefined,
    });
    console.log(`Root      : ${res.root}`);
    console.log(`Workspace : ${res.workspace}`);
    console.log(`\nRun:\n${res.command}`);
    console.log(`\nExpected-outcome checklist:`);
    for (const c of res.checklist) console.log(`  - ${c}`);
    console.log(`\nAfter running, verify side-effects:\n  npm run eval:setup -- check ${res.root} --scenario ${name}`);
    console.log(`Clean up:\n  npm run eval:setup -- clean ${res.root}`);
    return 0;
  }
  if (cmd === "check") {
    const root = rest[0];
    const si = rest.indexOf("--scenario");
    const name = si >= 0 ? rest[si + 1] : undefined;
    if (!root || !name) throw new Error("usage: okh-eval check <root> --scenario <name>");
    const results = await runChecks(root, name);
    let ok = true;
    for (const r of results) {
      console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name} — ${r.reason}`);
      if (!r.pass) ok = false;
    }
    return ok ? 0 : 1;
  }
  if (cmd === "clean") {
    if (!rest[0]) throw new Error("usage: okh-eval clean <root|workspace>");
    await clean(rest[0]);
    console.log("cleaned");
    return 0;
  }
  throw new Error(`unknown command: ${cmd ?? "(none)"} — use list | setup | check | clean`);
}

const invokedDirectly = !!process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
```

- [ ] **Step 4: Run tests + typecheck**

```bash
npx vitest run --config vitest.eval.config.ts eval-test/okh-eval.test.ts
npm run typecheck:eval
```
Expected: PASS + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(eval): manual-mode CLI (list/setup/check/clean)"
```

---

## Task 8: Runbook + full verification

**Files:**
- Rewrite: `eval/README.md`
- Test: none (documentation + whole-suite verification)

- [ ] **Step 1: Rewrite `eval/README.md`**

````markdown
# OKH E2E Harness (GitHub Copilot CLI)

Exercises the real OKH MCP server **inside GitHub Copilot CLI** against real
fixture containers. Design: `docs/superpowers/specs/2026-07-02-okh-e2e-copilot-cli-design.md`.

Two modes, one set of scenarios (`eval/scenarios/*/test.yaml`):
- **Automated** — promptfoo drives a custom Copilot-CLI provider, applies
  deterministic `javascript` assertions + an `llm-rubric` judge, and reports.
- **Manual** — provision a ready workspace and run Copilot CLI by hand.

## Prerequisites

- `npm run build` — the harness launches the **built** server (`dist/index.js`).
- `copilot` installed and a token in the environment: `GH_TOKEN` or
  `COPILOT_GITHUB_TOKEN` (required — the harness uses an isolated `COPILOT_HOME`,
  so the interactive login is not visible).
- For the judge: an independent grader model key (e.g. `OPENAI_API_KEY`), or edit
  `defaultTest.options.provider` in `promptfooconfig.yaml`.
- `promptfoo` (installed as a devDependency).

## Automated eval

```bash
npm run build
$env:GH_TOKEN = "..."         # PowerShell; or export on bash
npm run eval                  # promptfoo eval -c eval/promptfooconfig.yaml --no-cache
npm run eval:view             # open the report + side-by-side comparison UI
```

**Model matrix (goal 1):** add more `providers` entries in `promptfooconfig.yaml`,
each pointing at `file://eval/provider/copilotProvider.ts` with a different
`config.model`. Default is a single pinned model.

**Optimization (goal 2):** run the suite against two OKH builds (git branches),
then compare in `npm run eval:view`.

## Manual mode

```bash
npm run build
npm run eval:setup -- list
npm run eval:setup -- setup ask-grounded            # prints workspace + copilot command + checklist
# ...run the printed `copilot -p ...` command, eyeball the answer against the checklist...
npm run eval:setup -- check <root> --scenario ask-grounded   # re-run objective file/git checks
npm run eval:setup -- clean <root>
```

## Caveats

- Each run consumes premium requests (1 agent call + 1 judge call per test × models).
- Copilot CLI temperature isn't directly controllable — rely on rubric thresholds
  (and promptfoo `repeat`). **Do not** gate required CI on this suite.
- Response caching is disabled for the agent provider (`--no-cache`).

## Verify-points (confirm against your Copilot CLI version)

- `mcp-config.json` key is `mcpServers` (see `provision.ts`) — check `copilot help config`.
- The `--model` flag name and accepted model IDs — check `copilot help` / `/model`.
- The transcript/session-log rendering of MCP tool calls — `extractToolCalls`
  (in `copilot.ts`) is best-effort; adjust its patterns if your version differs.
- **promptfoo `file://` path resolution:** the config uses repo-root-relative
  paths (e.g. `file://eval/provider/copilotProvider.ts`, and `file://eval/assertions/…`
  inside scenario `test.yaml`), assuming promptfoo resolves them relative to the
  cwd when run as `promptfoo eval -c eval/promptfooconfig.yaml` from the repo root.
  If your promptfoo resolves `file://` relative to the **config file's directory**
  instead, drop the `eval/` prefix (e.g. `file://provider/…`, `file://scenarios/*/test.yaml`,
  and `file://../assertions/…` in scenarios). Confirm on the first live run.
- Whether promptfoo TS providers/assertions load `../src/*.ts` imports via its
  Node loader; if not, build and point imports at `dist/*.js` (see the plan's
  "Note on imports from `src/`").
````

- [ ] **Step 2: Confirm the harness is excluded from the published package**

```bash
npm pack --dry-run
```
Expected: the file list contains only `dist/**` and `resources/**` (plus package metadata) — **no** `eval/**` or `eval-test/**`. (`package.json` `files` already restricts this; no change needed.)

- [ ] **Step 3: Full verification — main + eval suites**

```bash
npm run typecheck
npm run typecheck:eval
npm test
npm run test:eval
```
Expected: all four pass. `npm test` count is unchanged from before this feature (the harness adds no tests to the main suite); `npm run test:eval` passes all eval-test files (smoke + provision + copilot + provider + assertions + config + okh-eval).

- [ ] **Step 4: (Manual, optional) live smoke — NOT part of CI**

With `npm run build` done and `GH_TOKEN` + judge key set, run one scenario live to
confirm end-to-end wiring against the real Copilot CLI:
```bash
npm run eval -- --filter-first-n 1
```
Confirm the provider launches `copilot`, the OKH tools are used, and a report is
produced. (Verify the `--filter-first-n` flag name against `promptfoo --help`; this
step is exploratory and consumes premium requests.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs(eval): runbook + verify-points; full-suite verification"
```

---

## Done

Spec coverage: promptfoo outer shell + custom Copilot-CLI provider (Tasks 3-4);
isolated fixtures/provisioning (Tasks 2, 6); deterministic hard-gate checks +
`llm-rubric` judge (Tasks 5, 6); manual + automated modes (Tasks 4, 7); the 8
happy-path + guardrail scenarios (Task 6); scaffolding, scripts, and package
exclusion (Tasks 1, 8). Live Copilot-CLI runs are a manual step (require the
user's token + premium requests) and are documented, not automated.
