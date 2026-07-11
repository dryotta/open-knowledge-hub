import type { ChildProcess, SpawnOptions } from "node:child_process";
import { readdir, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import crossSpawn from "cross-spawn";
import { parse as parseYaml } from "yaml";
import {
  environments,
  isEnvName,
  provisionEnvironment,
  type EnvName,
  type Provisioned,
} from "./environments.js";

const MODULE_PATH = fileURLToPath(import.meta.url);
const EVAL_ROOT = resolve(dirname(MODULE_PATH));
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

type SpawnChild = (
  command: string,
  args?: readonly string[],
  options?: SpawnOptions,
) => ChildProcess;

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
      throw new Error(`unknown environment "${arg}" — use one of: ${Object.keys(environments).join(", ")}`);
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
        if (entry.name !== "shared") {
          await walk(join(dir, entry.name), relative);
        }
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
        throw new Error(`scenarios/${file}: expected tests[0].description + config[0].vars.prompt + config[0].vars.env`);
      }
      result.push({
        file,
        description: test.description,
        env: vars.env,
        prompt: vars.prompt.trim(),
        checklist: (test.assert ?? []).map(
          (assertion: { type: string; value?: string; config?: Record<string, unknown> }) =>
            `${assertion.type} ${assertion.value ? assertion.value.replace("file://assertions/", "") : ""} ${
              assertion.config ? JSON.stringify(assertion.config) : ""
            }`.trim(),
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
  if (model) {
    args.push("--model", model);
  }
  return {
    command: "copilot",
    args,
    cwd: environment.workspace,
    env: { COPILOT_HOME: environment.copilotHome },
  };
}

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

function printBlock(text: string, output: (line: string) => void, prefix = ""): void {
  for (const line of text.split("\n")) {
    output(`${prefix}${line}`);
  }
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
  for (const [index, scenario] of scenarios.entries()) {
    output("");
    output(`[${index + 1}] ${scenario.description}`);
    printBlock(scenario.prompt, output);
    output("  expected:");
    for (const item of scenario.checklist) {
      output(`    - ${item}`);
    }
  }
  output("");
}

function exitCodeForSignal(code: number | null, signal: NodeJS.Signals | null): number {
  return code ?? (signal ? 1 : 0);
}

export function launchCopilot(
  invocation: CopilotInvocation,
  spawnChild: SpawnChild = crossSpawn,
): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawnChild(invocation.command, invocation.args, {
        cwd: invocation.cwd,
        env: { ...process.env, ...invocation.env },
        stdio: "inherit",
        shell: false,
      });
    } catch (error) {
      rejectPromise(error);
      return;
    }

    let settled = false;
    const onSignal = (signal: NodeJS.Signals): void => {
      if (!child.killed) {
        child.kill(signal);
      }
    };
    const onSigint = (): void => onSignal("SIGINT");
    const onSigterm = (): void => onSignal("SIGTERM");
    const removeSignalHandlers = (): void => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    const settle = (callback: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      removeSignalHandlers();
      callback();
    };

    process.on("SIGINT", onSigint);
    process.on("SIGTERM", onSigterm);
    child.once("error", (error) => {
      settle(() => rejectPromise(error));
    });
    child.once("close", (code, signal) => {
      settle(() => resolvePromise(exitCodeForSignal(code, signal)));
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
  let exitCode!: number;
  let sessionFailed = false;
  let sessionError: unknown;
  try {
    const scenarios = await dependencies.scenarios(options.env);
    printSession(environment, options.env, scenarios, dependencies.output);
    exitCode = await dependencies.launch(buildCopilotInvocation(environment, options.model));
  } catch (error) {
    sessionFailed = true;
    sessionError = error;
  }

  try {
    await dependencies.cleanup(environment.root);
    dependencies.output(`Cleaned ${environment.root}`);
  } catch (cleanupError) {
    if (sessionFailed) {
      throw new AggregateError(
        [sessionError, cleanupError],
        "manual session and cleanup both failed",
      );
    }
    throw cleanupError;
  }

  if (sessionFailed) {
    throw sessionError;
  }
  return exitCode;
}

const invokedDirectly = !!process.argv[1] && resolve(process.argv[1]) === MODULE_PATH;

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
