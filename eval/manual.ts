import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { environments, isEnvName, type EnvName, type Provisioned } from "./environments.js";

const EVAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));

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
