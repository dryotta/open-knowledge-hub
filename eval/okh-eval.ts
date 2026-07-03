import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { provision, type EvalBackend } from "./provision.js";
import { loadRegistry, findContainer } from "../src/registry/registry.js";
import { recordRun, resolveRun, forgetRun, type RunRecord } from "./run-state.js";

const EVAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = resolve(EVAL_ROOT, "..");

/** Manual-mode check assertions: only objective filesystem/git side-effects (need no transcript). */
const SIDE_EFFECT_ASSERTIONS = [
  "okf-valid.ts",
  "memory-append.ts",
  "git-committed.ts",
  "module-unchanged.ts",
  "container-registered.ts",
  "manifest-initialized.ts",
  "wake-phrase-set.ts",
];

function shellQuote(value: string): string {
  if (process.platform === "win32") return `'${value.replace(/'/g, "''")}'`;
  return `'${value.replace(/'/g, "'\\''")}'`;
}

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
  scenario: string;
  backend: EvalBackend;
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
  const model = opts.model ?? "claude-sonnet-4.5";
  const prompt = shellQuote(scenario.vars.prompt.trim());
  const command =
    process.platform === "win32"
      ? `Set-Location -LiteralPath ${shellQuote(prov.workspace)}; $env:COPILOT_HOME=${shellQuote(prov.copilotHome)}; copilot -p ${prompt} --allow-all --model ${model}`
      : `COPILOT_HOME=${shellQuote(prov.copilotHome)} copilot -p ${prompt} --allow-all --model ${model}   # run from cwd: ${prov.workspace}`;
  const checklist = scenario.assert.map((a) =>
    a.type === "llm-rubric"
      ? `rubric: ${String(a.value).trim().split("\n")[0]} …`
      : `${a.type} ${a.value ? a.value.replace("file://assertions/", "") : ""} ${a.config ? JSON.stringify(a.config) : ""}`.trim(),
  );
  return { root: prov.root, workspace: prov.workspace, copilotHome: prov.copilotHome, containerPath: prov.containerPath, scenario: name, backend, command, checklist };
}

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

export interface CheckResult {
  name: string;
  pass: boolean;
  reason: string;
}

/** Re-run objective side-effect assertions against a workspace you drove by hand. */
export async function runChecks(root: string, name: string): Promise<CheckResult[]> {
  const scenario = await loadScenario(name);
  const okhHome = join(root, "okh-home");
  const reg = await loadRegistry({
    home: okhHome,
    containersDir: join(okhHome, "containers"),
    registryFile: join(okhHome, "registry.json"),
    preferencesFile: join(okhHome, "preferences.json"),
  });
  const entry = findContainer(reg, scenario.vars.container);
  const fixtureRaw = scenario.vars.fixture;
  const fixtureDir = isAbsolute(fixtureRaw) ? fixtureRaw : resolve(EVAL_ROOT, fixtureRaw);
  const metadata = {
    workspace: root,
    okhHome,
    containerPath: entry?.localPath ?? "",
    fixtureDir,
    originPath: entry && entry.backend === "git" ? entry.origin : undefined,
    toolCalls: [] as string[],
  };
  const results: CheckResult[] = [];
  for (const a of scenario.assert) {
    if (a.type !== "javascript" || !a.value) continue;
    const rel = a.value.replace("file://", "");
    if (!SIDE_EFFECT_ASSERTIONS.some((s) => rel.endsWith(s))) continue;
    const mod = await import(pathToFileURL(join(EVAL_ROOT, rel)).href);
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

export async function main(argv: string[]): Promise<number> {
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
  if (cmd === "enter") {
    const mi = rest.indexOf("--model");
    const model = mi >= 0 ? rest[mi + 1] : undefined;
    const scenario = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--model");
    const rec = await resolveRun(scenario);
    const inv = buildEnterInvocation(rec, model);
    console.log(`Entering ${rec.scenario}\n  COPILOT_HOME: ${rec.copilotHome}\n  cwd: ${rec.workspace}\n`);
    return spawnInteractive(inv);
  }
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
  throw new Error(`unknown command: ${cmd ?? "(none)"} — use list | setup | enter | check | clean`);
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
