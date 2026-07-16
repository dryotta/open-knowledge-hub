import { evalEnvironmentLabel, provisionEnvironment, isEnvName } from "../environments.js";
import { spawnCopilotTurn, runConversation, type CopilotTurnRunner, type Turn, type ConversationTerminal } from "../copilot.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { rm } from "node:fs/promises";
import { performance } from "node:perf_hooks";

const EVAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(EVAL_ROOT, "..");

interface ProviderOptions {
  id?: string;
  config?: {
    model?: string;
    timeoutMs?: number;
    maxTurns?: number;
    /** Retry a fresh environment after a transient non-zero Copilot process exit. */
    maxAttempts?: number;
    runner?: CopilotTurnRunner;
    provisioner?: typeof provisionEnvironment;
  };
}

interface CallContext {
  vars?: Record<string, unknown>;
  test?: { description?: string };
}

interface CallApiOptions {
  abortSignal?: AbortSignal;
}

interface AttemptTimings {
  attempt: number;
  provisionMs: number;
  agentMs: number;
  toolMs: number;
  retryCleanupMs: number;
  totalMs: number;
}

interface ProviderTimings {
  provisionMs: number;
  agentMs: number;
  toolMs: number;
  retryCleanupMs: number;
  totalMs: number;
  attempts: AttemptTimings[];
}

function rounded(ms: number): number {
  return Math.round(ms);
}

function formatTiming(timings: ProviderTimings): string {
  return [
    `provision=${timings.provisionMs}ms`,
    `agent=${timings.agentMs}ms`,
    `tools=${timings.toolMs}ms`,
    `retryCleanup=${timings.retryCleanupMs}ms`,
    `provider=${timings.totalMs}ms`,
  ].join(" ");
}

function resolveMaxAttempts(value: number | undefined): number {
  if (value === undefined || !Number.isInteger(value) || value < 1) return 1;
  return Math.min(value, 3);
}

async function removeFailedEnvironment(root: string, failure: unknown, message: string): Promise<void> {
  try {
    await rm(root, { recursive: true, force: true });
  } catch (cleanupError) {
    throw new AggregateError([failure, cleanupError], message);
  }
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
  if (o.finalTool !== undefined) {
    if (typeof o.finalTool !== "string" || !o.finalTool) {
      throw new Error(`terminal.finalTool must be a non-empty string: ${JSON.stringify(raw)}`);
    }
    terminal.finalTool = o.finalTool;
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

  async callApi(prompt: string, context: CallContext = {}, options: CallApiOptions = {}) {
    const providerStarted = performance.now();
    const vars = context.vars ?? {};
    const env = vars.env;
    if (!isEnvName(env)) {
      throw new Error(`scenario is missing a valid \`env\` var (got ${JSON.stringify(env)})`);
    }
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

    const provisioner = this.config.provisioner ?? provisionEnvironment;
    const maxAttempts = resolveMaxAttempts(this.config.maxAttempts);
    const retryErrors: string[] = [];
    let totalCost = 0;
    let costIncomplete = false;
    const attemptTimings: AttemptTimings[] = [];

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const attemptStarted = performance.now();
      const provisionStarted = performance.now();
      const prov = await provisioner(env, { repoRoot: REPO_ROOT, label: evalEnvironmentLabel(env) });
      const provisionMs = performance.now() - provisionStarted;
      let result: Awaited<ReturnType<typeof runConversation>>;
      const agentStarted = performance.now();
      try {
        result = await runConversation(
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
            abortSignal: options.abortSignal,
          },
        );
      } catch (runError) {
        await removeFailedEnvironment(
          prov.root,
          runError,
          "Copilot run and environment cleanup both failed",
        );
        throw runError;
      }
      const agentPhaseMs = performance.now() - agentStarted;
      const toolMs = Math.min(agentPhaseMs, result.timings.toolMs);
      const agentMs = Math.max(0, agentPhaseMs - toolMs);

      totalCost += result.cost;
      let error: string | undefined;
      if (result.processFailure) {
        error = `Copilot turn failed: ${result.processFailure}`;
      } else if (result.code !== 0) {
        const code = result.code === null ? "missing" : String(result.code);
        error = `Copilot turn failed with exit code ${code}`;
      } else if (result.failure) {
        error = result.failure;
      }

      const retryableProcessFailure =
        result.processFailureKind === "timeout" || result.processFailureKind === "spawn";
      if (
        retryableProcessFailure
        && !result.failure
        && attempt < maxAttempts
        && !options.abortSignal?.aborted
      ) {
        retryErrors.push(error!);
        costIncomplete = true;
        const cleanupStarted = performance.now();
        await removeFailedEnvironment(
          prov.root,
          new Error(error),
          "Copilot retry and failed-attempt cleanup both failed",
        );
        const retryCleanupMs = performance.now() - cleanupStarted;
        attemptTimings.push({
          attempt,
          provisionMs: rounded(provisionMs),
          agentMs: rounded(agentMs),
          toolMs: rounded(toolMs),
          retryCleanupMs: rounded(retryCleanupMs),
          totalMs: rounded(performance.now() - attemptStarted),
        });
        continue;
      }

      attemptTimings.push({
        attempt,
        provisionMs: rounded(provisionMs),
        agentMs: rounded(agentMs),
        toolMs: rounded(toolMs),
        retryCleanupMs: 0,
        totalMs: rounded(performance.now() - attemptStarted),
      });
      const timings: ProviderTimings = {
        provisionMs: attemptTimings.reduce((sum, timing) => sum + timing.provisionMs, 0),
        agentMs: attemptTimings.reduce((sum, timing) => sum + timing.agentMs, 0),
        toolMs: attemptTimings.reduce((sum, timing) => sum + timing.toolMs, 0),
        retryCleanupMs: attemptTimings.reduce((sum, timing) => sum + timing.retryCleanupMs, 0),
        totalMs: rounded(performance.now() - providerStarted),
        attempts: attemptTimings,
      };
      const scenario = context.test?.description ?? "unnamed scenario";
      if (process.env.OKH_EVAL_TIMINGS !== undefined && process.env.OKH_EVAL_TIMINGS !== "0") {
        console.log(`[eval timing] ${scenario}: ${formatTiming(timings)}`);
      }
      return {
        output: result.transcript,
        ...(error ? { error } : {}),
        metadata: {
          scenario,
          root: prov.root,
          workspace: prov.workspace,
          okhHome: prov.okhHome,
          containerPath: prov.containerPath,
          fixtureDir: prov.fixtureDir,
          originPath: prov.originPath,
          toolCalls: result.toolCalls,
          toolEvents: result.toolEvents,
          turns: result.turns,
          finalMessage: result.finalMessage,
          cost: totalCost,
          costIncomplete,
          attempts: attempt,
          retryErrors,
          timings,
          exitCode: result.code,
          processFailure: result.processFailure,
          processFailureKind: result.processFailureKind,
        },
      };
    }

    throw new Error("Provider exhausted attempts without a result");
  }
}
