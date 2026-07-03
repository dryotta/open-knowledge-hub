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
    const mode = vars.provision === "empty" || vars.provision === "unregistered-local" ? vars.provision : undefined;
    const fixture2Raw = vars.fixture2 ? String(vars.fixture2) : undefined;
    const fixture2Dir = fixture2Raw
      ? (isAbsolute(fixture2Raw) ? fixture2Raw : resolve(EVAL_ROOT, fixture2Raw))
      : undefined;

    const prov = await provision({
      scenario: String(vars.scenario ?? "scenario"),
      backend,
      container: String(vars.container ?? "hub"),
      fixtureDir,
      repoRoot: REPO_ROOT,
      ...(mode ? { mode } : {}),
      ...(vars.container2 && fixture2Dir
        ? { additional: [{ name: String(vars.container2), fixtureDir: fixture2Dir }] }
        : {}),
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
        fixtureDir,
        originPath: prov.originPath,
        toolCalls: extractToolCalls(res.transcript),
        exitCode: res.code,
      },
    };
  }
}
