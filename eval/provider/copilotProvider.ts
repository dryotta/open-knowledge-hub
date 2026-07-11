import { provisionEnvironment, isEnvName } from "../environments.js";
import { spawnCopilotTurn, runConversation, type CopilotTurnRunner, type Turn, type ConversationTerminal } from "../copilot.js";
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

/** Normalise `vars.turns` into stateful Turns. Validates id, after, send are non-empty. */
export function normalizeTurns(raw: unknown): Turn[] {
  if (!Array.isArray(raw)) return [];
  const out: Turn[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") {
      throw new Error(`malformed turn entry: expected object, got ${JSON.stringify(t)}`);
    }
    const o = t as Record<string, unknown>;
    if (typeof o.id !== "string" || !o.id) {
      throw new Error(`turn missing non-empty "id": ${JSON.stringify(t)}`);
    }
    if (typeof o.send !== "string" || !o.send) {
      throw new Error(`turn "${o.id}" missing non-empty "send": ${JSON.stringify(t)}`);
    }
    // Validate after: must be non-empty string or non-empty string[]
    if (o.after === undefined || o.after === null) {
      throw new Error(`turn "${o.id}" missing "after": ${JSON.stringify(t)}`);
    }
    let after: string | string[];
    if (typeof o.after === "string") {
      if (!o.after) throw new Error(`turn "${o.id}" has empty "after" string`);
      after = o.after;
    } else if (Array.isArray(o.after)) {
      if (o.after.length === 0) throw new Error(`turn "${o.id}" has empty "after" array`);
      for (const a of o.after) {
        if (typeof a !== "string" || !a) throw new Error(`turn "${o.id}" has invalid "after" array entry: ${JSON.stringify(a)}`);
      }
      after = o.after as string[];
    } else {
      throw new Error(`turn "${o.id}" has invalid "after": ${JSON.stringify(o.after)}`);
    }
    const turn: Turn = { id: o.id, after, send: o.send };
    if (typeof o.when === "string") turn.when = o.when;
    out.push(turn);
  }
  return out;
}

/** Parse and validate a terminal definition from vars. */
export function parseTerminal(raw: unknown): ConversationTerminal {
  if (!raw || typeof raw !== "object") {
    throw new Error(`terminal must be an object, got ${JSON.stringify(raw)}`);
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.after !== "string" || !o.after) {
    throw new Error(`terminal missing non-empty "after": ${JSON.stringify(raw)}`);
  }
  const terminal: ConversationTerminal = { after: o.after };
  if (o.requiredTools !== undefined) {
    if (!Array.isArray(o.requiredTools)) {
      throw new Error(`terminal.requiredTools must be an array: ${JSON.stringify(raw)}`);
    }
    for (const t of o.requiredTools) {
      if (typeof t !== "string") {
        throw new Error(`terminal.requiredTools entries must be strings: ${JSON.stringify(raw)}`);
      }
    }
    terminal.requiredTools = o.requiredTools as string[];
  }
  return terminal;
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
    const turns = normalizeTurns(vars.turns);

    // Require terminal when turns are non-empty
    let terminal: ConversationTerminal | undefined;
    if (turns.length > 0) {
      if (!vars.terminal) {
        throw new Error("vars.terminal is required when vars.turns is non-empty");
      }
      terminal = parseTerminal(vars.terminal);
    } else if (vars.terminal) {
      terminal = parseTerminal(vars.terminal);
    }

    const result = await runConversation(
      {
        initial: prompt,
        responses: turns,
        ...(terminal ? { terminal } : {}),
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

    if (result.failure) {
      throw new Error(result.failure);
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
