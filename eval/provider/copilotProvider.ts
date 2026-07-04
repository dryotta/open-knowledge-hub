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
