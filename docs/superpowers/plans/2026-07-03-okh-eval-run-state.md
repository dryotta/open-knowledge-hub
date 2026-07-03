# Frictionless Manual Eval Runs (Run-State Pointer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let manual eval follow-up commands (`enter`, `check`, `clean`) resolve the provisioned temp directory automatically by scenario name or most-recent run, so the operator never copy-pastes the random `Root` path.

**Architecture:** `setup` still provisions a unique temp dir (via existing `provision.ts`) but now records the run in a small, disposable state file (`<os.tmpdir()>/okh-eval-state.json`). A new `eval/run-state.ts` module owns that file. `eval/okh-eval.ts` gains an `enter` command that launches an interactive Copilot session in the isolated env, and `check`/`clean` resolve their path from state (name or most-recent), while keeping the old explicit-path forms for backward compatibility.

**Tech Stack:** TypeScript (NodeNext ESM — relative imports use `.js`), Node `fs/promises`, `node:child_process`, Vitest (eval suite runs via `vitest.eval.config.ts`).

Design spec: `docs/superpowers/specs/2026-07-03-okh-eval-run-state-design.md`

---

## File Structure

- **Create** `eval/run-state.ts` — owns the disposable run-state file: `RunRecord` type, `recordRun`, `readRuns`, `resolveRun`, `forgetRun`. All functions take an injectable `stateFile` path (default = tmpdir location) so tests use an isolated file. Atomic writes (unique temp + rename), matching `src/registry/registry.ts`.
- **Create** `eval-test/run-state.test.ts` — unit tests for the module.
- **Modify** `eval/okh-eval.ts` — add `scenario`/`backend` to `SetupResult`; add pure `buildEnterInvocation` + thin `spawnInteractive`; wire `main`: `setup` records the run; new `enter`; `check`/`clean` resolve from state with backward-compatible explicit-path forms.
- **Modify** `eval-test/okh-eval.test.ts` — add tests for `buildEnterInvocation` and the new `SetupResult` fields (existing tests stay unchanged).
- **Modify** `eval/MANUAL-TESTING.md` — rewrite steps 2–5 to the no-copy-paste flow.
- **Modify** `eval/README.md` — adjust the manual-mode pointer wording.

Verification commands used throughout:
- Eval suite: `npm run typecheck:eval` and `npm run test:eval`
- Single eval file: `npx vitest run --config vitest.eval.config.ts eval-test/run-state.test.ts`
- Core suite (must stay green): `npm run typecheck` and `npm test`

---

## Task 1: `run-state.ts` module + tests

**Files:**
- Create: `eval/run-state.ts`
- Test: `eval-test/run-state.test.ts`

- [ ] **Step 1: Write the failing test**

Create `eval-test/run-state.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { makeTempDir } from "../test/helpers.js";
import { recordRun, readRuns, resolveRun, forgetRun, type RunRecord } from "../eval/run-state.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeRun(scenario: string): Promise<RunRecord> {
  const root = await makeTempDir(`okh-run-${scenario}-`);
  dirs.push(root);
  const workspace = join(root, "workspace");
  const copilotHome = join(root, "copilot-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(copilotHome, { recursive: true });
  return { scenario, root, workspace, copilotHome, backend: "local", createdAt: new Date().toISOString() };
}

async function stateFile(): Promise<string> {
  const dir = await makeTempDir("okh-state-");
  dirs.push(dir);
  return join(dir, "state.json");
}

describe("run-state", () => {
  it("resolves a recorded run by scenario name", async () => {
    const state = await stateFile();
    const rec = await makeRun("ask-grounded");
    await recordRun(rec, state);
    expect((await resolveRun("ask-grounded", state)).root).toBe(rec.root);
  });

  it("resolves the most-recent run when no scenario is given", async () => {
    const state = await stateFile();
    const first = await makeRun("ask-grounded");
    const second = await makeRun("remember-records");
    await recordRun(first, state);
    await recordRun(second, state);
    expect((await resolveRun(undefined, state)).scenario).toBe("remember-records");
  });

  it("re-recording the same scenario replaces its entry and makes it most-recent", async () => {
    const state = await stateFile();
    const older = await makeRun("ask-grounded");
    const other = await makeRun("remember-records");
    const newer = await makeRun("ask-grounded");
    await recordRun(older, state);
    await recordRun(other, state);
    await recordRun(newer, state);
    const runs = await readRuns(state);
    expect(runs.filter((r) => r.scenario === "ask-grounded").length).toBe(1);
    expect((await resolveRun(undefined, state)).root).toBe(newer.root);
  });

  it("throws a clear error when the resolved run directory is gone", async () => {
    const state = await stateFile();
    const rec = await makeRun("ask-grounded");
    await recordRun(rec, state);
    await rm(rec.root, { recursive: true, force: true });
    await expect(resolveRun("ask-grounded", state)).rejects.toThrow(/re-run/i);
  });

  it("throws a clear error when no run matches", async () => {
    const state = await stateFile();
    await expect(resolveRun(undefined, state)).rejects.toThrow(/setup/i);
  });

  it("forgetRun removes only the matching entry", async () => {
    const state = await stateFile();
    const a = await makeRun("ask-grounded");
    const b = await makeRun("remember-records");
    await recordRun(a, state);
    await recordRun(b, state);
    await forgetRun(a.root, state);
    expect((await readRuns(state)).map((r) => r.scenario)).toEqual(["remember-records"]);
  });

  it("readRuns returns [] when the state file is absent", async () => {
    const state = await stateFile();
    expect(await readRuns(state)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.eval.config.ts eval-test/run-state.test.ts`
Expected: FAIL — cannot resolve import `../eval/run-state.js` (module does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `eval/run-state.ts`:

```ts
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes } from "node:crypto";
import type { EvalBackend } from "./provision.js";

export interface RunRecord {
  scenario: string;
  root: string;
  workspace: string;
  copilotHome: string;
  backend: EvalBackend;
  createdAt: string;
}

/** Disposable pointer file: which temp runs `setup` has provisioned. */
export const DEFAULT_STATE_FILE = join(tmpdir(), "okh-eval-state.json");

interface StateShape {
  runs: RunRecord[];
}

/** Read recorded runs; missing/malformed file => empty list. */
export async function readRuns(stateFile: string = DEFAULT_STATE_FILE): Promise<RunRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(stateFile, "utf8")) as Partial<StateShape>;
    return Array.isArray(parsed.runs) ? parsed.runs : [];
  } catch {
    return [];
  }
}

async function writeRuns(runs: RunRecord[], stateFile: string): Promise<void> {
  await mkdir(dirname(stateFile), { recursive: true });
  const tmp = `${stateFile}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  await writeFile(tmp, `${JSON.stringify({ runs }, null, 2)}\n`, "utf8");
  await rename(tmp, stateFile);
}

/** Upsert by scenario; the re-recorded entry becomes the most-recent (last). */
export async function recordRun(rec: RunRecord, stateFile: string = DEFAULT_STATE_FILE): Promise<void> {
  const runs = (await readRuns(stateFile)).filter((r) => r.scenario !== rec.scenario);
  runs.push(rec);
  await writeRuns(runs, stateFile);
}

/** Resolve a run by scenario name, or the most-recent when omitted. Throws with guidance. */
export async function resolveRun(
  scenario: string | undefined,
  stateFile: string = DEFAULT_STATE_FILE,
): Promise<RunRecord> {
  const runs = await readRuns(stateFile);
  if (runs.length === 0) {
    throw new Error("No provisioned run found — run 'npm run eval:setup -- setup <scenario>' first.");
  }
  const rec = scenario
    ? [...runs].reverse().find((r) => r.scenario === scenario)
    : runs[runs.length - 1];
  if (!rec) {
    throw new Error(`No provisioned run for scenario "${scenario}" — run 'npm run eval:setup -- setup ${scenario}' first.`);
  }
  if (!existsSync(rec.root)) {
    throw new Error(`Run directory is gone (${rec.root}) — re-run 'npm run eval:setup -- setup ${rec.scenario}'.`);
  }
  return rec;
}

/** Drop the entry with the given root (used after `clean`). */
export async function forgetRun(root: string, stateFile: string = DEFAULT_STATE_FILE): Promise<void> {
  const runs = (await readRuns(stateFile)).filter((r) => r.root !== root);
  await writeRuns(runs, stateFile);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --config vitest.eval.config.ts eval-test/run-state.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add eval/run-state.ts eval-test/run-state.test.ts
git commit -m "feat(eval): add run-state pointer for manual eval runs"
```

---

## Task 2: `SetupResult` fields + `buildEnterInvocation`

**Files:**
- Modify: `eval/okh-eval.ts`
- Test: `eval-test/okh-eval.test.ts`

- [ ] **Step 1: Write the failing test**

Add these imports/tests to `eval-test/okh-eval.test.ts`. Extend the existing import from `../eval/okh-eval.js` to include `buildEnterInvocation`, and add an import for the `RunRecord` type:

```ts
import { listScenarios, loadScenario, setupScenario, runChecks, clean, buildEnterInvocation } from "../eval/okh-eval.js";
import { type RunRecord } from "../eval/run-state.js";
```

Add these tests inside the `describe("okh-eval manual CLI", ...)` block:

```ts
it("setup returns the scenario name and backend for state tracking", async () => {
  const res = await setupScenario("ask-grounded", { model: "test-model" });
  roots.push(res.root);
  expect(res.scenario).toBe("ask-grounded");
  expect(res.backend).toBe("local");
});

it("buildEnterInvocation targets the isolated env and workspace", () => {
  const rec: RunRecord = {
    scenario: "ask-grounded",
    root: "/r",
    workspace: "/r/ws",
    copilotHome: "/r/ch",
    backend: "local",
    createdAt: "t",
  };
  const inv = buildEnterInvocation(rec, "test-model");
  expect(inv.command).toBe("copilot");
  expect(inv.args).toEqual(["--allow-all", "--model", "test-model"]);
  expect(inv.cwd).toBe("/r/ws");
  expect(inv.env.COPILOT_HOME).toBe("/r/ch");
});

it("buildEnterInvocation omits --model when not given", () => {
  const rec: RunRecord = {
    scenario: "s",
    root: "/r",
    workspace: "/r/ws",
    copilotHome: "/r/ch",
    backend: "local",
    createdAt: "t",
  };
  expect(buildEnterInvocation(rec).args).toEqual(["--allow-all"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run --config vitest.eval.config.ts eval-test/okh-eval.test.ts`
Expected: FAIL — `buildEnterInvocation` is not exported; `res.scenario`/`res.backend` are typed `undefined`/missing.

- [ ] **Step 3: Write minimal implementation**

In `eval/okh-eval.ts`, add an import for the run-state type near the other imports (after the `loadRegistry` import on line 6):

```ts
import type { RunRecord } from "./run-state.js";
```

Extend the `SetupResult` interface (currently lines 36–43) to add two fields:

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
```

Update the `return` at the end of `setupScenario` (currently line 65) to include them (`backend` is already computed above as `const backend = opts.backend ?? scenario.vars.backend;`):

```ts
  return {
    root: prov.root,
    workspace: prov.workspace,
    copilotHome: prov.copilotHome,
    containerPath: prov.containerPath,
    scenario: name,
    backend,
    command,
    checklist,
  };
```

Add the `EnterInvocation` type and `buildEnterInvocation` function immediately after `setupScenario` (before the `CheckResult` interface):

```ts
export interface EnterInvocation {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
}

/** Build the interactive `copilot --allow-all` invocation for a provisioned run. */
export function buildEnterInvocation(rec: RunRecord, model?: string): EnterInvocation {
  const args = ["--allow-all"];
  if (model) args.push("--model", model);
  return { command: "copilot", args, cwd: rec.workspace, env: { COPILOT_HOME: rec.copilotHome } };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run --config vitest.eval.config.ts eval-test/okh-eval.test.ts`
Expected: PASS (existing tests + 3 new).

- [ ] **Step 5: Commit**

```bash
git add eval/okh-eval.ts eval-test/okh-eval.test.ts
git commit -m "feat(eval): expose scenario/backend and buildEnterInvocation"
```

---

## Task 3: Wire `main` — record on setup, add `enter`, resolve `check`/`clean`

**Files:**
- Modify: `eval/okh-eval.ts`

This task changes CLI glue in `main`. The `enter` spawn is integration-only (not unit-tested); its logic lives in the already-tested `buildEnterInvocation`.

- [ ] **Step 1: Add imports**

At the top of `eval/okh-eval.ts`, add these imports (alongside the existing `node:*` imports):

```ts
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
```

Change the `RunRecord` type-only import added in Task 2 to also bring in the state functions:

```ts
import { recordRun, resolveRun, forgetRun, type RunRecord } from "./run-state.js";
```

(`isAbsolute` is already imported from `node:path` on line 2.)

- [ ] **Step 2: Add helper functions**

Add these helpers near the top-level functions in `eval/okh-eval.ts` (e.g. just after `shellQuote`):

```ts
/** True when an arg is a filesystem path (old explicit form) rather than a scenario name. */
function looksLikePath(arg: string): boolean {
  return isAbsolute(arg) || /[\\/]/.test(arg) || existsSync(arg);
}

/** Launch an interactive Copilot session; resolves with the child exit code. */
function spawnInteractive(inv: EnterInvocation): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(inv.command, inv.args, {
      cwd: inv.cwd,
      env: { ...process.env, ...inv.env },
      stdio: "inherit",
      shell: false,
    });
    child.on("close", (code) => resolve(code ?? 0));
    child.on("error", (err) => {
      console.error(`failed to launch ${inv.command}: ${(err as Error).message}`);
      resolve(1);
    });
  });
}

/** Run + print the objective side-effect checks; returns process exit code. */
async function reportChecks(root: string, name: string): Promise<number> {
  const results = await runChecks(root, name);
  let ok = true;
  for (const r of results) {
    console.log(`${r.pass ? "PASS" : "FAIL"} ${r.name} — ${r.reason}`);
    if (!r.pass) ok = false;
  }
  return ok ? 0 : 1;
}
```

- [ ] **Step 3: Update the `setup` branch of `main`**

Replace the existing `if (cmd === "setup") { ... }` block (currently lines 116–133) with:

```ts
  if (cmd === "setup") {
    const name = rest[0];
    if (!name) throw new Error("usage: okh-eval setup <scenario> [--backend local|git-auto] [--model M]");
    const bi = rest.indexOf("--backend");
    const mi = rest.indexOf("--model");
    const res = await setupScenario(name, {
      backend: bi >= 0 ? (rest[bi + 1] as EvalBackend) : undefined,
      model: mi >= 0 ? rest[mi + 1] : undefined,
    });
    await recordRun({
      scenario: res.scenario,
      root: res.root,
      workspace: res.workspace,
      copilotHome: res.copilotHome,
      backend: res.backend,
      createdAt: new Date().toISOString(),
    });
    console.log(`Root      : ${res.root}`);
    console.log(`Workspace : ${res.workspace}`);
    console.log(`\nEnter an interactive session (no paths needed):\n  npm run eval:setup -- enter`);
    console.log(`\nOr run headless:\n${res.command}`);
    console.log("\nExpected-outcome checklist:");
    for (const c of res.checklist) console.log(`  - ${c}`);
    console.log(`\nAfter running, verify side-effects:\n  npm run eval:setup -- check`);
    console.log(`Clean up:\n  npm run eval:setup -- clean`);
    return 0;
  }
```

- [ ] **Step 4: Add the `enter` branch**

Immediately after the `setup` branch, add:

```ts
  if (cmd === "enter") {
    const mi = rest.indexOf("--model");
    const model = mi >= 0 ? rest[mi + 1] : undefined;
    const scenario = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--model");
    const rec = await resolveRun(scenario);
    const inv = buildEnterInvocation(rec, model);
    console.log(`Entering ${rec.scenario}\n  COPILOT_HOME: ${rec.copilotHome}\n  cwd: ${rec.workspace}\n`);
    return spawnInteractive(inv);
  }
```

- [ ] **Step 5: Update the `check` branch**

Replace the existing `if (cmd === "check") { ... }` block (currently lines 134–146) with:

```ts
  if (cmd === "check") {
    const si = rest.indexOf("--scenario");
    if (si >= 0) {
      // Backward-compatible explicit form: check <root> --scenario <name>
      const root = rest[0];
      const name = rest[si + 1];
      if (!root || !name) throw new Error("usage: okh-eval check <root> --scenario <name>   (or: check [scenario])");
      return await reportChecks(root, name);
    }
    // State-resolved form: check [scenario]  (no scenario => most-recent run)
    const scenario = rest.find((a) => !a.startsWith("--"));
    const rec = await resolveRun(scenario);
    return await reportChecks(rec.root, rec.scenario);
  }
```

- [ ] **Step 6: Update the `clean` branch**

Replace the existing `if (cmd === "clean") { ... }` block (currently lines 147–152) with:

```ts
  if (cmd === "clean") {
    const arg = rest[0];
    const root = arg && looksLikePath(arg)
      ? arg.replace(/[\\/]workspace$/, "")
      : (await resolveRun(arg)).root;
    await clean(root);
    await forgetRun(root);
    console.log("cleaned");
    return 0;
  }
```

- [ ] **Step 7: Update the unknown-command message**

Change the final `throw` in `main` (currently line 153) to include `enter`:

```ts
  throw new Error(`unknown command: ${cmd ?? "(none)"} — use list | setup | enter | check | clean`);
```

- [ ] **Step 8: Typecheck and run the eval suite**

Run: `npm run typecheck:eval`
Expected: exit 0, no errors.

Run: `npm run test:eval`
Expected: PASS — all eval tests, including the unchanged `okh-eval.test.ts` and `provision.test.ts`.

- [ ] **Step 9: Manual smoke of the CLI resolution (local scenario, no premium requests)**

Run (PowerShell):

```powershell
npm run eval:setup -- setup ask-grounded
npm run eval:setup -- check
npm run eval:setup -- clean
```

Expected: `setup` prints `enter`/`check`/`clean` next-steps with no path; `check` prints PASS/FAIL lines for the side-effect assertions resolved from state (no `--scenario` needed); `clean` prints `cleaned`. (`setup`/`check`/`clean` make no Copilot calls.) Do NOT run `enter` here — it launches an interactive premium session.

- [ ] **Step 10: Commit**

```bash
git add eval/okh-eval.ts
git commit -m "feat(eval): resolve manual run paths from state; add enter command"
```

---

## Task 4: Update `MANUAL-TESTING.md`

**Files:**
- Modify: `eval/MANUAL-TESTING.md`

- [ ] **Step 1: Rewrite steps 2–5 to the no-copy-paste flow**

Replace the current sections `## 2.` through `## 5.` (lines 33–118) with the following. Keep sections 0, 1, and 6 (Exploratory) as they are, except update section 6 Option A's interactive block to use `enter` (Step 2 below).

```markdown
## 2. Provision an isolated workspace for one case

```powershell
npm run eval:setup -- setup ask-grounded
```

This copies the scenario's fixture into a throwaway temp **Root** and builds an
isolated `COPILOT_HOME` whose `mcp-config.json` points Copilot at the OKH server
running against an isolated `OKH_HOME`. The run is **recorded**, so the follow-up
commands below need no path. It prints:

- **Root** / **Workspace** paths (informational — you no longer copy them),
- the `enter` / headless-run commands,
- an **expected-outcome checklist**,
- the path-free **check** and **clean** commands.

Nothing is spawned yet; no premium requests are used by `setup`.

---

## 3. Run the case — interactively

Drop straight into an interactive session in the isolated env (no env vars, no
`Set-Location`, no pasted path):

```powershell
npm run eval:setup -- enter
```

`enter` targets the most-recently provisioned run; pass a scenario name to pick a
specific one (`npm run eval:setup -- enter ask-grounded`) or `--model <M>` to
override the model. Inside the session:

- `/mcp` — confirm **open-knowledge-hub** is loaded and list its tools.
- Paste the scenario prompt (from `eval\scenarios\<name>\test.yaml` → `vars.prompt`).
  Example (ask-grounded):
  > Use the open-knowledge-hub MCP tools. In container "kb-hub", answer strictly
  > from its knowledge module: How does auth work?
- Watch it call the OKH tool(s) and produce an answer.

(The headless `copilot -p '…'` command printed by `setup` remains available if you
prefer a one-shot run.)

---

## 4. Inspect the results manually

Judge the **answer quality** yourself against the printed checklist (e.g.
ask-grounded expects: uses `ask`, mentions tokens, cites the Auth concept, invents
nothing).

Then run the objective side-effect checks — no path needed (resolves the most
recent run; pass a scenario name to target a specific one):

```powershell
npm run eval:setup -- check
```

`check` runs only the deterministic assertions (`okf-valid`, `memory-append`,
`git-committed`, `module-unchanged`). Answer grounding/quality is what you eyeball
here (the automated `npm run eval` adds a Copilot-CLI judge for that).

The explicit form still works if you want to point at a specific directory:

```powershell
npm run eval:setup -- check <root> --scenario ask-grounded
```

---

## 5. Clean up

```powershell
npm run eval:setup -- clean
```

`clean` removes the most-recent run's temp directory and drops it from the run
state; pass a scenario name to clean a specific one, or an explicit path
(`npm run eval:setup -- clean <root>`) as before. Repeat steps 2–5 for other
cases. Good ones to watch interactively:

- **`learn-integrates`** — the agent writes OKF knowledge and calls `sync`, which
  commits **and pushes** to a bare git origin (`git-committed` verifies it).
- **`learn-rejects-trivial`** — the okf-learn gate should refuse to store junk
  ("the sky is blue"); `module-unchanged` verifies nothing was written.
```

- [ ] **Step 2: Update section 6 (Exploratory) Option A interactive block**

In `## 6. Exploratory (free-form) testing` → `### Option A`, replace the
`$root = "<Root>"` / `$env:COPILOT_HOME = ...` / `Set-Location ...` / `copilot --allow-all`
block (currently lines 128–133) with:

```powershell
npm run eval:setup -- setup context-assembly    # uses the kb-hub fixture
npm run eval:setup -- enter                      # interactive session, isolated env
```

Leave the rest of Option A (prompt ideas, adversarial notes) and Option B unchanged,
but update the closing "`clean` when done" reference so it reads:

```markdown
After each, inspect `"<Root>\okh-home\containers\kb-hub"` (files + `git`) to see
exactly what happened, then `npm run eval:setup -- clean` when done.
```

- [ ] **Step 3: Commit**

```bash
git add eval/MANUAL-TESTING.md
git commit -m "docs(eval): document path-free manual eval flow (enter/check/clean)"
```

---

## Task 5: Update `README.md` pointer + final verification

**Files:**
- Modify: `eval/README.md`

- [ ] **Step 1: Update the manual-mode wording**

In `eval/README.md`, replace the "Manual & exploratory testing" section body
(currently lines 40–43) with:

```markdown
## Manual & exploratory testing

Run the scenarios by hand in Copilot CLI, inspect results yourself, and do
free-form exploration. Provisioned runs are recorded, so follow-up commands are
path-free: `setup <scenario>` → `enter` → `check` → `clean`. See
**[MANUAL-TESTING.md](./MANUAL-TESTING.md)**.
```

- [ ] **Step 2: Commit the docs change**

```bash
git add eval/README.md
git commit -m "docs(eval): note path-free manual flow in README"
```

- [ ] **Step 3: Full verification — eval suite**

Run: `npm run typecheck:eval`
Expected: exit 0.

Run: `npm run test:eval`
Expected: PASS — all eval tests.

- [ ] **Step 4: Full verification — core suite (must be unaffected)**

Run: `npm run typecheck`
Expected: exit 0.

Run: `npm test`
Expected: PASS — full Vitest suite (88 tests).

- [ ] **Step 5: Confirm no stray artifacts**

Run: `git status --porcelain`
Expected: clean (all changes committed). No `okh-eval-state.json` or temp dirs in the repo (the state file lives in the OS temp dir).

---

## Self-Review Notes (author check — completed)

- **Spec coverage:** run-state file + `recordRun`/`readRuns`/`resolveRun`/`forgetRun` (Task 1); `SetupResult` fields + `buildEnterInvocation` (Task 2); `main` wiring for `setup`/`enter`/`check`/`clean` with backward-compatible explicit forms (Task 3); docs (Tasks 4–5). All spec sections mapped.
- **Placeholder scan:** no TBD/TODO; every code step shows complete code.
- **Type consistency:** `RunRecord` fields are identical across `run-state.ts`, tests, and `okh-eval.ts`; `buildEnterInvocation`/`EnterInvocation`/`spawnInteractive`/`reportChecks`/`looksLikePath` names are used consistently; `resolveRun(scenario?, stateFile?)` and `forgetRun(root, stateFile?)` signatures match call sites.
```
