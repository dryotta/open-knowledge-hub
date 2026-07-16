import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { cleanupEvalEnvironments } from "./environments.js";
import { terminateProcessTreeAndWait } from "./copilot.js";
import { MAX_JUDGE_K } from "./judge.js";

/**
 * Runs one eval tier in one promptfoo process with a single `{{prompt}}`
 * pass-through, so promptfoo runs scenarios concurrently with no
 * prompt×test cross-product.
 *
 *   npm run eval          → full release tier, k=3 judges
 *   npm run eval:smoke    → representative local tier, k=1 judges
 *   npm run eval -- ARGS  → forwards filters, repeats, and promptfoo concurrency
 *   npm run eval:validate → validates both tier configs
 *
 * Invoked through `node --import tsx` so the TypeScript provider/assertions
 * load with NodeNext `.js` import specifiers.
 */
const EVAL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)));
const REPO_ROOT = resolve(EVAL_ROOT, "..");
const CONFIGS = {
  full: join(EVAL_ROOT, "promptfooconfig.yaml"),
  smoke: join(EVAL_ROOT, "promptfooconfig.smoke.yaml"),
} as const;
// Resolve through Node.js module resolution so the path works whether promptfoo
// lives in a local node_modules/ or in a parent directory (e.g. git worktrees).
// _require.resolve("promptfoo") returns the CJS entry (dist/src/index.cjs);
// entrypoint.js lives in the same directory.
const _require = createRequire(import.meta.url);
const PROMPTFOO = join(dirname(_require.resolve("promptfoo")), "entrypoint.js");
const SIGNAL_GRACE_MS = 5_000;
const DEFAULT_SCENARIO_CONCURRENCY = 2;
const MAX_SCENARIO_CONCURRENCY = 8;

export type EvalMode = "eval" | "validate";
export type EvalTier = keyof typeof CONFIGS;

export interface HarnessArgs {
  tier: EvalTier;
  tierExplicit: boolean;
  judgeK?: number;
  promptfooArgs: string[];
}

export function parseEvalMode(value: string | undefined): EvalMode {
  if (value === "eval" || value === "validate") return value;
  throw new Error(`expected eval mode "eval" or "validate", got ${JSON.stringify(value)}`);
}

function parseTier(value: string | undefined): EvalTier {
  if (value === "full" || value === "smoke") return value;
  throw new Error(`expected eval tier "full" or "smoke", got ${JSON.stringify(value)}`);
}

function parseJudgeK(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_JUDGE_K) {
    throw new Error(`--judge-k must be an integer from 1 to ${MAX_JUDGE_K}, got ${JSON.stringify(value)}`);
  }
  return parsed;
}

export function parseHarnessArgs(args: string[]): HarnessArgs {
  let tier: EvalTier = "full";
  let tierExplicit = false;
  let judgeK: number | undefined;
  const promptfooArgs: string[] = [];

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--tier") {
      tier = parseTier(args[++index]);
      tierExplicit = true;
    } else if (arg.startsWith("--tier=")) {
      tier = parseTier(arg.slice("--tier=".length));
      tierExplicit = true;
    } else if (arg === "--judge-k") {
      judgeK = parseJudgeK(args[++index]);
    } else if (arg.startsWith("--judge-k=")) {
      judgeK = parseJudgeK(arg.slice("--judge-k=".length));
    } else {
      promptfooArgs.push(arg);
    }
  }

  return {
    tier,
    tierExplicit,
    ...(judgeK === undefined ? {} : { judgeK }),
    promptfooArgs,
  };
}

export function resolveScenarioConcurrency(base: NodeJS.ProcessEnv = process.env): number {
  const value = base.OKH_EVAL_CONCURRENCY;
  if (value === undefined || value === "") return DEFAULT_SCENARIO_CONCURRENCY;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SCENARIO_CONCURRENCY) {
    throw new Error(
      `OKH_EVAL_CONCURRENCY must be an integer from 1 to ${MAX_SCENARIO_CONCURRENCY}, got ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

export function buildPromptfooArgs(
  mode: EvalMode,
  extraArgs: string[] = [],
  options: { tier?: EvalTier; env?: NodeJS.ProcessEnv } = {},
): string[] {
  const tier = options.tier ?? "full";
  const args = ["--import", "tsx", PROMPTFOO, mode, "-c", CONFIGS[tier]];
  if (mode === "eval") {
    args.push("--no-cache");
    const hasConcurrencyOverride = extraArgs.some(
      (arg) => arg === "--max-concurrency" || arg.startsWith("--max-concurrency="),
    );
    if (!hasConcurrencyOverride) {
      args.push("--max-concurrency", String(resolveScenarioConcurrency(options.env)));
    }
  }
  args.push(...extraArgs);
  return args;
}

export function buildPromptfooEnv(
  runId: string,
  base: NodeJS.ProcessEnv = process.env,
  options: { tier?: EvalTier; judgeK?: number } = {},
): NodeJS.ProcessEnv {
  return {
    ...base,
    OKH_EVAL_RUN_ID: runId,
    OKH_EVAL_TIER: options.tier ?? "full",
    ...(options.judgeK === undefined ? {} : { OKH_JUDGE_K: String(options.judgeK) }),
    OKH_EVAL_TIMINGS: base.OKH_EVAL_TIMINGS ?? "1",
    PROMPTFOO_DISABLE_UPDATE: base.PROMPTFOO_DISABLE_UPDATE ?? "true",
  };
}

function optionValue(args: string[], name: string): string | undefined {
  const equals = args.find((arg) => arg.startsWith(`${name}=`));
  if (equals) return equals.slice(name.length + 1);
  const index = args.lastIndexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function formatDuration(ms: number): string {
  return `${Math.round(ms)}ms`;
}

export function resolvedExitCode(
  code: number | null,
  childSignal: NodeJS.Signals | null,
  requestedSignal?: NodeJS.Signals,
): number {
  const signal = requestedSignal ?? childSignal;
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  if (code !== null) return code;
  return 1;
}

interface SignalSource {
  on(signal: NodeJS.Signals, listener: () => void): void;
  off(signal: NodeJS.Signals, listener: () => void): void;
}

interface LaunchPromptfooDeps {
  spawnProcess?: (
    command: string,
    args: string[],
    options: {
      stdio: "inherit";
      cwd: string;
      env: NodeJS.ProcessEnv;
      detached: boolean;
    },
  ) => ChildProcess;
  signalSource?: SignalSource;
  platform?: NodeJS.Platform;
  terminationGraceMs?: number;
  terminate?: (child: ChildProcess) => Promise<void>;
}

export function launchPromptfoo(
  args: string[],
  env: NodeJS.ProcessEnv,
  deps: LaunchPromptfooDeps = {},
): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const spawnProcess = deps.spawnProcess ?? spawn;
    const signalSource = deps.signalSource ?? {
      on: (signal, listener) => {
        process.on(signal, listener);
      },
      off: (signal, listener) => {
        process.off(signal, listener);
      },
    };
    const platform = deps.platform ?? process.platform;
    const terminationGraceMs = deps.terminationGraceMs ?? SIGNAL_GRACE_MS;
    const terminate = deps.terminate ?? terminateProcessTreeAndWait;
    let child: ChildProcess;
    try {
      child = spawnProcess(process.execPath, args, {
        stdio: "inherit",
        cwd: REPO_ROOT,
        env,
        detached: platform !== "win32",
      });
    } catch (error) {
      rejectPromise(error);
      return;
    }

    let settled = false;
    let requestedSignal: NodeJS.Signals | undefined;
    let signalCount = 0;
    let termination: Promise<void> | undefined;
    let escalationTimer: NodeJS.Timeout | undefined;
    const forceTerminate = (): void => {
      if (termination) return;
      termination = terminate(child);
      void termination.then(
        () => settle(() => resolvePromise(
          resolvedExitCode(child.exitCode, child.signalCode, requestedSignal),
        )),
        (error) => settle(() => rejectPromise(error)),
      );
    };
    const forwardSignal = (signal: NodeJS.Signals): void => {
      requestedSignal ??= signal;
      signalCount++;

      if (platform === "win32" || signalCount > 1) {
        forceTerminate();
        return;
      }
      if (
        (child.exitCode === null && child.signalCode === null && !child.kill(signal))
        || child.exitCode !== null
        || child.signalCode !== null
      ) {
        forceTerminate();
        return;
      }
      escalationTimer = setTimeout(forceTerminate, terminationGraceMs);
    };
    const onSigint = (): void => forwardSignal("SIGINT");
    const onSigterm = (): void => forwardSignal("SIGTERM");
    const removeSignalHandlers = (): void => {
      signalSource.off("SIGINT", onSigint);
      signalSource.off("SIGTERM", onSigterm);
      if (escalationTimer) clearTimeout(escalationTimer);
    };
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      removeSignalHandlers();
      callback();
    };

    signalSource.on("SIGINT", onSigint);
    signalSource.on("SIGTERM", onSigterm);
    child.once("error", (error) => settle(() => rejectPromise(error)));
    child.once("close", (code, signal) => {
      void (async () => {
        await termination;
        settle(() => resolvePromise(resolvedExitCode(code, signal, requestedSignal)));
      })();
    });
  });
}

export async function runPromptfoo(mode: EvalMode, extraArgs: string[] = []): Promise<number> {
  const harness = parseHarnessArgs(extraArgs);
  const tiers: EvalTier[] = mode === "validate" && !harness.tierExplicit
    ? ["full", "smoke"]
    : [harness.tier];
  const runId = randomUUID();
  const runStarted = performance.now();
  let promptfooMs = 0;
  let runError: unknown;
  let code = 0;
  try {
    for (const tier of tiers) {
      const args = buildPromptfooArgs(mode, harness.promptfooArgs, { tier });
      const env = buildPromptfooEnv(runId, process.env, {
        tier,
        ...(harness.judgeK === undefined ? {} : { judgeK: harness.judgeK }),
      });
      if (mode === "eval") {
        const concurrency = optionValue(args, "--max-concurrency") ?? String(DEFAULT_SCENARIO_CONCURRENCY);
        const judgeK = env.OKH_JUDGE_K ?? "3";
        console.log(`[eval config] tier=${tier} scenarioConcurrency=${concurrency} judgeK=${judgeK}`);
      }
      const promptfooStarted = performance.now();
      code = await launchPromptfoo(args, env);
      promptfooMs += performance.now() - promptfooStarted;
      if (code !== 0) break;
    }
  } catch (error) {
    runError = error;
  }

  let cleanupError: unknown;
  let cleanupMs = 0;
  if (mode === "eval" && process.env.OKH_EVAL_KEEP_WORKSPACES !== "1") {
    const cleanupStarted = performance.now();
    try {
      await cleanupEvalEnvironments(runId);
    } catch (error) {
      cleanupError = error;
    } finally {
      cleanupMs = performance.now() - cleanupStarted;
    }
  }
  if (mode === "eval" && process.env.OKH_EVAL_TIMINGS !== "0") {
    console.log(
      `[eval timing] promptfoo=${formatDuration(promptfooMs)} cleanup=${formatDuration(cleanupMs)} total=${formatDuration(performance.now() - runStarted)}`,
    );
  }

  if (runError && cleanupError) {
    throw new AggregateError([runError, cleanupError], "promptfoo eval and workspace cleanup both failed");
  }
  if (runError) throw runError;
  if (cleanupError) throw cleanupError;
  return code;
}

const MODULE_PATH = fileURLToPath(import.meta.url);
const invokedDirectly = !!process.argv[1] && resolve(process.argv[1]) === MODULE_PATH;

if (invokedDirectly) {
  let mode: EvalMode | undefined;
  try {
    mode = parseEvalMode(process.argv[2]);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }

  if (mode) {
    runPromptfoo(mode, process.argv.slice(3))
      .then((code) => {
        process.exitCode = code;
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  }
}
