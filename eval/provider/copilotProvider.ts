import { provisionEnvironment, isEnvName } from "../environments.js";
import { spawnCopilotTurn, runConversation, type CopilotTurnRunner, type Turn } from "../copilot.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const EVAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(EVAL_ROOT, "..");

interface ProviderOptions {
  id?: string;
  config?: { model?: string; timeoutMs?: number; maxTurns?: number; runner?: CopilotTurnRunner };
}

interface CallContext {
  vars?: Record<string, unknown>;
  test?: { description?: string };
}

/** Normalise `vars.turns` (strings or `{ send, when? }`) into guarded Turns. */
function normalizeTurns(raw: unknown): Turn[] {
  if (!Array.isArray(raw)) return [];
  const out: Turn[] = [];
  for (const t of raw) {
    if (typeof t === "string") {
      out.push({ send: t });
    } else if (t && typeof t === "object" && typeof (t as { send?: unknown }).send === "string") {
      const o = t as { send: string; when?: unknown };
      out.push(typeof o.when === "string" ? { send: o.send, when: o.when } : { send: o.send });
    }
  }
  return out;
}

/**
 * promptfoo custom provider: provision a named environment, drive a (possibly
 * multi-turn) Copilot CLI conversation, and return the aggregated transcript +
 * metadata. With no `vars.turns` it runs exactly one turn (single-turn scenarios).
 */
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
    const prov = await provisionEnvironment(env, { repoRoot: REPO_ROOT, label: env });

    const runner: CopilotTurnRunner = this.config.runner ?? spawnCopilotTurn;
    const result = await runConversation(
      {
        initial: prompt,
        responses: normalizeTurns(vars.turns),
        ...(this.config.maxTurns ? { maxTurns: this.config.maxTurns } : {}),
      },
      {
        runner,
        model: this.config.model,
        copilotHome: prov.copilotHome,
        cwd: prov.workspace,
        timeoutMs: this.config.timeoutMs ?? 300_000,
      },
    );

    if (result.code !== 0) {
      const code = result.code === null ? "missing" : String(result.code);
      throw new Error(`Copilot turn failed with exit code ${code}`);
    }

    return {
      output: result.transcript,
      metadata: {
        workspace: prov.root,
        okhHome: prov.okhHome,
        containerPath: prov.containerPath,
        fixtureDir: prov.fixtureDir,
        originPath: prov.originPath,
        toolCalls: result.toolCalls,
        toolEvents: result.toolEvents,
        turns: result.turns,
        cost: result.cost,
        exitCode: result.code,
      },
    };
  }
}
