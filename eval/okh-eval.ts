import { fileURLToPath } from "node:url";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { readdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { provisionEnvironment, environments, isEnvName, type EnvName } from "./environments.js";
import { recordRun, resolveRun, forgetRun, type RunRecord } from "./run-state.js";

const EVAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = resolve(EVAL_ROOT, "..");

/** True when an arg is a filesystem path rather than an environment name. */
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

/** A single scenario, normalized from one complete promptfoo config file. */
export interface ScenarioTest {
  /** Path relative to scenarios/, e.g. "ask/answerable.yaml". */
  file: string;
  description: string;
  env: EnvName;
  prompt: string;
  assert: Array<{ type: string; value?: string; config?: Record<string, unknown> }>;
}

/** Recursively collect every *.yaml under scenarios/, skipping the shared/ folder. */
async function scenarioConfigFiles(): Promise<string[]> {
  const root = join(EVAL_ROOT, "scenarios");
  const out: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    for (const ent of await readdir(dir, { withFileTypes: true })) {
      const relPath = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (ent.name === "shared") continue;
        await walk(join(dir, ent.name), relPath);
      } else if (ent.name.endsWith(".yaml")) {
        out.push(relPath);
      }
    }
  };
  await walk(root, "");
  return out.sort();
}

/** Load every scenario file (a one-element scenario list) and normalize it. */
export async function loadScenarios(): Promise<ScenarioTest[]> {
  const root = join(EVAL_ROOT, "scenarios");
  const out: ScenarioTest[] = [];
  for (const file of await scenarioConfigFiles()) {
    const doc = parseYaml(await readFile(join(root, file), "utf8"));
    const scenarios = Array.isArray(doc) ? doc : [doc];
    for (const sc of scenarios) {
      const vars = sc?.config?.[0]?.vars ?? {};
      const prompt = vars.prompt;
      const test = sc?.tests?.[0];
      const description = test?.description;
      if (typeof description !== "string" || typeof prompt !== "string" || !isEnvName(vars.env)) {
        throw new Error(`scenarios/${file}: expected tests[0].description + config[0].vars.prompt + config[0].vars.env`);
      }
      out.push({
        file,
        description,
        env: vars.env,
        prompt,
        assert: test.assert ?? [],
      });
    }
  }
  return out;
}

/** The environments that have at least one test, in declaration order. */
export function listEnvironments(): EnvName[] {
  return Object.keys(environments) as EnvName[];
}

/** All tests whose `env` matches the given environment. */
export async function scenariosForEnv(env: EnvName): Promise<ScenarioTest[]> {
  return (await loadScenarios()).filter((s) => s.env === env);
}

export interface PromptEntry {
  description: string;
  prompt: string;
  /** Human-readable summary of this test's asserts (what to verify by eye). */
  checklist: string[];
}

export interface SetupResult {
  env: EnvName;
  root: string;
  workspace: string;
  copilotHome: string;
  prompts: PromptEntry[];
}

/** Provision an environment and gather the test prompts (+ checklists) that use it. */
export async function setupEnvironment(env: EnvName): Promise<SetupResult> {
  if (!isEnvName(env)) throw new Error(`unknown environment "${String(env)}" — use one of: ${listEnvironments().join(", ")}`);
  const prov = await provisionEnvironment(env, { repoRoot: REPO_ROOT, label: env });
  const prompts: PromptEntry[] = (await scenariosForEnv(env)).map((s) => ({
    description: s.description,
    prompt: s.prompt.trim(),
    checklist: s.assert.map((a) =>
      `${a.type} ${a.value ? a.value.replace("file://assertions/", "") : ""} ${a.config ? JSON.stringify(a.config) : ""}`.trim(),
    ),
  }));
  return { env, root: prov.root, workspace: prov.workspace, copilotHome: prov.copilotHome, prompts };
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

/**
 * One-shot manual test: provision a throwaway environment, enter an interactive
 * Copilot session wired to the built OKH server, and delete the temp home when
 * the session exits (or errors). Never touches the shared run-state file.
 */
export async function runManualSession(
  env: EnvName,
  opts: {
    model?: string;
    spawn?: (inv: EnterInvocation) => Promise<number>;
    onSetup?: (res: SetupResult) => void;
  } = {},
): Promise<number> {
  if (!isEnvName(env)) throw new Error(`unknown environment "${String(env)}" — use one of: ${listEnvironments().join(", ")}`);
  const res = await setupEnvironment(env);
  const rec: RunRecord = {
    env: res.env,
    root: res.root,
    workspace: res.workspace,
    copilotHome: res.copilotHome,
    createdAt: new Date().toISOString(),
  };
  opts.onSetup?.(res);
  const runSpawn = opts.spawn ?? spawnInteractive;
  const inv = buildEnterInvocation(rec, opts.model);
  try {
    return await runSpawn(inv);
  } finally {
    await clean(res.root);
  }
}

/** Remove the temp run (accepts the temp root or the workspace path). */
export async function clean(workspaceOrRoot: string): Promise<void> {
  const root = workspaceOrRoot.replace(/[\\/]workspace$/, "");
  await rm(root, { recursive: true, force: true });
}

function indent(text: string, pad = "    "): string {
  return text.split("\n").map((l) => pad + l).join("\n");
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  if (cmd === "list") {
    for (const e of listEnvironments()) {
      const n = (await scenariosForEnv(e)).length;
      console.log(`${e}  (${n} prompt${n === 1 ? "" : "s"})`);
    }
    return 0;
  }
  if (cmd === "setup") {
    const env = rest[0];
    if (!isEnvName(env)) throw new Error(`usage: okh-eval setup <env>   — env one of: ${listEnvironments().join(", ")}`);
    const res = await setupEnvironment(env);
    await recordRun({
      env: res.env,
      root: res.root,
      workspace: res.workspace,
      copilotHome: res.copilotHome,
      createdAt: new Date().toISOString(),
    });
    console.log(`Environment : ${res.env}`);
    console.log(`Root        : ${res.root}`);
    console.log(`Workspace   : ${res.workspace}`);
    console.log(`\nEnter an interactive session (no paths needed):\n  npm run eval:setup -- enter`);
    console.log(`Clean up:\n  npm run eval:setup -- clean`);
    console.log(`\nTest prompts for this environment (paste one into the session, then eyeball against its checklist):`);
    res.prompts.forEach((p, i) => {
      console.log(`\n[${i + 1}] ${p.description}`);
      console.log(indent(p.prompt));
      console.log(`  expected:`);
      for (const c of p.checklist) console.log(`    - ${c}`);
    });
    return 0;
  }
  if (cmd === "enter") {
    const mi = rest.indexOf("--model");
    const model = mi >= 0 ? rest[mi + 1] : undefined;
    const env = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--model");
    const rec = await resolveRun(env);
    const inv = buildEnterInvocation(rec, model);
    console.log(`Entering ${rec.env}\n  COPILOT_HOME: ${rec.copilotHome}\n  cwd: ${rec.workspace}\n`);
    return spawnInteractive(inv);
  }
  if (cmd === "manual") {
    const mi = rest.indexOf("--model");
    const model = mi >= 0 ? rest[mi + 1] : undefined;
    const envArg = rest.find((a, i) => !a.startsWith("--") && rest[i - 1] !== "--model");
    const env = envArg ?? "empty";
    if (!isEnvName(env)) throw new Error(`usage: okh-eval manual [env] [--model <m>]   — env one of: ${listEnvironments().join(", ")}`);
    return runManualSession(env, {
      model,
      onSetup: (res) => {
        console.log(`Manual session : ${res.env}`);
        console.log(`Workspace      : ${res.workspace}`);
        console.log(`OKH server     : ${join(REPO_ROOT, "dist", "index.js")}`);
        console.log(`OKH_HOME       : ${join(res.root, "okh-home")}`);
        if (res.prompts.length) {
          console.log(`\nTest prompts for this environment (paste one, eyeball against its checklist):`);
          res.prompts.forEach((p, i) => {
            console.log(`\n[${i + 1}] ${p.description}`);
            console.log(indent(p.prompt));
            console.log(`  expected:`);
            for (const c of p.checklist) console.log(`    - ${c}`);
          });
        }
        console.log(`\nEntering interactive session — exit (Ctrl-D or /exit) to auto-clean the temp home.\n`);
      },
    });
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
  throw new Error(`unknown command: ${cmd ?? "(none)"} — use list | setup | enter | manual | clean`);
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
